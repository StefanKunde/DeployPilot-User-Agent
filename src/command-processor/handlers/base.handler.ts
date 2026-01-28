import { Logger } from '@nestjs/common';
import { Command, CommandPayload } from '../../api-client/types';
import { KubernetesService, CommandResult } from '../../kubernetes';

export interface HandlerResult {
  success: boolean;
  error?: string;
  logs?: string;
}

export abstract class BaseHandler<T extends CommandPayload = CommandPayload> {
  protected abstract readonly logger: Logger;

  constructor(protected readonly kubernetesService: KubernetesService) {}

  abstract handle(command: Command): Promise<HandlerResult>;

  protected getPayload(command: Command): T {
    return command.payload as T;
  }

  protected formatResult(result: CommandResult): HandlerResult {
    const logs = [result.stdout, result.stderr].filter(Boolean).join('\n');

    return {
      success: result.success,
      error: result.error,
      logs: logs || undefined,
    };
  }
}
