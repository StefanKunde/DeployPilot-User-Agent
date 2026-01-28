import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, DeployPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';
import { BuildService } from '../../build';

@Injectable()
export class DeployHandler extends BaseHandler<DeployPayload> {
  protected readonly logger = new Logger(DeployHandler.name);

  constructor(
    kubernetesService: KubernetesService,
    private readonly buildService: BuildService,
  ) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);
    const logs: string[] = [];

    this.logger.log(
      `Deploying ${payload.appName} to namespace ${payload.namespace}`,
    );
    this.logger.log(`Framework: ${payload.framework}, Git: ${payload.gitRepoUrl}`);

    try {
      // Step 1: Ensure namespace exists
      this.logger.log(`Step 1: Ensuring namespace ${payload.namespace} exists`);
      const nsResult = await this.kubernetesService.ensureNamespace(payload.namespace);
      if (!nsResult.success) {
        this.logger.error(`Failed to create namespace: ${nsResult.error}`);
        return {
          success: false,
          error: `Namespace creation failed: ${nsResult.error}`,
          logs: nsResult.stdout,
        };
      }
      logs.push(`Namespace ${payload.namespace} ready`);

      // Step 2: Build the application
      this.logger.log(`Step 2: Building application from ${payload.gitRepoUrl}`);
      const buildResult = await this.buildService.build({
        appName: payload.appName,
        deploymentId: payload.deploymentId,
        gitRepoUrl: payload.gitRepoUrl,
        gitBranch: payload.gitBranch,
        framework: payload.framework,
        buildCommand: payload.buildCommand,
        startCommand: payload.startCommand,
        outputDirectory: payload.outputDirectory,
        port: payload.port,
        envVars: payload.envVars,
      });

      logs.push(buildResult.logs);

      if (!buildResult.success) {
        this.logger.error(`Build failed: ${buildResult.error}`);
        return {
          success: false,
          error: `Build failed: ${buildResult.error}`,
          logs: logs.join('\n'),
        };
      }

      this.logger.log(`Build successful: ${buildResult.imageName}`);

      // Step 3: Deploy to Kubernetes
      this.logger.log(`Step 3: Deploying to Kubernetes`);

      // Static frameworks use nginx on port 80
      const staticFrameworks = ['angular', 'react', 'react-vite', 'vue', 'static'];
      const containerPort = staticFrameworks.includes(payload.framework) ? 80 : payload.port;

      const deployResult = await this.kubernetesService.deployAppWithImage(
        payload.namespace,
        payload.appName,
        buildResult.imageName,
        containerPort,
        payload.domain,
        payload.envVars,
        payload.resourceConfig,
      );

      if (!deployResult.success) {
        this.logger.error(`Kubernetes deployment failed: ${deployResult.error}`);
        return {
          success: false,
          error: `Deployment failed: ${deployResult.error}`,
          logs: logs.join('\n') + '\n' + deployResult.stderr,
        };
      }

      logs.push(`Deployed to Kubernetes: ${payload.appName}`);
      logs.push(`Domain: ${payload.domain}`);

      this.logger.log(`Successfully deployed ${payload.appName} at ${payload.domain}`);

      return {
        success: true,
        logs: logs.join('\n'),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Deployment error: ${errorMessage}`);
      return {
        success: false,
        error: errorMessage,
        logs: logs.join('\n'),
      };
    }
  }
}
