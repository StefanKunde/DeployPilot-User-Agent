import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, UpdateDatabasePasswordPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';

@Injectable()
export class UpdateDatabasePasswordHandler extends BaseHandler<UpdateDatabasePasswordPayload> {
  protected readonly logger = new Logger(UpdateDatabasePasswordHandler.name);

  constructor(kubernetesService: KubernetesService) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);
    const { name, namespace, type, username, password } = payload;

    this.logger.log(`Updating password for database: ${name}`);

    const envEntries =
      type === 'postgres'
        ? { POSTGRES_USER: username, POSTGRES_PASSWORD: password }
        : { MONGO_INITDB_ROOT_USERNAME: username, MONGO_INITDB_ROOT_PASSWORD: password };

    const stringData = Object.entries(envEntries)
      .map(([k, v]) => `  ${k}: "${v.replace(/"/g, '\\"')}"`)
      .join('\n');

    const yaml = `apiVersion: v1
kind: Secret
metadata:
  name: ${name}-credentials
  namespace: ${namespace}
type: Opaque
stringData:
${stringData}
`;

    const result = await this.kubernetesService.applyYaml(yaml);
    if (!result.success) {
      this.logger.error(`Failed to update secret: ${result.error}`);
      return this.formatResult(result);
    }

    // Restart pod to pick up new credentials
    const restartResult = await this.kubernetesService.executeCommand(
      `kubectl rollout restart statefulset '${name}' -n '${namespace}'`,
    );

    if (restartResult.success) {
      this.logger.log(`Password updated for ${name}, pod restarting`);
    } else {
      this.logger.error(`Failed to restart statefulset: ${restartResult.error}`);
    }

    return this.formatResult(restartResult);
  }
}
