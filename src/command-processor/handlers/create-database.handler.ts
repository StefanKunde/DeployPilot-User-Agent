import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, CreateDatabasePayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';
import { ApiClientService } from '../../api-client';

@Injectable()
export class CreateDatabaseHandler extends BaseHandler<CreateDatabasePayload> {
  protected readonly logger = new Logger(CreateDatabaseHandler.name);

  constructor(
    kubernetesService: KubernetesService,
    private readonly apiClient: ApiClientService,
  ) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);
    const { databaseId, name, type, namespace } = payload;

    this.logger.log(`Creating ${type} database: ${name}`);

    try {
      await this.kubernetesService.ensureNamespace(namespace);
      await this.createCredentialsSecret(payload);
      await this.createPVC(payload);
      await this.createStatefulSet(payload);
      await this.createService(payload);

      if (payload.enableExternalAccess && payload.externalHost) {
        await this.createExternalAccess(payload);
      }

      await this.waitForReady(name, namespace);
      await this.apiClient.updateDatabaseStatus(databaseId, 'running');

      this.logger.log(`Database ${name} created successfully`);
      return { success: true, logs: `Database ${name} created` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to create database ${name}: ${msg}`);
      await this.apiClient.updateDatabaseStatus(databaseId, 'error', msg).catch(() => {});
      return { success: false, error: msg };
    }
  }

  private async createCredentialsSecret(p: CreateDatabasePayload): Promise<void> {
    const envEntries =
      p.type === 'postgres'
        ? { POSTGRES_USER: p.username, POSTGRES_PASSWORD: p.password, POSTGRES_DB: p.databaseName }
        : p.type === 'mongodb'
          ? { MONGO_INITDB_ROOT_USERNAME: p.username, MONGO_INITDB_ROOT_PASSWORD: p.password, MONGO_INITDB_DATABASE: p.databaseName }
          : { REDIS_PASSWORD: p.password };

    const stringData = Object.entries(envEntries)
      .map(([k, v]) => `  ${k}: "${v.replace(/"/g, '\\"')}"`)
      .join('\n');

    const yaml = `apiVersion: v1
kind: Secret
metadata:
  name: ${p.name}-credentials
  namespace: ${p.namespace}
type: Opaque
stringData:
${stringData}
`;
    const result = await this.kubernetesService.applyYaml(yaml);
    if (!result.success) throw new Error(`Failed to create secret: ${result.error}`);
  }

  private async createPVC(p: CreateDatabasePayload): Promise<void> {
    const yaml = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${p.name}-data
  namespace: ${p.namespace}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: ${p.storageSize}
`;
    const result = await this.kubernetesService.applyYaml(yaml);
    if (!result.success) throw new Error(`Failed to create PVC: ${result.error}`);
  }

  private async createStatefulSet(p: CreateDatabasePayload): Promise<void> {
    const portMap = { postgres: 5432, mongodb: 27017, redis: 6379 };
    const imageMap = { postgres: `postgres:${p.version}`, mongodb: `mongo:${p.version}`, redis: `redis:${p.version}` };
    const mountPathMap = { postgres: '/var/lib/postgresql/data', mongodb: '/data/db', redis: '/data' };

    const port = portMap[p.type];
    const image = imageMap[p.type];
    const mountPath = mountPathMap[p.type];
    const subPathLine = p.type === 'postgres' ? '\n              subPath: postgres' : '';

    const probeCmd =
      p.type === 'postgres'
        ? `["pg_isready", "-U", "${p.username}"]`
        : p.type === 'mongodb'
          ? '["mongosh", "--eval", "db.adminCommand(\'ping\')"]'
          : '["redis-cli", "ping"]';

    const readinessDelay = p.type === 'postgres' ? 5 : 10;
    const readinessPeriod = p.type === 'postgres' ? 5 : 10;
    const livenessDelay = 30;
    const livenessPeriod = 10;
    const probeTimeout = p.type === 'postgres' ? 5 : 10;

    const commandBlock =
      p.type === 'redis'
        ? `\n          command: ["redis-server", "--requirepass", "$(REDIS_PASSWORD)", "--appendonly", "yes"]`
        : '';

    const yaml = `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${p.name}
  namespace: ${p.namespace}
spec:
  serviceName: ${p.name}
  replicas: 1
  selector:
    matchLabels:
      app: ${p.name}
      type: database
  template:
    metadata:
      labels:
        app: ${p.name}
        type: database
        database-type: ${p.type}
    spec:
      containers:
        - name: ${p.type}
          image: ${image}${commandBlock}
          ports:
            - containerPort: ${port}
              name: ${p.type}
          envFrom:
            - secretRef:
                name: ${p.name}-credentials
          volumeMounts:
            - name: data
              mountPath: ${mountPath}${subPathLine}
          resources:
            requests:
              memory: "${p.memoryRequest}"
              cpu: "${p.cpuRequest}"
            limits:
              memory: "${p.memoryLimit}"
              cpu: "${p.cpuLimit}"
          readinessProbe:
            exec:
              command: ${probeCmd}
            initialDelaySeconds: ${readinessDelay}
            periodSeconds: ${readinessPeriod}
            timeoutSeconds: ${probeTimeout}
          livenessProbe:
            exec:
              command: ${probeCmd}
            initialDelaySeconds: ${livenessDelay}
            periodSeconds: ${livenessPeriod}
            timeoutSeconds: ${probeTimeout}
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: ${p.name}-data
`;
    const result = await this.kubernetesService.applyYaml(yaml);
    if (!result.success) throw new Error(`Failed to create StatefulSet: ${result.error}`);
  }

  private async createService(p: CreateDatabasePayload): Promise<void> {
    const portMap = { postgres: 5432, mongodb: 27017, redis: 6379 };
    const port = portMap[p.type];

    const yaml = `apiVersion: v1
kind: Service
metadata:
  name: ${p.name}
  namespace: ${p.namespace}
spec:
  selector:
    app: ${p.name}
  ports:
    - port: ${port}
      targetPort: ${port}
      name: ${p.type}
  clusterIP: None
`;
    const result = await this.kubernetesService.applyYaml(yaml);
    if (!result.success) throw new Error(`Failed to create Service: ${result.error}`);
  }

  private async createExternalAccess(p: CreateDatabasePayload): Promise<void> {
    const portMap = { postgres: 5432, mongodb: 27017, redis: 6379 };
    const port = portMap[p.type];

    const yaml = `apiVersion: traefik.io/v1alpha1
kind: IngressRouteTCP
metadata:
  name: ${p.name}-external
  namespace: ${p.namespace}
spec:
  entryPoints:
    - ${p.type}
  routes:
    - match: HostSNI(\`${p.externalHost}\`)
      services:
        - name: ${p.name}
          port: ${port}
  tls:
    passthrough: false
`;
    const result = await this.kubernetesService.applyYaml(yaml);
    if (!result.success) throw new Error(`Failed to create external access: ${result.error}`);
  }

  private async waitForReady(name: string, namespace: string, timeoutMs = 120000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const result = await this.kubernetesService.executeCommand(
        `kubectl get statefulset '${name}' -n '${namespace}' -o jsonpath='{.status.readyReplicas}'`,
      );

      if (result.success && result.stdout.trim() === '1') {
        this.logger.log(`Database ${name} is ready`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(`Database ${name} did not become ready within ${timeoutMs / 1000}s`);
  }
}
