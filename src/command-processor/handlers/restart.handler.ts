import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, RestartPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

@Injectable()
export class RestartHandler extends BaseHandler<RestartPayload> {
  protected readonly logger = new Logger(RestartHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);

    this.logger.log(`Restarting ${payload.appName} in namespace ${payload.namespace}`);

    const result = await this.kubernetesService.restartDeployment(
      payload.namespace,
      payload.appName,
    );

    if (result.success) {
      this.logger.log(`Successfully restarted ${payload.appName}`);
    } else {
      this.logger.error(`Failed to restart ${payload.appName}: ${result.error}`);
    }

    return this.formatResult(result);
  }
}
