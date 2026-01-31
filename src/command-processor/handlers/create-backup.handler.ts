import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, CreateBackupPayload, BackupCredentials } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';
import { ApiClientService } from '../../api-client';
import { exec } from 'child_process';
import { promisify } from 'util';
import { stat, unlink } from 'fs/promises';
import { createReadStream } from 'fs';

const execAsync = promisify(exec);
const BACKUP_TIMEOUT = 600000; // 10 minutes

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
    const { backupId, databaseType, databaseName, credentials } = payload;
    const backupPath = `/tmp/backup-${backupId}`;

    this.logger.log(`Creating ${databaseType} backup for ${databaseName}`);

    try {
      await this.apiClient.updateBackupStatus(backupId, 'running');

      if (databaseType === 'postgresql') {
        await this.createPostgresBackup(credentials, backupPath);
      } else if (databaseType === 'mongodb') {
        await this.createMongoBackup(credentials, backupPath);
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

  private async createPostgresBackup(credentials: BackupCredentials, outputPath: string): Promise<void> {
    const { host, port, username, password, database, ssl } = credentials;

    const result = await execAsync(
      `PGPASSWORD='${password.replace(/'/g, "'\\''")}' pg_dump -h '${host}' -p ${port} -U '${username}' -d '${database}' -Fc -f '${outputPath}'`,
      {
        timeout: BACKUP_TIMEOUT,
        env: { ...process.env, PGSSLMODE: ssl ? 'require' : 'prefer' },
      },
    );

    if (result.stderr && result.stderr.toLowerCase().includes('error') && !result.stderr.includes('warning')) {
      throw new Error(`pg_dump failed: ${result.stderr}`);
    }

    this.logger.log(`PostgreSQL backup created: ${outputPath}`);
  }

  private async createMongoBackup(credentials: BackupCredentials, outputPath: string): Promise<void> {
    const { host, port, username, password, database, ssl } = credentials;

    const tlsParam = ssl ? '&tls=true' : '';
    const uri = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}?authSource=admin${tlsParam}`;

    await execAsync(
      `mongodump --uri='${uri}' --archive='${outputPath}' --gzip`,
      { timeout: BACKUP_TIMEOUT },
    );

    this.logger.log(`MongoDB backup created: ${outputPath}`);
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
