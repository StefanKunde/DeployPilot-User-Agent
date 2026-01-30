import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, CustomDomainPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

@Injectable()
export class RemoveCustomDomainHandler extends BaseHandler<CustomDomainPayload> {
  protected readonly logger = new Logger(RemoveCustomDomainHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);
    const { namespace, appName, domain } = payload;

    this.logger.log(`Removing custom domain ${domain} from ${appName} in ${namespace}`);

    const ingressName = `${appName}-${domain.replace(/\./g, '-')}`;

    // Delete Ingress
    const result = await this.kubernetesService.deleteIngress(namespace, ingressName);

    // Cleanup TLS secret (best-effort)
    await this.kubernetesService.deleteSecret(namespace, `${ingressName}-tls`);

    if (result.success) {
      this.logger.log(`Custom domain ingress deleted: ${domain}`);
    } else {
      this.logger.error(`Failed to delete custom domain ingress: ${result.error}`);
    }

    return this.formatResult(result);
  }
}
