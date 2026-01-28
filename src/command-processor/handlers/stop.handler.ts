import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, StopPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

@Injectable()
export class StopHandler extends BaseHandler<StopPayload> {
  protected readonly logger = new Logger(StopHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);

    this.logger.log(`Stopping ${payload.appName} in namespace ${payload.namespace}`);

    const result = await this.kubernetesService.stopDeployment(
      payload.namespace,
      payload.appName,
    );

    if (result.success) {
      this.logger.log(`Successfully stopped ${payload.appName}`);
    } else {
      this.logger.error(`Failed to stop ${payload.appName}: ${result.error}`);
    }

    return this.formatResult(result);
  }
}
