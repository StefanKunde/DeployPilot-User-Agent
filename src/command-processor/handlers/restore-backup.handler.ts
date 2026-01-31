import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, RestoreBackupPayload, BackupCredentials } from '../../api-client/types';
import { KubernetesService } from '../../kubernetes';
import { ApiClientService } from '../../api-client';
import { exec } from 'child_process';
import { promisify } from 'util';
import { unlink } from 'fs/promises';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const execAsync = promisify(exec);
const RESTORE_TIMEOUT = 600000; // 10 minutes

@Injectable()
export class RestoreBackupHandler extends BaseHandler<RestoreBackupPayload> {
  protected readonly logger = new Logger(RestoreBackupHandler.name);

  constructor(
    kubernetesService: KubernetesService,
    private readonly apiClient: ApiClientService,
  ) {
    super(kubernetesService);
  }

  async handle(command: Command): Promise<HandlerResult> {
    const payload = this.getPayload(command);
    const { backupId, databaseType, databaseName, downloadUrl, credentials } = payload;
    const backupPath = `/tmp/restore-${backupId}`;

    this.logger.log(`Restoring ${databaseType} backup for ${databaseName}`);

    try {
      await this.apiClient.updateBackupStatus(backupId, 'restoring');

      await this.downloadFromR2(downloadUrl, backupPath);

      if (databaseType === 'postgresql') {
        await this.restorePostgresBackup(credentials, backupPath);
      } else if (databaseType === 'mongodb') {
        await this.restoreMongoBackup(credentials, backupPath);
      } else {
        throw new Error(`Unsupported database type for restore: ${databaseType}`);
      }

      await this.apiClient.updateBackupStatus(backupId, 'restore_completed');

      this.logger.log(`Restore ${backupId} completed`);
      return { success: true, logs: `Backup restored successfully` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Restore ${backupId} failed: ${msg}`);
      await this.apiClient.updateBackupStatus(backupId, 'restore_failed', { errorMessage: msg }).catch(() => {});
      return { success: false, error: msg };
    } finally {
      await unlink(backupPath).catch(() => {});
    }
  }

  private async downloadFromR2(downloadUrl: string, outputPath: string): Promise<void> {
    const response = await fetch(downloadUrl);

    if (!response.ok) {
      throw new Error(`R2 download failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('R2 download returned empty body');
    }

    const fileStream = createWriteStream(outputPath);
    await pipeline(Readable.fromWeb(response.body as never), fileStream);

    this.logger.log(`Backup downloaded from R2: ${outputPath}`);
  }

  private async restorePostgresBackup(credentials: BackupCredentials, backupPath: string): Promise<void> {
    const { host, port, username, password, database, ssl } = credentials;

    const result = await execAsync(
      `PGPASSWORD='${password.replace(/'/g, "'\\''")}' pg_restore -h '${host}' -p ${port} -U '${username}' -d '${database}' --clean --if-exists '${backupPath}'`,
      {
        timeout: RESTORE_TIMEOUT,
        env: { ...process.env, PGSSLMODE: ssl ? 'require' : 'prefer' },
      },
    );

    // pg_restore outputs warnings for objects that don't exist yet when using --clean
    if (result.stderr && result.stderr.toLowerCase().includes('error') && !result.stderr.includes('does not exist')) {
      throw new Error(`pg_restore failed: ${result.stderr}`);
    }

    this.logger.log('PostgreSQL restore completed');
  }

  private async restoreMongoBackup(credentials: BackupCredentials, backupPath: string): Promise<void> {
    const { host, port, username, password, database, ssl } = credentials;

    const tlsParam = ssl ? '&tls=true' : '';
    const uri = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}?authSource=admin${tlsParam}`;

    await execAsync(
      `mongorestore --uri='${uri}' --archive='${backupPath}' --gzip --drop`,
      { timeout: RESTORE_TIMEOUT },
    );

    this.logger.log('MongoDB restore completed');
  }
}
