import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, EnableDatabaseExternalAccessPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

@Injectable()
export class EnableDatabaseExternalAccessHandler extends BaseHandler<EnableDatabaseExternalAccessPayload> {
  protected readonly logger = new Logger(EnableDatabaseExternalAccessHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);
    const { name, namespace, type, port, externalHost } = payload;

    this.logger.log(`Enabling external access for ${name}: ${externalHost}`);

    const yaml = `apiVersion: traefik.io/v1alpha1
kind: IngressRouteTCP
metadata:
  name: ${name}-external
  namespace: ${namespace}
spec:
  entryPoints:
    - ${type}
  routes:
    - match: HostSNI(\`${externalHost}\`)
      services:
        - name: ${name}
          port: ${port}
  tls:
    passthrough: false
`;

    const result = await this.kubernetesService.applyYaml(yaml);

    if (result.success) {
      this.logger.log(`External access enabled for ${name}`);
    } else {
      this.logger.error(`Failed to enable external access: ${result.error}`);
    }

    return this.formatResult(result);
  }
}
