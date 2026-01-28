export interface AppConfig {
  serverToken: string;
  backendUrl: string;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  logLevel: string;
  maxConcurrentCommands: number;
  port: number;
}

export default (): AppConfig => ({
  serverToken: process.env.SERVER_TOKEN || '',
  backendUrl: process.env.BACKEND_URL || 'https://api.deploypilot.stefankunde.dev',
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000', 10),
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '30000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  maxConcurrentCommands: parseInt(process.env.MAX_CONCURRENT_COMMANDS || '3', 10),
  port: parseInt(process.env.PORT || '3000', 10),
});
