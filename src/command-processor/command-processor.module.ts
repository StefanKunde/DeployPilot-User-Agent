import { Module } from '@nestjs/common';
import { CommandProcessorService } from './command-processor.service';
import { HeartbeatModule } from '../heartbeat';
import {
  DeployHandler,
  StopHandler,
  RestartHandler,
  DeleteHandler,
  CreateNamespaceHandler,
  UpdateEnvHandler,
} from './handlers';

@Module({
  imports: [HeartbeatModule],
  providers: [
    CommandProcessorService,
    DeployHandler,
    StopHandler,
    RestartHandler,
    DeleteHandler,
    CreateNamespaceHandler,
    UpdateEnvHandler,
  ],
  exports: [CommandProcessorService],
})
export class CommandProcessorModule {}
