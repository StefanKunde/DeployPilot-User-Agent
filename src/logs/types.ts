export interface LogEntry {
  timestamp: string;
  message: string;
  podName: string;
}

export interface LogsResponse {
  logs: LogEntry[];
  podCount: number;
}

export interface LogsQueryDto {
  tail?: number;
  since?: string;
}
