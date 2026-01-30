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
  AddCustomDomainHandler,
  RemoveCustomDomainHandler,
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
    AddCustomDomainHandler,
    RemoveCustomDomainHandler,
  ],
  exports: [CommandProcessorService],
})
export class CommandProcessorModule {}
