import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, UpdateEnvPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

@Injectable()
export class UpdateEnvHandler extends BaseHandler<UpdateEnvPayload> {
  protected readonly logger = new Logger(UpdateEnvHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);

    this.logger.log(
      `Updating env vars for ${payload.appName} in namespace ${payload.namespace}`,
    );

    const envCount = Object.keys(payload.envVars).length;
    if (envCount === 0) {
      return {
        success: true,
        logs: 'No environment variables to update',
      };
    }

    const result = await this.kubernetesService.setEnvVars(
      payload.namespace,
      payload.appName,
      payload.envVars,
    );

    if (result.success) {
      this.logger.log(`Successfully updated ${envCount} env vars for ${payload.appName}`);
    } else {
      this.logger.error(`Failed to update env vars for ${payload.appName}: ${result.error}`);
    }

    return this.formatResult(result);
  }
}
