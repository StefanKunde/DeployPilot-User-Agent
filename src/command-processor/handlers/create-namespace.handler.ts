import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, CreateNamespacePayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

@Injectable()
export class CreateNamespaceHandler extends BaseHandler<CreateNamespacePayload> {
  protected readonly logger = new Logger(CreateNamespaceHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);

    this.logger.log(`Creating namespace for user ${payload.userId}: ${payload.namespace}`);

    const result = await this.kubernetesService.createNamespace(
      payload.userId,
      payload.githubToken,
    );

    if (result.success) {
      this.logger.log(`Successfully created namespace ${payload.namespace}`);
    } else {
      this.logger.error(`Failed to create namespace ${payload.namespace}: ${result.error}`);
    }

    return this.formatResult(result);
  }
}
