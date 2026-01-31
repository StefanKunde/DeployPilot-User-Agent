import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, CreateBackupPayload } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';
import { ApiClientService } from '../../api-client';
import { exec } from 'child_process';
import { promisify } from 'util';
import { stat, unlink } from 'fs/promises';
import { createReadStream } from 'fs';

const execAsync = promisify(exec);
const BACKUP_TIMEOUT = 600000; // 10 minutes
const COPY_TIMEOUT = 300000; // 5 minutes
const CLEANUP_TIMEOUT = 30000; // 30 seconds

@Injectable()
export class CreateBackupHandler extends BaseHandler<CreateBackupPayload> {
  protected readonly logger = new Logger(CreateBackupHandler.name);

  constructor(
    kubernetesService: KubernetesService,
    private readonly apiClient: ApiClientService,
  ) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);
    const { backupId, databaseType, databaseName } = payload;
    const backupPath = `/tmp/backup-${backupId}`;

    this.logger.log(`Creating ${databaseType} backup for ${databaseName}`);

    try {
      await this.apiClient.updateBackupStatus(backupId, 'running');

      if (databaseType === 'postgresql') {
        await this.createPostgresBackup(payload, backupPath);
      } else if (databaseType === 'mongodb') {
        await this.createMongoBackup(payload, backupPath);
      } else {
        throw new Error(`Unsupported database type for backup: ${databaseType}`);
      }

      const stats = await stat(backupPath);
      const sizeBytes = stats.size;

      await this.apiClient.updateBackupStatus(backupId, 'uploading');

      const { uploadUrl, key } = await this.apiClient.getBackupUploadUrl(backupId);

      await this.uploadToR2(backupPath, uploadUrl);

      await this.apiClient.updateBackupStatus(backupId, 'completed', { sizeBytes, storageKey: key });

      this.logger.log(`Backup ${backupId} completed (${sizeBytes} bytes)`);
      return { success: true, logs: `Backup created and uploaded (${sizeBytes} bytes)` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Backup ${backupId} failed: ${msg}`);
      await this.apiClient.updateBackupStatus(backupId, 'failed', { errorMessage: msg }).catch(() => {});
      return { success: false, error: msg };
    } finally {
      await unlink(backupPath).catch(() => {});
    }
  }

  private async createPostgresBackup(payload: CreateBackupPayload, outputPath: string): Promise<void> {
    const { databaseName, namespace, credentials } = payload;
    const { username, password, database } = credentials;
    const podName = `${databaseName}-0`;
    const podBackupPath = '/tmp/backup.dump';

    const escapedPassword = password.replace(/'/g, "'\\''");
    const dumpCmd = `PGPASSWORD='${escapedPassword}' pg_dump -U '${username}' -d '${database}' -Fc -f ${podBackupPath}`;

    await execAsync(
      `kubectl exec -n '${namespace}' '${podName}' -- sh -c "${dumpCmd}"`,
      { timeout: BACKUP_TIMEOUT },
    );
    this.logger.log(`PostgreSQL dump created in pod ${podName}`);

    await execAsync(
      `kubectl cp '${namespace}/${podName}:${podBackupPath}' '${outputPath}'`,
      { timeout: COPY_TIMEOUT },
    );
    this.logger.log(`Backup copied from pod to ${outputPath}`);

    await execAsync(
      `kubectl exec -n '${namespace}' '${podName}' -- rm -f ${podBackupPath}`,
      { timeout: CLEANUP_TIMEOUT },
    ).catch(() => {});
  }

  private async createMongoBackup(payload: CreateBackupPayload, outputPath: string): Promise<void> {
    const { databaseName, namespace, credentials } = payload;
    const { username, password, database } = credentials;
    const podName = `${databaseName}-0`;
    const podBackupPath = '/tmp/backup.archive';

    const escapedPassword = password.replace(/'/g, "'\\''");
    const uri = `mongodb://${username}:${escapedPassword}@localhost:27017/${database}?authSource=admin`;
    const dumpCmd = `mongodump --uri='${uri}' --archive=${podBackupPath} --gzip`;

    await execAsync(
      `kubectl exec -n '${namespace}' '${podName}' -- sh -c '${dumpCmd}'`,
      { timeout: BACKUP_TIMEOUT },
    );
    this.logger.log(`MongoDB dump created in pod ${podName}`);

    await execAsync(
      `kubectl cp '${namespace}/${podName}:${podBackupPath}' '${outputPath}'`,
      { timeout: COPY_TIMEOUT },
    );
    this.logger.log(`Backup copied from pod to ${outputPath}`);

    await execAsync(
      `kubectl exec -n '${namespace}' '${podName}' -- rm -f ${podBackupPath}`,
      { timeout: CLEANUP_TIMEOUT },
    ).catch(() => {});
  }

  private async uploadToR2(filePath: string, uploadUrl: string): Promise<void> {
    const stats = await stat(filePath);
    const fileStream = createReadStream(filePath);

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: fileStream as unknown as BodyInit,
      headers: {
        'Content-Length': stats.size.toString(),
        'Content-Type': 'application/octet-stream',
      },
      // @ts-expect-error duplex required for streaming request body
      duplex: 'half',
    });

    if (!response.ok) {
      throw new Error(`R2 upload failed: ${response.status} ${response.statusText}`);
    }

    this.logger.log('Backup uploaded to R2');
  }
}
