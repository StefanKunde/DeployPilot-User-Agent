import { Global, Module } from '@nestjs/common';
import { LogStreamService } from './log-stream.service';

@Global()
@Module({
  providers: [LogStreamService],
  exports: [LogStreamService],
})
export class LogStreamModule {}
