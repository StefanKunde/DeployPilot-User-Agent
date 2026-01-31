import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ApiClientService } from '../api-client';
import { KubernetesService } from '../kubernetes';

const execAsync = promisify(exec);

export interface ServerResources {
  disk: {
    totalGb: number;
    usedGb: number;
    availableGb: number;
  };
  memory: {
    totalMb: number;
    usedMb: number;
    availableMb: number;
  };
  kubernetes: {
    allocatableCpu: string;
    allocatableMemoryMb: number;
    allocatableDiskGb: number;
  };
  databases: {
    count: number;
    totalStorageRequestedGb: number;
    totalMemoryRequestedMb: number;
  };
}

@Injectable()
export class ResourceCollectorService {
  private readonly logger = new Logger(ResourceCollectorService.name);

  constructor(
    private readonly apiClient: ApiClientService,
    private readonly kubernetesService: KubernetesService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async collectAndReport(): Promise<void> {
    if (!this.apiClient.isRegistered()) {
      return;
    }

    try {
      const resources = await this.collectResources();
      await this.apiClient.reportServerResources(resources);
      this.logger.debug('Server resources reported');
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to collect/report resources: ${msg}`);
    }
  }

  async collectResources(): Promise<ServerResources> {
    const [disk, memory, kubernetes, databases] = await Promise.all([
      this.collectDiskUsage(),
      this.collectMemoryUsage(),
      this.collectKubernetesResources(),
      this.collectDatabaseUsage(),
    ]);

    return { disk, memory, kubernetes, databases };
  }

  private async collectDiskUsage(): Promise<ServerResources['disk']> {
    try {
      const { stdout } = await execAsync("df -BG / | tail -1 | awk '{print $2,$3,$4}'");
      const [total, used, available] = stdout
        .trim()
        .split(' ')
        .map((s) => parseInt(s.replace('G', '')));

      return { totalGb: total, usedGb: used, availableGb: available };
    } catch (error) {
      this.logger.warn(`Failed to get disk usage: ${error instanceof Error ? error.message : error}`);
      return { totalGb: 0, usedGb: 0, availableGb: 0 };
    }
  }

  private async collectMemoryUsage(): Promise<ServerResources['memory']> {
    try {
      const { stdout } = await execAsync("free -m | grep Mem | awk '{print $2,$3,$7}'");
      const [total, used, available] = stdout.trim().split(' ').map(Number);

      return { totalMb: total, usedMb: used, availableMb: available };
    } catch (error) {
      this.logger.warn(`Failed to get memory usage: ${error instanceof Error ? error.message : error}`);
      return { totalMb: 0, usedMb: 0, availableMb: 0 };
    }
  }

  private async collectKubernetesResources(): Promise<ServerResources['kubernetes']> {
    try {
      const result = await this.kubernetesService.executeCommand(
        "kubectl get node -o jsonpath='{.items[0].status.allocatable}'",
      );

      if (!result.success) {
        throw new Error(result.error || 'kubectl failed');
      }

      const allocatable = JSON.parse(result.stdout.replace(/'/g, ''));

      const cpu = allocatable.cpu;

      const memoryKi = parseInt(allocatable.memory.replace('Ki', ''));
      const memoryMb = Math.floor(memoryKi / 1024);

      const storageBytes = parseInt(allocatable['ephemeral-storage']);
      const storageGb = Math.floor(storageBytes / 1024 / 1024 / 1024);

      return {
        allocatableCpu: cpu,
        allocatableMemoryMb: memoryMb,
        allocatableDiskGb: storageGb,
      };
    } catch (error) {
      this.logger.warn(`Failed to get K8s resources: ${error instanceof Error ? error.message : error}`);
      return { allocatableCpu: '0', allocatableMemoryMb: 0, allocatableDiskGb: 0 };
    }
  }

  private async collectDatabaseUsage(): Promise<ServerResources['databases']> {
    try {
      const countResult = await this.kubernetesService.executeCommand(
        "kubectl get statefulsets --all-namespaces -l type=database -o name 2>/dev/null | wc -l",
      );
      const count = parseInt(countResult.stdout.trim()) || 0;

      const pvcResult = await this.kubernetesService.executeCommand(
        "kubectl get pvc --all-namespaces -l type=database -o jsonpath='{.items[*].spec.resources.requests.storage}'",
      );
      const storages = pvcResult.stdout.replace(/'/g, '').trim().split(' ').filter(Boolean);
      const totalStorageGb = storages.reduce((sum, s) => {
        if (s.endsWith('Gi')) return sum + parseInt(s);
        if (s.endsWith('Mi')) return sum + parseInt(s) / 1024;
        return sum;
      }, 0);

      const memResult = await this.kubernetesService.executeCommand(
        "kubectl get statefulsets --all-namespaces -l type=database -o jsonpath='{.items[*].spec.template.spec.containers[0].resources.limits.memory}'",
      );
      const memories = memResult.stdout.replace(/'/g, '').trim().split(' ').filter(Boolean);
      const totalMemoryMb = memories.reduce((sum, m) => {
        if (m.endsWith('Gi')) return sum + parseInt(m) * 1024;
        if (m.endsWith('Mi')) return sum + parseInt(m);
        return sum;
      }, 0);

      return {
        count,
        totalStorageRequestedGb: Math.ceil(totalStorageGb),
        totalMemoryRequestedMb: totalMemoryMb,
      };
    } catch (error) {
      this.logger.warn(`Failed to get database usage: ${error instanceof Error ? error.message : error}`);
      return { count: 0, totalStorageRequestedGb: 0, totalMemoryRequestedMb: 0 };
    }
  }
}
