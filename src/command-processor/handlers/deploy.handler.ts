import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, DeployPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

const APPS_DOMAIN = 'apps.deploypilot.stefankunde.dev';
const DEFAULT_NAMESPACE = 'user-default';
const DEFAULT_PORT = 3000;

@Injectable()
export class DeployHandler extends BaseHandler<DeployPayload> {
  protected readonly logger = new Logger(DeployHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);

    // Map backend payload to kubernetes values
    const namespace = payload.namespace || DEFAULT_NAMESPACE;
    const appName = payload.appName || payload.subdomain;
    const image = payload.imageTag;
    const port = payload.port || DEFAULT_PORT;
    const domain = payload.domain || `${payload.subdomain}.${APPS_DOMAIN}`;
    const envVars = payload.envVars || {};

    this.logger.log(
      `Deploying ${appName} to namespace ${namespace} with image ${image}`,
    );
    this.logger.debug(`Domain: ${domain}, Port: ${port}`);

    // Deploy the application
    const result = await this.kubernetesService.deployApp(
      namespace,
      appName,
      image,
      port,
      domain,
    );

    if (!result.success) {
      this.logger.error(`Deployment failed for ${appName}: ${result.error}`);
      return this.formatResult(result);
    }

    // Set environment variables after deployment
    if (Object.keys(envVars).length > 0) {
      this.logger.debug(`Setting ${Object.keys(envVars).length} environment variables`);
      const envResult = await this.kubernetesService.setEnvVars(
        namespace,
        appName,
        envVars,
      );

      if (!envResult.success) {
        this.logger.warn(`Failed to set env vars for ${appName}: ${envResult.error}`);
        // Don't fail the whole deployment for env var issues
        return {
          success: true,
          logs: `Deployment succeeded but env vars failed: ${envResult.error}\n${result.stdout}`,
        };
      }
    }

    this.logger.log(`Successfully deployed ${appName} at ${domain}`);
    return this.formatResult(result);
  }
}
