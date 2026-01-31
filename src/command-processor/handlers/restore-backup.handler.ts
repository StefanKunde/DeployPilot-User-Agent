import { Injectable, Logger } from '@nestjs/common';
import { BaseHandler, HandlerResult } from './base.handler';
import { Command, RestoreBackupPayload } from '../../api-client/types';
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
const COPY_TIMEOUT = 300000; // 5 minutes
const CLEANUP_TIMEOUT = 30000; // 30 seconds

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
    const { backupId, databaseType, databaseName, downloadUrl } = payload;
    const backupPath = `/tmp/restore-${backupId}`;

    this.logger.log(`Restoring ${databaseType} backup for ${databaseName}`);

    try {
      await this.apiClient.updateBackupStatus(backupId, 'restoring');

      await this.downloadFromR2(downloadUrl, backupPath);

      if (databaseType === 'postgresql') {
        await this.restorePostgresBackup(payload, backupPath);
      } else if (databaseType === 'mongodb') {
        await this.restoreMongoBackup(payload, backupPath);
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

  private async restorePostgresBackup(payload: RestoreBackupPayload, backupPath: string): Promise<void> {
    const { databaseName, namespace, credentials } = payload;
    const { username, password, database } = credentials;
    const podName = `${databaseName}-0`;
    const podRestorePath = '/tmp/restore.dump';

    await execAsync(
      `kubectl cp '${backupPath}' '${namespace}/${podName}:${podRestorePath}'`,
      { timeout: COPY_TIMEOUT },
    );
    this.logger.log(`Backup copied to pod ${podName}`);

    const escapedPassword = password.replace(/'/g, "'\\''");
    const restoreCmd = `PGPASSWORD='${escapedPassword}' pg_restore -U '${username}' -d '${database}' --clean --if-exists ${podRestorePath}`;

    const result = await execAsync(
      `kubectl exec -n '${namespace}' '${podName}' -- sh -c "${restoreCmd}"`,
      { timeout: RESTORE_TIMEOUT },
    );

    if (result.stderr && result.stderr.toLowerCase().includes('error') && !result.stderr.includes('does not exist')) {
      throw new Error(`pg_restore failed: ${result.stderr}`);
    }

    await execAsync(
      `kubectl exec -n '${namespace}' '${podName}' -- rm -f ${podRestorePath}`,
      { timeout: CLEANUP_TIMEOUT },
    ).catch(() => {});

    this.logger.log(`PostgreSQL restore completed in pod ${podName}`);
  }

  private async restoreMongoBackup(payload: RestoreBackupPayload, backupPath: string): Promise<void> {
    const { databaseName, namespace, credentials } = payload;
    const { username, password, database } = credentials;
    const podName = `${databaseName}-0`;
    const podRestorePath = '/tmp/restore.archive';

    await execAsync(
      `kubectl cp '${backupPath}' '${namespace}/${podName}:${podRestorePath}'`,
      { timeout: COPY_TIMEOUT },
    );
    this.logger.log(`Backup copied to pod ${podName}`);

    const escapedPassword = password.replace(/'/g, "'\\''");
    const uri = `mongodb://${username}:${escapedPassword}@localhost:27017/${database}?authSource=admin`;
    const restoreCmd = `mongorestore --uri='${uri}' --archive=${podRestorePath} --gzip --drop`;

    await execAsync(
      `kubectl exec -n '${namespace}' '${podName}' -- sh -c '${restoreCmd}'`,
      { timeout: RESTORE_TIMEOUT },
    );

    await execAsync(
      `kubectl exec -n '${namespace}' '${podName}' -- rm -f ${podRestorePath}`,
      { timeout: CLEANUP_TIMEOUT },
    ).catch(() => {});

    this.logger.log(`MongoDB restore completed in pod ${podName}`);
  }
}
