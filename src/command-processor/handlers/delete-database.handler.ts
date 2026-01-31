import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, DeleteDatabasePayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';
import { ApiClientService } from '../../api-client';

@Injectable()
export class DeleteDatabaseHandler extends BaseHandler<DeleteDatabasePayload> {
  protected readonly logger = new Logger(DeleteDatabaseHandler.name);

  constructor(
    kubernetesService: KubernetesService,
    private readonly apiClient: ApiClientService,
  ) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);
    const { databaseId, name, namespace, externalAccessEnabled } = payload;

    this.logger.log(`Deleting database: ${name}`);

    try {
      if (externalAccessEnabled) {
        await this.kubernetesService.executeCommand(
          `kubectl delete ingressroutetcp '${name}-external' -n '${namespace}' --ignore-not-found`,
        );
      }

      const resources = [
        `statefulset '${name}'`,
        `service '${name}'`,
        `pvc '${name}-data'`,
        `secret '${name}-credentials'`,
      ];

      for (const resource of resources) {
        await this.kubernetesService.executeCommand(
          `kubectl delete ${resource} -n '${namespace}' --ignore-not-found`,
        );
      }

      await this.apiClient.confirmDatabaseDeletion(databaseId);

      this.logger.log(`Database ${name} deleted successfully`);
      return { success: true, logs: `Database ${name} deleted` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to delete database ${name}: ${msg}`);
      return { success: false, error: msg };
    }
  }
}
