import {
  Controller,
  Get,
  Param,
  Query,
  Sse,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  MessageEvent,
} from '@nestjs/common';
import { Observable, merge, map, catchError, of, finalize, Subject } from 'rxjs';
import { LogsService } from './logs.service';
import { LogsResponse, LogsQueryDto, LogEntry } from './types';

const HEARTBEAT_INTERVAL = 30 * 1000; // 30 seconds

@Controller('logs')
export class LogsController {
  private readonly logger = new Logger(LogsController.name);

  constructor(private readonly logsService: LogsService) {}

  /**
   * GET /logs/:namespace/:appName
   * Fetch logs from all pods matching the app label
   */
  @Get(':namespace/:appName')
  async getLogs(
    @Param('namespace') namespace: string,
    @Param('appName') appName: string,
    @Query() query: LogsQueryDto,
  ): Promise<LogsResponse> {
    const tail = query.tail ? parseInt(String(query.tail), 10) : 100;
    const since = query.since;

    this.logger.log(`Fetching logs for ${namespace}/${appName} (tail=${tail}, since=${since || 'none'})`);

    try {
      const result = await this.logsService.getLogs(namespace, appName, tail, since);
      this.logger.log(`Returned ${result.logs.length} log entries from ${result.podCount} pod(s)`);
      return result;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to fetch logs: ${message}`);
      throw new InternalServerErrorException(`Failed to fetch logs: ${message}`);
    }
  }

  /**
   * GET /logs/:namespace/:appName/stream (SSE)
   * Stream logs in real-time using Server-Sent Events
   */
  @Sse(':namespace/:appName/stream')
  streamLogs(
    @Param('namespace') namespace: string,
    @Param('appName') appName: string,
  ): Observable<MessageEvent> {
    this.logger.log(`Starting SSE log stream for ${namespace}/${appName}`);

    // Create heartbeat observable
    const heartbeat$ = this.createHeartbeatObservable();

    // Create log stream observable
    const logs$ = this.logsService.streamLogs(namespace, appName).pipe(
      map((entry: LogEntry) => ({
        data: entry,
        type: 'log',
      })),
      catchError((error) => {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Log stream error: ${message}`);
        return of({
          data: { error: message },
          type: 'error',
        });
      }),
    );

    // Merge logs with heartbeat
    return merge(logs$, heartbeat$).pipe(
      finalize(() => {
        this.logger.log(`SSE stream closed for ${namespace}/${appName}`);
      }),
    );
  }

  /**
   * Create heartbeat observable that sends keepalive every 30 seconds
   */
  private createHeartbeatObservable(): Observable<MessageEvent> {
    const subject = new Subject<MessageEvent>();

    const interval = setInterval(() => {
      subject.next({
        data: { type: 'keepalive', timestamp: new Date().toISOString() },
        type: 'heartbeat',
      });
    }, HEARTBEAT_INTERVAL);

    // Clean up interval when subject completes
    subject.subscribe({
      complete: () => clearInterval(interval),
      error: () => clearInterval(interval),
    });

    // Send initial heartbeat immediately
    setTimeout(() => {
      subject.next({
        data: { type: 'connected', timestamp: new Date().toISOString() },
        type: 'heartbeat',
      });
    }, 0);

    return subject.asObservable();
  }
}
