import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  Command,
  CommandResultRequest,
  CommandResultResponse,
  AckResponse,
  RunningResponse,
  BackendConfig,
} from './types';

@Injectable()
export class ApiClientService implements OnModuleInit {
  private readonly logger = new Logger(ApiClientService.name);
  private client: AxiosInstance;
  private registered = false;
  private agentId: string | null = null;

  constructor(private readonly configService: ConfigService) {
    const backendUrl = this.configService.get<string>('backendUrl');
    const serverToken = this.configService.get<string>('serverToken');

    this.client = axios.create({
      baseURL: `${backendUrl}/api/agents`,
      headers: {
        'Content-Type': 'application/json',
        'X-Server-Token': serverToken,
      },
      timeout: 30000,
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        this.logger.error(
          `API Error: ${error.message}`,
          error.response?.data ? JSON.stringify(error.response.data) : '',
        );
        throw error;
      },
    );
  }

  async onModuleInit(): Promise<void> {
    await this.registerWithRetry();
  }

  private async registerWithRetry(maxRetries = 10): Promise<void> {
    let attempt = 0;
    let delay = 1000;

    while (attempt < maxRetries) {
      try {
        await this.register();
        return;
      } catch (error) {
        attempt++;
        this.logger.warn(
          `Registration attempt ${attempt}/${maxRetries} failed. Retrying in ${delay}ms...`,
        );
        await this.sleep(delay);
        delay = Math.min(delay * 2, 60000); // Max 60s delay
      }
    }

    this.logger.error('Failed to register after maximum retries. Will continue trying in background.');
  }

  private async register(): Promise<RegisterResponse> {
    const hostname = await this.getHostname();
    const kubeVersion = await this.getKubeVersion();
    const resources = await this.getSystemResources();

    const request: RegisterRequest = {
      hostname,
      kubeVersion,
      resources,
    };

    this.logger.log(`Registering agent: ${hostname}`);
    const response = await this.client.post<RegisterResponse>('/register', request);

    this.registered = true;
    this.agentId = response.data.id;
    this.logger.log(`Agent registered successfully with ID: ${this.agentId}`);

    return response.data;
  }

  async sendHeartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
    if (!this.registered) {
      await this.registerWithRetry(3);
    }

    const response = await this.client.post<HeartbeatResponse>('/heartbeat', request);
    return response.data;
  }

  async getCommands(): Promise<Command[]> {
    if (!this.registered) {
      return [];
    }

    const response = await this.client.get<Command[]>('/commands');
    return response.data;
  }

  async ackCommand(commandId: string): Promise<AckResponse> {
    const response = await this.client.patch<AckResponse>(`/commands/${commandId}/ack`);
    return response.data;
  }

  async markCommandRunning(commandId: string): Promise<RunningResponse> {
    const response = await this.client.patch<RunningResponse>(`/commands/${commandId}/running`);
    return response.data;
  }

  async sendCommandResult(
    commandId: string,
    result: CommandResultRequest,
  ): Promise<CommandResultResponse> {
    const response = await this.client.patch<CommandResultResponse>(
      `/commands/${commandId}/result`,
      result,
    );
    return response.data;
  }

  async getConfig(): Promise<BackendConfig> {
    const response = await this.client.get<BackendConfig>('/config');
    return response.data;
  }

  isRegistered(): boolean {
    return this.registered;
  }

  getAgentId(): string | null {
    return this.agentId;
  }

  private async getHostname(): Promise<string> {
    const os = await import('os');
    return os.hostname();
  }

  private async getKubeVersion(): Promise<string> {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const { stdout } = await execAsync('kubectl version --client -o json');
      const version = JSON.parse(stdout);
      return version.clientVersion?.gitVersion || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async getSystemResources(): Promise<{ cpuCores: number; ramMb: number; diskGb: number }> {
    const os = await import('os');

    return {
      cpuCores: os.cpus().length,
      ramMb: Math.floor(os.totalmem() / (1024 * 1024)),
      diskGb: 0, // Would require additional system calls
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
