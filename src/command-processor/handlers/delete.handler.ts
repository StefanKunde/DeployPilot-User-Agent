import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, DeletePayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

@Injectable()
export class DeleteHandler extends BaseHandler<DeletePayload> {
  protected readonly logger = new Logger(DeleteHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);

    this.logger.log(`Deleting ${payload.appName} from namespace ${payload.namespace}`);

    // Try using the helper script first
    let result = await this.kubernetesService.deleteApp(payload.namespace, payload.appName);

    // If helper script fails, fall back to kubectl
    if (!result.success) {
      this.logger.warn('Helper script failed, falling back to kubectl');
      result = await this.kubernetesService.deleteDeployment(payload.namespace, payload.appName);
    }

    if (result.success) {
      this.logger.log(`Successfully deleted ${payload.appName}`);
    } else {
      this.logger.error(`Failed to delete ${payload.appName}: ${result.error}`);
    }

    return this.formatResult(result);
  }
}
