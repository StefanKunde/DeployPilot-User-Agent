import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export type LogLevel = 'info' | 'warn' | 'error';

@Injectable()
export class LogStreamService {
  private readonly logger = new Logger(LogStreamService.name);
  private readonly backendUrl: string;
  private readonly serverToken: string;

  constructor(private readonly configService: ConfigService) {
    this.backendUrl = this.configService.get<string>('backendUrl') || '';
    this.serverToken = this.configService.get<string>('serverToken') || '';
  }

  /**
   * Send a log message to the backend (fire-and-forget)
   */
  sendLog(deploymentId: string, message: string, level: LogLevel = 'info'): void {
    const url = `${this.backendUrl}/api/deployments/${deploymentId}/logs`;

    axios
      .post(
        url,
        { message, level, timestamp: new Date().toISOString() },
        {
          headers: {
            Authorization: `Bearer ${this.serverToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      )
      .catch((error) => {
        this.logger.debug(
          `Failed to send log to backend: ${error.message}`,
        );
      });
  }

  /**
   * Update deployment status on the backend (fire-and-forget)
   */
  updateStatus(
    deploymentId: string,
    status: string,
    message?: string,
  ): void {
    const url = `${this.backendUrl}/api/deployments/${deploymentId}/status`;

    axios
      .patch(
        url,
        { status, message },
        {
          headers: {
            Authorization: `Bearer ${this.serverToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        },
      )
      .catch((error) => {
        this.logger.debug(
          `Failed to update status on backend: ${error.message}`,
        );
      });
  }
}
