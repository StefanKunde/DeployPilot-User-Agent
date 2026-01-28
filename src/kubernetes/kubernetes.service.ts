import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

@Injectable()
export class KubernetesService {
  private readonly logger = new Logger(KubernetesService.name);

  async executeCommand(command: string, timeoutMs = 120000): Promise<CommandResult> {
    this.logger.debug(`Executing: ${command}`);

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      this.logger.debug(`Command succeeded: ${command}`);
      return {
        success: true,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      };
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string; message: string };
      this.logger.error(`Command failed: ${command}`, execError.message);

      return {
        success: false,
        stdout: execError.stdout?.trim() || '',
        stderr: execError.stderr?.trim() || '',
        error: execError.message,
      };
    }
  }

  // Helper Scripts (existing on server)
  async createNamespace(userId: string, githubToken?: string): Promise<CommandResult> {
    const cmd = githubToken
      ? `deploypilot-create-namespace ${this.escapeArg(userId)} ${this.escapeArg(githubToken)}`
      : `deploypilot-create-namespace ${this.escapeArg(userId)}`;

    return this.executeCommand(cmd);
  }

  async deployApp(
    namespace: string,
    appName: string,
    image: string,
    port?: number,
    customDomain?: string,
  ): Promise<CommandResult> {
    let cmd = `deploypilot-deploy-app ${this.escapeArg(namespace)} ${this.escapeArg(appName)} ${this.escapeArg(image)}`;

    if (port) {
      cmd += ` ${port}`;
    }

    if (customDomain) {
      cmd += ` ${this.escapeArg(customDomain)}`;
    }

    return this.executeCommand(cmd, 300000); // 5 min timeout for deployments
  }

  async deleteApp(namespace: string, appName: string): Promise<CommandResult> {
    const cmd = `deploypilot-delete-app ${this.escapeArg(namespace)} ${this.escapeArg(appName)}`;
    return this.executeCommand(cmd);
  }

  // kubectl commands
  async restartDeployment(namespace: string, appName: string): Promise<CommandResult> {
    const cmd = `kubectl rollout restart deployment/${this.escapeArg(appName)} -n ${this.escapeArg(namespace)}`;
    return this.executeCommand(cmd);
  }

  async stopDeployment(namespace: string, appName: string): Promise<CommandResult> {
    const cmd = `kubectl scale deployment/${this.escapeArg(appName)} --replicas=0 -n ${this.escapeArg(namespace)}`;
    return this.executeCommand(cmd);
  }

  async setEnvVars(
    namespace: string,
    appName: string,
    envVars: Record<string, string>,
  ): Promise<CommandResult> {
    if (Object.keys(envVars).length === 0) {
      return {
        success: true,
        stdout: 'No environment variables to set',
        stderr: '',
      };
    }

    const envArgs = Object.entries(envVars)
      .map(([key, value]) => `${this.escapeArg(key)}=${this.escapeArg(value)}`)
      .join(' ');

    const cmd = `kubectl set env deployment/${this.escapeArg(appName)} ${envArgs} -n ${this.escapeArg(namespace)}`;
    return this.executeCommand(cmd);
  }

  async deleteDeployment(namespace: string, appName: string): Promise<CommandResult> {
    // Delete deployment, service, and ingress
    const commands = [
      `kubectl delete deployment ${this.escapeArg(appName)} -n ${this.escapeArg(namespace)} --ignore-not-found`,
      `kubectl delete service ${this.escapeArg(appName)} -n ${this.escapeArg(namespace)} --ignore-not-found`,
      `kubectl delete ingress ${this.escapeArg(appName)} -n ${this.escapeArg(namespace)} --ignore-not-found`,
    ];

    const results: CommandResult[] = [];
    for (const cmd of commands) {
      results.push(await this.executeCommand(cmd));
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      return {
        success: false,
        stdout: results.map((r) => r.stdout).join('\n'),
        stderr: results.map((r) => r.stderr).join('\n'),
        error: failed.map((r) => r.error).join('; '),
      };
    }

    return {
      success: true,
      stdout: results.map((r) => r.stdout).join('\n'),
      stderr: results.map((r) => r.stderr).join('\n'),
    };
  }

  async getDeploymentStatus(namespace: string, appName: string): Promise<CommandResult> {
    const cmd = `kubectl get deployment ${this.escapeArg(appName)} -n ${this.escapeArg(namespace)} -o json`;
    return this.executeCommand(cmd);
  }

  async getPodLogs(namespace: string, appName: string, tailLines = 100): Promise<CommandResult> {
    const cmd = `kubectl logs -l app=${this.escapeArg(appName)} -n ${this.escapeArg(namespace)} --tail=${tailLines}`;
    return this.executeCommand(cmd);
  }

  private escapeArg(arg: string): string {
    // Escape shell special characters
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}
