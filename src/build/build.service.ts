import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Framework } from '../api-client/types';
import { LogStreamService, LogLevel, LogStep } from '../log-stream';

const execAsync = promisify(exec);

const BUILD_DIR = '/tmp/deploypilot-builds';
const BUILD_TIMEOUT = 10 * 60 * 1000; // 10 minutes

export interface BuildResult {
  success: boolean;
  imageName: string;
  exposedPort: number;
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

  constructor(private readonly logStream: LogStreamService) {}

  async build(config: BuildConfig): Promise<BuildResult> {
    const buildDir = path.join(BUILD_DIR, config.appName);
    const imageTag = `${config.appName}:${config.deploymentId}`;
    const logs: string[] = [];
    const startTime = Date.now();

    const log = (message: string, level: LogLevel = 'info', step: LogStep = 'general') => {
      this.logger.log(message);
      logs.push(`[${new Date().toISOString()}] ${message}`);
      this.logStream.sendLog(config.deploymentId, message, level, step);
    };

    try {
      // Step 1: Prepare build directory
      log(`Preparing build directory...`, 'info', 'general');
      await this.prepareBuildDir(buildDir);

      // Step 2: Clone repository
      log(`Cloning repository from ${config.gitRepoUrl} (branch: ${config.gitBranch})...`, 'info', 'clone');
      const cloneResult = await this.cloneRepository(
        config.gitRepoUrl,
        config.gitBranch,
        buildDir,
      );
      logs.push(cloneResult.output);

      if (!cloneResult.success) {
        log(`Failed to clone repository: ${cloneResult.error}`, 'error', 'clone');
        throw new Error(`Git clone failed: ${cloneResult.error}`);
      }
      log(`Repository cloned successfully`, 'info', 'clone');

      // Step 3: Generate Dockerfile if needed
      const dockerfilePath = path.join(buildDir, 'Dockerfile');
      const dockerfileExists = await this.fileExists(dockerfilePath);

      if (config.framework !== 'docker' || !dockerfileExists) {
        log(`Generating Dockerfile for framework: ${config.framework}`, 'info', 'build');
        const dockerfile = this.generateDockerfile(config);
        await fs.writeFile(dockerfilePath, dockerfile);
        logs.push('Generated Dockerfile:\n' + dockerfile);
      } else {
        log('Using existing Dockerfile from repository', 'info', 'build');
      }

      // Step 4: Build Docker image
      log(`Building Docker image...`, 'info', 'build');
      const buildStartTime = Date.now();
      const buildResult = await this.buildImage(imageTag, buildDir);
      logs.push(buildResult.output);

      if (!buildResult.success) {
        log(`Docker build failed: ${buildResult.error}`, 'error', 'build');
        throw new Error(`Docker build failed: ${buildResult.error}`);
      }
      const buildDuration = Math.round((Date.now() - buildStartTime) / 1000);
      log(`Docker image built successfully in ${buildDuration}s`, 'info', 'build');

      // Step 5: Import image to K3s
      log(`Importing image to K3s...`, 'info', 'deploy');
      const importResult = await this.importImageToK3s(imageTag);
      logs.push(importResult.output);

      if (!importResult.success) {
        log(`Failed to import image to K3s: ${importResult.error}`, 'error', 'deploy');
        throw new Error(`Image import failed: ${importResult.error}`);
      }
      log(`Image imported to K3s successfully`, 'info', 'deploy');

      // Step 6: Detect exposed port from image
      const exposedPort = await this.detectExposedPort(imageTag, config.port);
      log(`Detected container port: ${exposedPort}`, 'info', 'build');

      const totalDuration = Math.round((Date.now() - startTime) / 1000);
      log(`Build completed successfully in ${totalDuration}s`, 'info', 'general');

      return {
        success: true,
        imageName: `docker.io/library/${imageTag}`,
        exposedPort,
        logs: logs.join('\n'),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Build failed: ${errorMessage}`);
      logs.push(`ERROR: ${errorMessage}`);
      this.logStream.sendLog(config.deploymentId, `Build failed: ${errorMessage}`, 'error', 'build');

      return {
        success: false,
        imageName: '',
        exposedPort: config.port,
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
    return ['angular', 'react', 'react-vite', 'vue', 'static'].includes(framework);
  }

  private generateStaticDockerfile(buildCommand: string | null, outputDirectory: string): string {
    const buildCmd = buildCommand || 'npm run build';

    // Use a smart copy script that finds index.html dynamically
    // This handles Angular 17+ which builds to dist/{project}/browser/
    return `# Auto-generated Dockerfile for static site
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN ${buildCmd}

# Find the actual output directory containing index.html
RUN OUTPUT_DIR=$(find /app/${outputDirectory} -name "index.html" -type f 2>/dev/null | head -1 | xargs dirname 2>/dev/null) && \\
    if [ -z "$OUTPUT_DIR" ]; then OUTPUT_DIR="/app/${outputDirectory}"; fi && \\
    mkdir -p /app/_output && \\
    cp -r "$OUTPUT_DIR"/* /app/_output/

FROM nginx:alpine
COPY --from=builder /app/_output /usr/share/nginx/html
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

  private async detectExposedPort(imageTag: string, fallbackPort: number): Promise<number> {
    try {
      // Inspect the Docker image to find exposed ports
      const cmd = `docker inspect ${this.escapeArg(imageTag)} --format='{{range $p, $conf := .Config.ExposedPorts}}{{$p}} {{end}}'`;
      const { stdout } = await execAsync(cmd, { timeout: 10000 });

      // Parse output like "80/tcp 443/tcp " - take the first port
      const portMatch = stdout.trim().match(/(\d+)\/tcp/);
      if (portMatch) {
        const detectedPort = parseInt(portMatch[1], 10);
        this.logger.log(`Detected exposed port from image: ${detectedPort}`);
        return detectedPort;
      }

      this.logger.log(`No exposed port found in image, using fallback: ${fallbackPort}`);
      return fallbackPort;
    } catch (error) {
      this.logger.warn(`Failed to detect exposed port: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return fallbackPort;
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
