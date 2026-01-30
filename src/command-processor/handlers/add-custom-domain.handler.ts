import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, CustomDomainPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';
import { ApiClientService } from '../../api-client';

@Injectable()
export class AddCustomDomainHandler extends BaseHandler<CustomDomainPayload> {
  protected readonly logger = new Logger(AddCustomDomainHandler.name);

  constructor(
    kubernetesService: KubernetesService,
    private readonly apiClient: ApiClientService,
  ) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);
    const { namespace, appName, domain } = payload;

    this.logger.log(`Adding custom domain ${domain} to ${appName} in ${namespace}`);

    const ingressName = `${appName}-${domain.replace(/\./g, '-')}`;

    const ingressYaml = `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${ingressName}
  namespace: ${namespace}
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  ingressClassName: traefik
  tls:
  - hosts:
    - ${domain}
    secretName: ${ingressName}-tls
  rules:
  - host: ${domain}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: ${appName}
            port:
              number: 80
`;

    const result = await this.kubernetesService.applyYaml(ingressYaml);

    if (result.success) {
      this.logger.log(`Custom domain ingress created: ${domain} -> ${appName}`);

      // Start async SSL certificate check (non-blocking)
      this.checkSslStatus(namespace, ingressName, domain, payload.domainId);
    } else {
      this.logger.error(`Failed to create custom domain ingress: ${result.error}`);
    }

    return this.formatResult(result);
  }

  private async checkSslStatus(
    namespace: string,
    ingressName: string,
    domain: string,
    domainId: string,
  ): Promise<void> {
    const secretName = `${ingressName}-tls`;
    const maxAttempts = 30; // 5 minutes (30 * 10s)
    const intervalMs = 10_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));

      try {
        const result = await this.kubernetesService.executeCommand(
          `kubectl get secret '${secretName}' -n '${namespace}' -o jsonpath='{.data.tls\\.crt}'`,
        );

        if (result.success && result.stdout.trim().length > 0) {
          this.logger.log(`SSL certificate ready for ${domain}`);
          await this.apiClient.updateSslStatus(domainId, 'active').catch((err) => {
            this.logger.error(`Failed to send SSL status update: ${err.message}`);
          });
          return;
        }

        this.logger.debug(`SSL certificate pending for ${domain} (attempt ${attempt}/${maxAttempts})`);
      } catch (error) {
        this.logger.error(`Error checking SSL status: ${error instanceof Error ? error.message : error}`);
      }
    }

    this.logger.warn(`SSL certificate timeout for ${domain} after ${maxAttempts} attempts`);
    await this.apiClient.updateSslStatus(domainId, 'error').catch((err) => {
      this.logger.error(`Failed to send SSL timeout update: ${err.message}`);
    });
  }
}
