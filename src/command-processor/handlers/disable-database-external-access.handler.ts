import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, DisableDatabaseExternalAccessPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

@Injectable()
export class DisableDatabaseExternalAccessHandler extends BaseHandler<DisableDatabaseExternalAccessPayload> {
  protected readonly logger = new Logger(DisableDatabaseExternalAccessHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);
    const { name, namespace } = payload;

    this.logger.log(`Disabling external access for ${name}`);

    const result = await this.kubernetesService.executeCommand(
      `kubectl delete ingressroutetcp '${name}-external' -n '${namespace}' --ignore-not-found`,
    );

    if (result.success) {
      this.logger.log(`External access disabled for ${name}`);
    } else {
      this.logger.error(`Failed to disable external access: ${result.error}`);
    }

    return this.formatResult(result);
  }
}
