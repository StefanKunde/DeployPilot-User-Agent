import { Module } from '@nestjs/common';
import { ApiClientModule } from '../api-client';
import { KubernetesModule } from '../kubernetes';
import { ResourceCollectorService } from './resource-collector.service';

@Module({
  imports: [ApiClientModule, KubernetesModule],
  providers: [ResourceCollectorService],
})
export class ResourceCollectorModule {}
