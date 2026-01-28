import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Validate required environment variables
  const serverToken = process.env.SERVER_TOKEN;
  if (!serverToken) {
    logger.error('SERVER_TOKEN environment variable is required');
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule, {
    logger: getLogLevels(process.env.LOG_LEVEL),
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('port', 3000);

  // Graceful shutdown
  app.enableShutdownHooks();

  process.on('SIGTERM', () => {
    logger.log('Received SIGTERM signal, initiating graceful shutdown...');
  });

  process.on('SIGINT', () => {
    logger.log('Received SIGINT signal, initiating graceful shutdown...');
  });

  await app.listen(port);

  logger.log(`DeployPilot Agent started on port ${port}`);
  logger.log(`Health check available at http://localhost:${port}/health`);
}

function getLogLevels(level?: string): ('log' | 'error' | 'warn' | 'debug' | 'verbose')[] {
  const levels: ('log' | 'error' | 'warn' | 'debug' | 'verbose')[] = ['error'];

  switch (level?.toLowerCase()) {
    case 'verbose':
      levels.push('verbose');
    // fallthrough
    case 'debug':
      levels.push('debug');
    // fallthrough
    case 'info':
    case 'log':
      levels.push('log');
    // fallthrough
    case 'warn':
      levels.push('warn');
      break;
    default:
      levels.push('warn', 'log');
  }

  return levels;
}

bootstrap().catch((error) => {
  console.error('Failed to start DeployPilot Agent:', error);
  process.exit(1);
});
