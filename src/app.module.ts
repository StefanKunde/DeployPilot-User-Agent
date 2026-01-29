import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { ApiClientModule } from './api-client';
import { HeartbeatModule } from './heartbeat';
import { KubernetesModule } from './kubernetes';
import { BuildModule } from './build';
import { CommandProcessorModule } from './command-processor';
import { HealthModule } from './health';
import { LogStreamModule } from './log-stream';
import { LogsModule } from './logs';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ScheduleModule.forRoot(),
    LogStreamModule,
    ApiClientModule,
    HeartbeatModule,
    KubernetesModule,
    BuildModule,
    CommandProcessorModule,
    HealthModule,
    LogsModule,
  ],
})
export class AppModule {}
