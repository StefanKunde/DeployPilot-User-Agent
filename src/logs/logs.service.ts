import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { Observable, Subject } from 'rxjs';
import { LogEntry } from './types';

const execAsync = promisify(exec);

const STREAM_TIMEOUT = 30 * 60 * 1000; // 30 minutes max
const HEARTBEAT_INTERVAL = 30 * 1000; // 30 seconds

@Injectable()
export class LogsService {
  private readonly logger = new Logger(LogsService.name);

  /**
   * Get logs from all pods matching the app label
   */
  async getLogs(
    namespace: string,
    appName: string,
    tail: number = 100,
    since?: string,
  ): Promise<{ logs: LogEntry[]; podCount: number }> {
    this.validateInput(namespace, appName);

    // Build kubectl command
    const args = [
      'logs',
      '-n',
      namespace,
      '-l',
      `app=${appName}`,
      '--tail',
      String(tail),
      '--timestamps',
    ];

    if (since) {
      args.push('--since', since);
    }

    const cmd = `kubectl ${args.map((a) => this.escapeArg(a)).join(' ')}`;

    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 });

      if (stderr && stderr.includes('error')) {
        this.logger.warn(`kubectl logs stderr: ${stderr}`);
      }

      const logs = this.parseLogOutput(stdout, appName);
      const podCount = this.countUniquePods(logs);

      return { logs, podCount };
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message: string };

      // Check if pod not found
      if (
        execError.stderr?.includes('not found') ||
        execError.message?.includes('not found')
      ) {
        throw new NotFoundException(
          `No pods found for app '${appName}' in namespace '${namespace}'`,
        );
      }

      this.logger.error(`Failed to get logs: ${execError.message}`);
      throw error;
    }
  }

  /**
   * Stream logs from all pods matching the app label using SSE
   */
  streamLogs(namespace: string, appName: string): Observable<LogEntry> {
    this.validateInput(namespace, appName);

    const subject = new Subject<LogEntry>();
    let process: ChildProcess | null = null;
    let heartbeatInterval: NodeJS.Timeout | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;

    // Spawn kubectl logs -f process
    const args = [
      'logs',
      '-n',
      namespace,
      '-l',
      `app=${appName}`,
      '-f',
      '--timestamps',
      '--prefix', // Adds pod name prefix to each line
    ];

    this.logger.log(`Starting log stream for ${namespace}/${appName}`);

    process = spawn('kubectl', args);

    // Handle stdout data
    let buffer = '';
    process.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          const entry = this.parseStreamLogLine(line, appName);
          if (entry) {
            subject.next(entry);
          }
        }
      }
    });

    // Handle stderr
    process.stderr?.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      if (message && !message.includes('waiting for')) {
        this.logger.warn(`kubectl logs stderr: ${message}`);
      }
    });

    // Handle process exit
    process.on('close', (code) => {
      this.logger.log(`Log stream closed with code ${code}`);
      this.cleanup(heartbeatInterval, timeoutHandle);
      subject.complete();
    });

    process.on('error', (err) => {
      this.logger.error(`Log stream error: ${err.message}`);
      this.cleanup(heartbeatInterval, timeoutHandle);
      subject.error(err);
    });

    // Set up timeout (max 30 min)
    timeoutHandle = setTimeout(() => {
      this.logger.log(`Log stream timeout reached for ${namespace}/${appName}`);
      if (process) {
        process.kill();
      }
    }, STREAM_TIMEOUT);

    // Clean up on unsubscribe
    subject.subscribe({
      complete: () => {
        if (process && !process.killed) {
          process.kill();
        }
        this.cleanup(heartbeatInterval, timeoutHandle);
      },
      error: () => {
        if (process && !process.killed) {
          process.kill();
        }
        this.cleanup(heartbeatInterval, timeoutHandle);
      },
    });

    return subject.asObservable();
  }

  /**
   * Create heartbeat observable for SSE keep-alive
   */
  createHeartbeat(): Observable<string> {
    const subject = new Subject<string>();

    const interval = setInterval(() => {
      subject.next('keepalive');
    }, HEARTBEAT_INTERVAL);

    // Clean up on complete
    subject.subscribe({
      complete: () => clearInterval(interval),
      error: () => clearInterval(interval),
    });

    return subject.asObservable();
  }

  /**
   * Get logs from a database StatefulSet pod
   */
  async getDatabaseLogs(
    namespace: string,
    name: string,
    tail: number = 100,
    since?: string,
  ): Promise<{ logs: LogEntry[]; podCount: number }> {
    this.validateInput(namespace, name);

    const args = [
      'logs',
      '-n',
      namespace,
      `statefulset/${name}`,
      '--tail',
      String(tail),
      '--timestamps',
    ];

    if (since) {
      args.push('--since', since);
    }

    const cmd = `kubectl ${args.map((a) => this.escapeArg(a)).join(' ')}`;

    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 60000 });

      if (stderr && stderr.includes('error')) {
        this.logger.warn(`kubectl logs stderr: ${stderr}`);
      }

      const logs = this.parseLogOutput(stdout, name);
      return { logs, podCount: 1 };
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message: string };

      if (
        execError.stderr?.includes('not found') ||
        execError.message?.includes('not found')
      ) {
        throw new NotFoundException(
          `No database pod found for '${name}' in namespace '${namespace}'`,
        );
      }

      this.logger.error(`Failed to get database logs: ${execError.message}`);
      throw error;
    }
  }

  /**
   * Stream logs from a database StatefulSet pod using SSE
   */
  streamDatabaseLogs(namespace: string, name: string, tail: number = 100): Observable<LogEntry> {
    this.validateInput(namespace, name);

    const subject = new Subject<LogEntry>();
    let process: ChildProcess | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const args = [
      'logs',
      '-n',
      namespace,
      `statefulset/${name}`,
      '-f',
      '--timestamps',
      '--tail',
      String(tail),
    ];

    this.logger.log(`Starting database log stream for ${namespace}/${name}`);

    process = spawn('kubectl', args);

    let buffer = '';
    process.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim()) {
          const entry = this.parseLogLine(line, name);
          if (entry) {
            subject.next(entry);
          }
        }
      }
    });

    process.stderr?.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      if (message && !message.includes('waiting for')) {
        this.logger.warn(`kubectl database logs stderr: ${message}`);
      }
    });

    process.on('close', (code) => {
      this.logger.log(`Database log stream closed with code ${code}`);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      subject.complete();
    });

    process.on('error', (err) => {
      this.logger.error(`Database log stream error: ${err.message}`);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      subject.error(err);
    });

    timeoutHandle = setTimeout(() => {
      this.logger.log(`Database log stream timeout reached for ${namespace}/${name}`);
      if (process) {
        process.kill();
      }
    }, STREAM_TIMEOUT);

    subject.subscribe({
      complete: () => {
        if (process && !process.killed) {
          process.kill();
        }
        if (timeoutHandle) clearTimeout(timeoutHandle);
      },
      error: () => {
        if (process && !process.killed) {
          process.kill();
        }
        if (timeoutHandle) clearTimeout(timeoutHandle);
      },
    });

    return subject.asObservable();
  }

  /**
   * Parse kubectl logs output with timestamps
   * Format: 2024-01-29T10:15:23.456789Z message content
   */
  private parseLogOutput(output: string, appName: string): LogEntry[] {
    const lines = output.split('\n').filter((line) => line.trim());
    const logs: LogEntry[] = [];

    for (const line of lines) {
      const entry = this.parseLogLine(line, appName);
      if (entry) {
        logs.push(entry);
      }
    }

    // Sort by timestamp
    logs.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    return logs;
  }

  /**
   * Parse a single log line
   * Format: 2024-01-29T10:15:23.456789Z message content
   */
  private parseLogLine(line: string, defaultPodName: string): LogEntry | null {
    // Match ISO timestamp at start of line
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s+(.*)$/);

    if (match) {
      const [, timestamp, message] = match;
      return {
        timestamp: this.normalizeTimestamp(timestamp),
        message: message.trim(),
        podName: defaultPodName,
      };
    }

    // If no timestamp, treat entire line as message
    if (line.trim()) {
      return {
        timestamp: new Date().toISOString(),
        message: line.trim(),
        podName: defaultPodName,
      };
    }

    return null;
  }

  /**
   * Parse log line from streaming with --prefix flag
   * Format: [pod/myapp-abc123-xyz] 2024-01-29T10:15:23.456789Z message
   */
  private parseStreamLogLine(line: string, defaultPodName: string): LogEntry | null {
    // Match pod prefix: [pod/name] or [name]
    const prefixMatch = line.match(/^\[(?:pod\/)?([^\]]+)\]\s*(.*)$/);

    let podName = defaultPodName;
    let rest = line;

    if (prefixMatch) {
      podName = prefixMatch[1];
      rest = prefixMatch[2];
    }

    // Match ISO timestamp
    const timestampMatch = rest.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z?)\s+(.*)$/);

    if (timestampMatch) {
      return {
        timestamp: this.normalizeTimestamp(timestampMatch[1]),
        message: timestampMatch[2].trim(),
        podName,
      };
    }

    // No timestamp found
    if (rest.trim()) {
      return {
        timestamp: new Date().toISOString(),
        message: rest.trim(),
        podName,
      };
    }

    return null;
  }

  /**
   * Normalize timestamp to ISO format with milliseconds
   */
  private normalizeTimestamp(timestamp: string): string {
    // Ensure it ends with Z
    let ts = timestamp.endsWith('Z') ? timestamp : timestamp + 'Z';

    // Truncate nanoseconds to milliseconds (3 decimal places)
    ts = ts.replace(/(\.\d{3})\d*Z$/, '$1Z');

    return ts;
  }

  /**
   * Count unique pods in log entries
   */
  private countUniquePods(logs: LogEntry[]): number {
    const pods = new Set(logs.map((l) => l.podName));
    return pods.size || 1; // At least 1 if we have logs
  }

  /**
   * Validate namespace and appName to prevent shell injection
   */
  private validateInput(namespace: string, appName: string): void {
    // Only allow alphanumeric, dashes, and dots (valid K8s names)
    const validPattern = /^[a-z0-9][a-z0-9\-\.]*[a-z0-9]$|^[a-z0-9]$/;

    if (!validPattern.test(namespace)) {
      throw new Error(`Invalid namespace format: ${namespace}`);
    }

    if (!validPattern.test(appName)) {
      throw new Error(`Invalid appName format: ${appName}`);
    }
  }

  /**
   * Escape shell argument
   */
  private escapeArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Clean up intervals and timeouts
   */
  private cleanup(
    heartbeatInterval: NodeJS.Timeout | null,
    timeoutHandle: NodeJS.Timeout | null,
  ): void {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
