import { Module, Global } from '@nestjs/common';
import { BuildService } from './build.service';

@Global()
@Module({
  providers: [BuildService],
  exports: [BuildService],
})
export class BuildModule {}
