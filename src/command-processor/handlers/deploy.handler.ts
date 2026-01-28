import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, DeployPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';
import { BuildService } from '../../build';
import { LogStreamService } from '../../log-stream';

@Injectable()
export class DeployHandler extends BaseHandler<DeployPayload> {
  protected readonly logger = new Logger(DeployHandler.name);

  constructor(
    kubernetesService: KubernetesService,
    private readonly buildService: BuildService,
    private readonly logStream: LogStreamService,
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

    // Update status to building
    this.logStream.updateStatus(payload.deploymentId, 'building');
    this.logStream.sendLog(payload.deploymentId, `Starting deployment of ${payload.appName}`, 'info', 'general');

    try {
      // Step 1: Ensure namespace exists
      this.logStream.sendLog(payload.deploymentId, `Creating namespace ${payload.namespace}...`, 'info', 'deploy');
      const nsResult = await this.kubernetesService.ensureNamespace(payload.namespace);
      if (!nsResult.success) {
        this.logger.error(`Failed to create namespace: ${nsResult.error}`);
        this.logStream.sendLog(payload.deploymentId, `Failed to create namespace: ${nsResult.error}`, 'error', 'deploy');
        this.logStream.updateStatus(payload.deploymentId, 'failed', `Namespace creation failed: ${nsResult.error}`);
        return {
          success: false,
          error: `Namespace creation failed: ${nsResult.error}`,
          logs: nsResult.stdout,
        };
      }
      logs.push(`Namespace ${payload.namespace} ready`);
      this.logStream.sendLog(payload.deploymentId, `Namespace ${payload.namespace} ready`, 'info', 'deploy');

      // Step 2: Build the application (logs are sent by BuildService)
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
        this.logStream.updateStatus(payload.deploymentId, 'failed', `Build failed: ${buildResult.error}`);
        return {
          success: false,
          error: `Build failed: ${buildResult.error}`,
          logs: logs.join('\n'),
        };
      }

      this.logger.log(`Build successful: ${buildResult.imageName}`);

      // Step 3: Deploy to Kubernetes
      this.logStream.updateStatus(payload.deploymentId, 'deploying');
      this.logStream.sendLog(payload.deploymentId, `Deploying to Kubernetes...`, 'info', 'deploy');

      // Static frameworks use nginx on port 80
      const staticFrameworks = ['angular', 'react', 'react-vite', 'vue', 'static'];
      const containerPort = staticFrameworks.includes(payload.framework) ? 80 : payload.port;

      this.logStream.sendLog(payload.deploymentId, `Creating Deployment, Service, and Ingress with TLS...`, 'info', 'deploy');
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
        this.logStream.sendLog(payload.deploymentId, `Kubernetes deployment failed: ${deployResult.error}`, 'error', 'deploy');
        this.logStream.updateStatus(payload.deploymentId, 'failed', `Deployment failed: ${deployResult.error}`);
        return {
          success: false,
          error: `Deployment failed: ${deployResult.error}`,
          logs: logs.join('\n') + '\n' + deployResult.stderr,
        };
      }

      logs.push(`Deployed to Kubernetes: ${payload.appName}`);
      logs.push(`Domain: ${payload.domain}`);

      this.logger.log(`Successfully deployed ${payload.appName} at ${payload.domain}`);
      this.logStream.sendLog(payload.deploymentId, `Deployment successful: https://${payload.domain}`, 'info', 'deploy');
      this.logStream.updateStatus(payload.deploymentId, 'ready');

      return {
        success: true,
        logs: logs.join('\n'),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Deployment error: ${errorMessage}`);
      this.logStream.sendLog(payload.deploymentId, `Deployment error: ${errorMessage}`, 'error', 'general');
      this.logStream.updateStatus(payload.deploymentId, 'failed', errorMessage);
      return {
        success: false,
        error: errorMessage,
        logs: logs.join('\n'),
      };
    }
  }
}
