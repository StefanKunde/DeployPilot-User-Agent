import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, DeployPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

@Injectable()
export class DeployHandler extends BaseHandler<DeployPayload> {
  protected readonly logger = new Logger(DeployHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);

    this.logger.log(
      `Deploying ${payload.appName} to namespace ${payload.namespace} with image ${payload.imageTag}`,
    );

    // First, set environment variables if any
    if (Object.keys(payload.envVars).length > 0) {
      this.logger.debug(`Setting ${Object.keys(payload.envVars).length} environment variables`);
    }

    // Deploy the application
    const result = await this.kubernetesService.deployApp(
      payload.namespace,
      payload.appName,
      payload.imageTag,
      payload.port,
      payload.domain,
    );

    if (!result.success) {
      this.logger.error(`Deployment failed for ${payload.appName}: ${result.error}`);
      return this.formatResult(result);
    }

    // Set environment variables after deployment
    if (Object.keys(payload.envVars).length > 0) {
      const envResult = await this.kubernetesService.setEnvVars(
        payload.namespace,
        payload.appName,
        payload.envVars,
      );

      if (!envResult.success) {
        this.logger.warn(`Failed to set env vars for ${payload.appName}: ${envResult.error}`);
        // Don't fail the whole deployment for env var issues
        return {
          success: true,
          logs: `Deployment succeeded but env vars failed: ${envResult.error}\n${result.stdout}`,
        };
      }
    }

    this.logger.log(`Successfully deployed ${payload.appName}`);
    return this.formatResult(result);
  }
}
