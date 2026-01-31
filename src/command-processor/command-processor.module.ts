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
  CreateDatabaseHandler,
  DeleteDatabaseHandler,
  UpdateDatabasePasswordHandler,
  EnableDatabaseExternalAccessHandler,
  DisableDatabaseExternalAccessHandler,
  CreateBackupHandler,
  RestoreBackupHandler,
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
    CreateDatabaseHandler,
    DeleteDatabaseHandler,
    UpdateDatabasePasswordHandler,
    EnableDatabaseExternalAccessHandler,
    DisableDatabaseExternalAccessHandler,
    CreateBackupHandler,
    RestoreBackupHandler,
  ],
  exports: [CommandProcessorService],
})
export class CommandProcessorModule {}
