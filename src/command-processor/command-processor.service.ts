import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiClientService, Command, CommandType } from '../api-client';
import { HeartbeatService } from '../heartbeat';
import {
  DeployHandler,
  StopHandler,
  RestartHandler,
  DeleteHandler,
  CreateNamespaceHandler,
  UpdateEnvHandler,
  AddCustomDomainHandler,
  RemoveCustomDomainHandler,
  CreateDatabaseHandler,
  DeleteDatabaseHandler,
  UpdateDatabasePasswordHandler,
  EnableDatabaseExternalAccessHandler,
  DisableDatabaseExternalAccessHandler,
  HandlerResult,
} from './handlers';

@Injectable()
export class CommandProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommandProcessorService.name);
  private pollInterval: NodeJS.Timeout | null = null;
  private runningCommands = new Map<string, Promise<void>>();
  private isShuttingDown = false;

  constructor(
    private readonly apiClient: ApiClientService,
    private readonly heartbeatService: HeartbeatService,
    private readonly configService: ConfigService,
    private readonly deployHandler: DeployHandler,
    private readonly stopHandler: StopHandler,
    private readonly restartHandler: RestartHandler,
    private readonly deleteHandler: DeleteHandler,
    private readonly createNamespaceHandler: CreateNamespaceHandler,
    private readonly updateEnvHandler: UpdateEnvHandler,
    private readonly addCustomDomainHandler: AddCustomDomainHandler,
    private readonly removeCustomDomainHandler: RemoveCustomDomainHandler,
    private readonly createDatabaseHandler: CreateDatabaseHandler,
    private readonly deleteDatabaseHandler: DeleteDatabaseHandler,
    private readonly updateDatabasePasswordHandler: UpdateDatabasePasswordHandler,
    private readonly enableDatabaseExternalAccessHandler: EnableDatabaseExternalAccessHandler,
    private readonly disableDatabaseExternalAccessHandler: DisableDatabaseExternalAccessHandler,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.configService.get<number>('pollIntervalMs', 10000);
    this.logger.log(`Starting command processor with poll interval: ${intervalMs}ms`);

    this.pollInterval = setInterval(() => {
      this.pollCommands().catch((error) => {
        this.logger.error(`Command polling failed: ${error.message}`);
      });
    }, intervalMs);

    // Initial poll
    this.pollCommands().catch((error) => {
      this.logger.error(`Initial command poll failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Wait for running commands to complete
    if (this.runningCommands.size > 0) {
      this.logger.log(`Waiting for ${this.runningCommands.size} running commands to complete...`);
      await Promise.allSettled(this.runningCommands.values());
      this.logger.log('All commands completed');
    }
  }

  private async pollCommands(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    try {
      const commands = await this.apiClient.getCommands();

      if (commands.length > 0) {
        this.logger.debug(`Received ${commands.length} commands`);
      }

      for (const command of commands) {
        if (command.status === 'pending' && !this.runningCommands.has(command.id)) {
          const maxConcurrent = this.configService.get<number>('maxConcurrentCommands', 3);

          if (this.runningCommands.size >= maxConcurrent) {
            this.logger.debug(
              `Max concurrent commands (${maxConcurrent}) reached, skipping command ${command.id}`,
            );
            break;
          }

          this.processCommand(command);
        }
      }
    } catch (error) {
      // Don't throw - polling should continue even if one poll fails
      this.logger.warn('Failed to poll commands, will retry on next interval');
    }
  }

  private processCommand(command: Command): void {
    const promise = this.executeCommand(command);
    this.runningCommands.set(command.id, promise);

    // Update heartbeat with running count
    this.heartbeatService.setRunningCommandsCount(this.runningCommands.size);

    promise
      .finally(() => {
        this.runningCommands.delete(command.id);
        this.heartbeatService.setRunningCommandsCount(this.runningCommands.size);
      })
      .catch((error) => {
        this.logger.error(`Unhandled error in command ${command.id}: ${error.message}`);
      });
  }

  private async executeCommand(command: Command): Promise<void> {
    this.logger.log(`Processing command ${command.id} (${command.type})`);

    try {
      // Acknowledge command
      await this.apiClient.ackCommand(command.id);

      // Mark as running
      await this.apiClient.markCommandRunning(command.id);

      // Execute the appropriate handler
      const result = await this.getHandler(command.type).handle(command);

      // Send result
      await this.apiClient.sendCommandResult(command.id, {
        success: result.success,
        error: result.error,
        logs: result.logs,
      });

      this.logger.log(
        `Command ${command.id} completed: ${result.success ? 'success' : 'failed'}`,
      );
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Command ${command.id} failed: ${errorMessage}`);

      try {
        await this.apiClient.sendCommandResult(command.id, {
          success: false,
          error: errorMessage,
        });
      } catch (reportError) {
        this.logger.error(`Failed to report command failure: ${reportError}`);
      }
    }
  }

  private getHandler(type: CommandType): { handle(command: Command): Promise<HandlerResult> } {
    switch (type) {
      case 'DEPLOY':
        return this.deployHandler;
      case 'STOP':
        return this.stopHandler;
      case 'RESTART':
        return this.restartHandler;
      case 'DELETE':
        return this.deleteHandler;
      case 'CREATE_NAMESPACE':
        return this.createNamespaceHandler;
      case 'UPDATE_ENV':
        return this.updateEnvHandler;
      case 'ADD_CUSTOM_DOMAIN':
        return this.addCustomDomainHandler;
      case 'REMOVE_CUSTOM_DOMAIN':
        return this.removeCustomDomainHandler;
      case 'CREATE_DATABASE':
        return this.createDatabaseHandler;
      case 'DELETE_DATABASE':
        return this.deleteDatabaseHandler;
      case 'UPDATE_DATABASE_PASSWORD':
        return this.updateDatabasePasswordHandler;
      case 'ENABLE_DATABASE_EXTERNAL_ACCESS':
        return this.enableDatabaseExternalAccessHandler;
      case 'DISABLE_DATABASE_EXTERNAL_ACCESS':
        return this.disableDatabaseExternalAccessHandler;
      default:
        throw new Error(`Unknown command type: ${type}`);
    }
  }
}
