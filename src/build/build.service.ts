import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Framework } from '../api-client/types';

const execAsync = promisify(exec);

const BUILD_DIR = '/tmp/deploypilot-builds';
const BUILD_TIMEOUT = 10 * 60 * 1000; // 10 minutes

export interface BuildResult {
  success: boolean;
  imageName: string;
  logs: string;
  error?: string;
}

export interface BuildConfig {
  appName: string;
  deploymentId: string;
  gitRepoUrl: string;
  gitBranch: string;
  framework: Framework;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  port: number;
  envVars: Record<string, string>;
}

@Injectable()
export class BuildService {
  private readonly logger = new Logger(BuildService.name);

  async build(config: BuildConfig): Promise<BuildResult> {
    const buildDir = path.join(BUILD_DIR, config.appName);
    const imageTag = `${config.appName}:${config.deploymentId}`;
    const logs: string[] = [];

    const log = (message: string) => {
      this.logger.log(message);
      logs.push(`[${new Date().toISOString()}] ${message}`);
    };

    try {
      // Step 1: Prepare build directory
      log(`Preparing build directory: ${buildDir}`);
      await this.prepareBuildDir(buildDir);

      // Step 2: Clone repository
      log(`Cloning repository: ${config.gitRepoUrl} (branch: ${config.gitBranch})`);
      const cloneResult = await this.cloneRepository(
        config.gitRepoUrl,
        config.gitBranch,
        buildDir,
      );
      logs.push(cloneResult.output);

      if (!cloneResult.success) {
        throw new Error(`Git clone failed: ${cloneResult.error}`);
      }

      // Step 3: Generate Dockerfile if needed
      const dockerfilePath = path.join(buildDir, 'Dockerfile');
      const dockerfileExists = await this.fileExists(dockerfilePath);

      if (config.framework !== 'docker' || !dockerfileExists) {
        log(`Generating Dockerfile for framework: ${config.framework}`);
        const dockerfile = this.generateDockerfile(config);
        await fs.writeFile(dockerfilePath, dockerfile);
        logs.push('Generated Dockerfile:\n' + dockerfile);
      } else {
        log('Using existing Dockerfile from repository');
      }

      // Step 4: Build Docker image
      log(`Building Docker image: ${imageTag}`);
      const buildResult = await this.buildImage(imageTag, buildDir);
      logs.push(buildResult.output);

      if (!buildResult.success) {
        throw new Error(`Docker build failed: ${buildResult.error}`);
      }

      // Step 5: Import image to K3s
      log(`Importing image to K3s: ${imageTag}`);
      const importResult = await this.importImageToK3s(imageTag);
      logs.push(importResult.output);

      if (!importResult.success) {
        throw new Error(`Image import failed: ${importResult.error}`);
      }

      log(`Build completed successfully: ${imageTag}`);

      return {
        success: true,
        imageName: `docker.io/library/${imageTag}`,
        logs: logs.join('\n'),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Build failed: ${errorMessage}`);
      logs.push(`ERROR: ${errorMessage}`);

      return {
        success: false,
        imageName: '',
        logs: logs.join('\n'),
        error: errorMessage,
      };
    } finally {
      // Cleanup
      try {
        await this.cleanup(buildDir);
      } catch {
        this.logger.warn(`Failed to cleanup build directory: ${buildDir}`);
      }
    }
  }

  private async prepareBuildDir(buildDir: string): Promise<void> {
    await fs.mkdir(BUILD_DIR, { recursive: true });
    // Remove if exists
    try {
      await fs.rm(buildDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  }

  private async cloneRepository(
    url: string,
    branch: string,
    targetDir: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const cmd = `git clone --depth 1 --branch ${this.escapeArg(branch)} ${this.escapeArg(url)} ${this.escapeArg(targetDir)}`;

    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 120000 });
      return {
        success: true,
        output: stdout + stderr,
      };
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string; message: string };
      return {
        success: false,
        output: (execError.stdout || '') + (execError.stderr || ''),
        error: execError.message,
      };
    }
  }

  generateDockerfile(config: BuildConfig): string {
    const { framework, buildCommand, startCommand, outputDirectory, port } = config;

    // Static frameworks (Angular, React, Vue) with outputDirectory
    if (this.isStaticFramework(framework) || (framework === 'static' && outputDirectory)) {
      return this.generateStaticDockerfile(buildCommand, outputDirectory || 'dist');
    }

    // Next.js
    if (framework === 'nextjs') {
      return this.generateNextjsDockerfile();
    }

    // Node.js / NestJS with startCommand
    if (framework === 'nodejs' || framework === 'nestjs' || startCommand) {
      return this.generateNodejsDockerfile(buildCommand, startCommand, port);
    }

    // Fallback to static
    return this.generateStaticDockerfile(buildCommand, outputDirectory || 'dist');
  }

  private isStaticFramework(framework: Framework): boolean {
    return ['angular', 'react', 'vue', 'static'].includes(framework);
  }

  private generateStaticDockerfile(buildCommand: string | null, outputDirectory: string): string {
    const buildCmd = buildCommand || 'npm run build';

    return `# Auto-generated Dockerfile for static site
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN ${buildCmd}

FROM nginx:alpine
COPY --from=builder /app/${outputDirectory} /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;
  }

  private generateNextjsDockerfile(): string {
    return `# Auto-generated Dockerfile for Next.js
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/public ./public 2>/dev/null || true
EXPOSE 3000
CMD ["npm", "start"]
`;
  }

  private generateNodejsDockerfile(
    buildCommand: string | null,
    startCommand: string | null,
    port: number,
  ): string {
    const buildStep = buildCommand ? `RUN ${buildCommand}` : '';
    const cmdArray = this.parseStartCommand(startCommand || 'npm start');

    return `# Auto-generated Dockerfile for Node.js
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
${buildStep}
EXPOSE ${port}
CMD ${JSON.stringify(cmdArray)}
`;
  }

  private parseStartCommand(command: string): string[] {
    // Simple parsing - split by spaces, handling quoted strings would be more complex
    return command.split(' ').filter(Boolean);
  }

  private async buildImage(
    imageTag: string,
    buildDir: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    const cmd = `docker build -t ${this.escapeArg(imageTag)} ${this.escapeArg(buildDir)}`;

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: BUILD_TIMEOUT,
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for build output
      });
      return {
        success: true,
        output: stdout + stderr,
      };
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string; message: string };
      return {
        success: false,
        output: (execError.stdout || '') + (execError.stderr || ''),
        error: execError.message,
      };
    }
  }

  private async importImageToK3s(
    imageTag: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    // Save image and import to K3s containerd using k3s ctr
    const cmd = `docker save ${this.escapeArg(imageTag)} | k3s ctr images import -`;

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 300000, // 5 min for large images
        maxBuffer: 10 * 1024 * 1024,
      });
      return {
        success: true,
        output: stdout + stderr,
      };
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string; message: string };
      return {
        success: false,
        output: (execError.stdout || '') + (execError.stderr || ''),
        error: execError.message,
      };
    }
  }

  private async cleanup(buildDir: string): Promise<void> {
    this.logger.debug(`Cleaning up: ${buildDir}`);
    await fs.rm(buildDir, { recursive: true, force: true });
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private escapeArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
}
