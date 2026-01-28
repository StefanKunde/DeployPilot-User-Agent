import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiClientService, AgentStatus, ResourceInfo, RunningPod } from '../api-client';
import * as os from 'os';

@Injectable()
export class HeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatService.name);
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private runningCommandsCount = 0;
  private lastError: string | null = null;

  constructor(
    private readonly apiClient: ApiClientService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.configService.get<number>('heartbeatIntervalMs', 30000);
    this.logger.log(`Starting heartbeat service with interval: ${intervalMs}ms`);

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat().catch((error) => {
        this.logger.error(`Heartbeat failed: ${error.message}`);
      });
    }, intervalMs);

    // Send initial heartbeat
    this.sendHeartbeat().catch((error) => {
      this.logger.error(`Initial heartbeat failed: ${error.message}`);
    });
  }

  onModuleDestroy(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.logger.log('Heartbeat service stopped');
    }
  }

  setRunningCommandsCount(count: number): void {
    this.runningCommandsCount = count;
  }

  setLastError(error: string | null): void {
    this.lastError = error;
  }

  private async sendHeartbeat(): Promise<void> {
    const status = this.determineStatus();
    const resources = this.getSystemResources();
    const runningPods = this.getRunningPods();

    try {
      await this.apiClient.sendHeartbeat({
        status,
        resources,
        runningPods,
        errorMessage: this.lastError ?? undefined,
      });
      this.logger.debug(`Heartbeat sent: status=${status}, runningPods=${runningPods.length}`);
    } catch (error) {
      // Don't throw - heartbeat should not block other operations
      this.logger.warn('Failed to send heartbeat, will retry on next interval');
    }
  }

  private determineStatus(): AgentStatus {
    if (this.lastError) {
      return 'error';
    }

    const maxConcurrent = this.configService.get<number>('maxConcurrentCommands', 3);
    if (this.runningCommandsCount >= maxConcurrent) {
      return 'busy';
    }

    return 'online';
  }

  private getSystemResources(): ResourceInfo {
    return {
      cpuCores: os.cpus().length,
      ramMb: Math.floor(os.totalmem() / (1024 * 1024)),
      diskGb: 0,
    };
  }

  private getRunningPods(): RunningPod[] {
    // TODO: Implement actual pod discovery if needed
    return [];
  }
}
