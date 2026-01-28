import { Controller, Get } from '@nestjs/common';
import { ApiClientService } from '../api-client';

interface HealthStatus {
  status: 'ok' | 'degraded';
  timestamp: string;
  registered: boolean;
  agentId: string | null;
}

@Controller('health')
export class HealthController {
  constructor(private readonly apiClient: ApiClientService) {}

  @Get()
  getHealth(): HealthStatus {
    const registered = this.apiClient.isRegistered();

    return {
      status: registered ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      registered,
      agentId: this.apiClient.getAgentId(),
    };
  }
}
