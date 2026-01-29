import { Injectable, Logger } from '@nestjs/common';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Framework } from '../api-client/types';
import { LogStreamService, LogLevel, LogStep } from '../log-stream';

const execAsync = promisify(exec);

const BUILD_DIR = '/tmp/deploypilot-builds';
const BUILD_TIMEOUT = 10 * 60 * 1000; // 10 minutes

type PackageManager = 'npm' | 'pnpm' | 'yarn';

interface PackageManagerInfo {
  manager: PackageManager;
  hasLockfile: boolean;
}

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
  gitToken?: string;
  framework: Framework;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  port: number;
  envVars: Record<string, string>;
  nuxtMajorVersion?: number;
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
        config.gitToken,
      );
      logs.push(cloneResult.output);

      if (!cloneResult.success) {
        // Mask token in error message
        const safeError = this.maskToken(cloneResult.error || 'Unknown error');
        const safeOutput = this.maskToken(cloneResult.output);
        this.logStream.sendLog(config.deploymentId, `Clone output:\n${safeOutput}`, 'error', 'clone');
        log(`Failed to clone repository: ${safeError}`, 'error', 'clone');
        throw new Error(`Git clone failed: ${safeError}`);
      }
      log(`Repository cloned successfully`, 'info', 'clone');

      // Step 3: Detect package manager and framework details
      const pmInfo = await this.detectPackageManager(buildDir);
      log(`Detected package manager: ${pmInfo.manager}${pmInfo.hasLockfile ? '' : ' (no lockfile)'}`, 'info', 'build');
      if (!pmInfo.hasLockfile) {
        log('No lockfile found, using npm install (slower, less reproducible)', 'warn', 'build');
      }
      const packageManager = pmInfo.manager;

      // Detect port from package.json start script if not explicitly set
      const detectedPort = await this.detectPortFromPackageJson(buildDir);
      if (detectedPort) {
        log(`Detected port from package.json: ${detectedPort}`, 'info', 'build');
        config.port = detectedPort;
      }

      // Detect Nuxt version if applicable
      if (config.framework === 'nuxt') {
        config.nuxtMajorVersion = await this.detectNuxtVersion(buildDir);
        log(`Detected Nuxt version: ${config.nuxtMajorVersion}`, 'info', 'build');
      }

      // Detect if nodejs project is actually a static site
      if (config.framework === 'nodejs' || config.framework === 'static') {
        const staticCheck = await this.detectStaticSite(buildDir);
        if (staticCheck.isStatic) {
          log(`Detected static site generator - will serve with nginx (output: ${staticCheck.outputDir})`, 'info', 'build');
          config.framework = 'static';
          config.outputDirectory = staticCheck.outputDir;
        }
      }

      // Step 4: Generate Dockerfile if needed
      const dockerfilePath = path.join(buildDir, 'Dockerfile');
      const dockerfileExists = await this.fileExists(dockerfilePath);

      if (config.framework !== 'docker' || !dockerfileExists) {
        log(`Generating Dockerfile for framework: ${config.framework} (package manager: ${packageManager})`, 'info', 'build');
        const dockerfile = this.generateDockerfile(config, packageManager, pmInfo.hasLockfile);
        await fs.writeFile(dockerfilePath, dockerfile, 'utf8');
      } else {
        log('Using existing Dockerfile from repository', 'info', 'build');
      }

      // Step 5: Build Docker image (with real-time log streaming)
      log(`Building Docker image...`, 'info', 'build');
      const buildStartTime = Date.now();
      const buildResult = await this.buildImage(imageTag, buildDir, config.deploymentId);
      logs.push(buildResult.output);

      if (!buildResult.success) {
        // Stream last 20 lines of output for debugging
        const errorOutput = buildResult.output.split('\n').filter(l => l.trim()).slice(-20).join('\n');
        this.logStream.sendLog(config.deploymentId, `Build output (last 20 lines):\n${errorOutput}`, 'error', 'build');
        log(`Docker build failed: ${buildResult.error}`, 'error', 'build');
        throw new Error(`Docker build failed: ${buildResult.error}`);
      }
      const buildDuration = Math.round((Date.now() - buildStartTime) / 1000);
      log(`Docker image built successfully in ${buildDuration}s`, 'info', 'build');

      // Step 6: Import image to K3s
      log(`Importing image to K3s...`, 'info', 'deploy');
      const importResult = await this.importImageToK3s(imageTag);
      logs.push(importResult.output);

      if (!importResult.success) {
        this.logStream.sendLog(config.deploymentId, `K3s import error: ${importResult.output}`, 'error', 'deploy');
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
    token?: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    // Use authenticated URL if token is provided
    const authUrl = this.getAuthenticatedGitUrl(url, token);
    const cmd = `git clone --depth 1 --branch ${this.escapeArg(branch)} ${this.escapeArg(authUrl)} ${this.escapeArg(targetDir)}`;

    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 120000 });
      return {
        success: true,
        output: this.maskToken(stdout + stderr),
      };
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string; message: string };
      return {
        success: false,
        output: this.maskToken((execError.stdout || '') + (execError.stderr || '')),
        error: this.maskToken(execError.message),
      };
    }
  }

  private getAuthenticatedGitUrl(gitUrl: string, token?: string): string {
    if (!token) return gitUrl;

    try {
      const url = new URL(gitUrl);
      // GitHub uses x-access-token, GitLab uses oauth2
      if (url.hostname === 'github.com') {
        url.username = 'x-access-token';
      } else {
        url.username = 'oauth2';
      }
      url.password = token;
      return url.toString();
    } catch {
      // If URL parsing fails, try simple string replacement for GitHub
      return gitUrl.replace('https://', `https://x-access-token:${token}@`);
    }
  }

  private maskToken(text: string): string {
    // Mask tokens in URLs (x-access-token for GitHub, oauth2 for others)
    return text
      .replace(/x-access-token:[^@]+@/g, 'x-access-token:***@')
      .replace(/oauth2:[^@]+@/g, 'oauth2:***@');
  }

  generateDockerfile(config: BuildConfig, pm: PackageManager = 'npm', hasLockfile = true): string {
    const { framework, buildCommand, startCommand, outputDirectory, port } = config;
    const installBlock = this.getInstallBlock(pm, hasLockfile);
    const defaultBuildCmd = this.getRunBuildCommand(pm);

    // Static frameworks (Angular, React, Vue, Svelte, Vite) → nginx
    if (this.isStaticFramework(framework) || (framework === 'static' && outputDirectory)) {
      // Classic Svelte (without Vite) outputs to public/build
      if (framework === 'svelte') {
        return this.generateSvelteClassicDockerfile(pm, installBlock, buildCommand || defaultBuildCmd);
      }
      const envBlock = this.getBuildEnvBlock(framework);
      return this.generateStaticDockerfile(pm, installBlock, buildCommand || defaultBuildCmd, outputDirectory || 'dist', envBlock);
    }

    // Next.js (SSR)
    if (framework === 'nextjs') {
      return this.generateNextjsDockerfile(pm, installBlock, defaultBuildCmd);
    }

    // Nuxt (SSR)
    if (framework === 'nuxt') {
      return this.generateNuxtDockerfile(pm, installBlock, defaultBuildCmd, config.nuxtMajorVersion || 3);
    }

    // NestJS (multi-stage build with devDependencies in builder)
    if (framework === 'nestjs') {
      return this.generateNestjsDockerfile(pm, buildCommand || defaultBuildCmd, port, hasLockfile);
    }

    // Node.js with startCommand
    if (framework === 'nodejs' || startCommand) {
      return this.generateNodejsDockerfile(pm, buildCommand, startCommand, port, hasLockfile);
    }

    // Fallback to static
    this.logger.warn(`Unknown framework: ${framework}, falling back to static`);
    return this.generateStaticDockerfile(pm, installBlock, buildCommand || defaultBuildCmd, outputDirectory || 'dist');
  }

  private isStaticFramework(framework: Framework): boolean {
    return [
      'angular',
      'react',
      'react-vite',
      'vue',
      'vue-vite',
      'svelte',
      'svelte-vite',
      'vite',
      'static',
    ].includes(framework);
  }

  private isLegacyWebpackFramework(framework: Framework): boolean {
    // CRA (react), Angular CLI, Vue CLI use webpack which may fail
    // with ERR_OSSL_EVP_UNSUPPORTED on Node 17+ / OpenSSL 3.0
    return ['react', 'angular', 'vue'].includes(framework);
  }

  private getBuildEnvBlock(framework: Framework): string {
    const envLines: string[] = [];

    // Legacy webpack frameworks need OpenSSL legacy provider on Node 17+
    if (['react', 'angular', 'vue'].includes(framework)) {
      envLines.push('ENV NODE_OPTIONS=--openssl-legacy-provider');
    }

    // CRA apps: override homepage setting to serve from /
    if (framework === 'react') {
      envLines.push('ENV PUBLIC_URL=/');
    }

    return envLines.join('\n');
  }

  private async detectNuxtVersion(buildDir: string): Promise<number> {
    try {
      const pkgJson = JSON.parse(
        await fs.readFile(path.join(buildDir, 'package.json'), 'utf8'),
      );
      const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
      const nuxtVersion = deps['nuxt'] || '';
      // Match major version: "^2.15.0" → 2, "^3.0.0" → 3, "2.x" → 2
      const match = nuxtVersion.match(/(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    } catch {
      this.logger.warn('Could not detect Nuxt version from package.json');
    }
    return 3; // Default to Nuxt 3
  }

  private async detectPortFromPackageJson(buildDir: string): Promise<number | null> {
    try {
      const pkgJson = JSON.parse(
        await fs.readFile(path.join(buildDir, 'package.json'), 'utf8'),
      );
      const startScript = pkgJson.scripts?.start || pkgJson.scripts?.dev || '';
      if (!startScript) return null;

      // Match patterns: PORT=5006, --port=5006, --port 5006, -p 5006, -p=5006
      const patterns = [
        /PORT=(\d+)/,
        /--port[= ](\d+)/,
        /-p[= ](\d+)/,
      ];

      for (const pattern of patterns) {
        const match = startScript.match(pattern);
        if (match) {
          return parseInt(match[1], 10);
        }
      }
    } catch {
      // No package.json or parse error
    }
    return null;
  }

  private async detectStaticSite(buildDir: string): Promise<{ isStatic: boolean; outputDir: string }> {
    try {
      const pkgJson = JSON.parse(
        await fs.readFile(path.join(buildDir, 'package.json'), 'utf8'),
      );

      const hasBuild = !!pkgJson.scripts?.build;
      if (!hasBuild) return { isStatic: false, outputDir: '' };

      const startScript = pkgJson.scripts?.start || '';

      // Start script is missing, or is just a dev server / rebuilds
      const isStaticStart =
        !startScript ||
        startScript.includes('serve') ||
        startScript.includes('live-server') ||
        startScript.includes('http-server') ||
        startScript === 'npm run build' ||
        startScript === 'yarn build' ||
        startScript === 'pnpm build';

      if (!isStaticStart) return { isStatic: false, outputDir: '' };

      // Guess output directory from common conventions
      const candidates = ['dist', 'build', 'public', 'out', '_site', 'www'];
      for (const dir of candidates) {
        if (await this.fileExists(path.join(buildDir, dir))) {
          return { isStatic: true, outputDir: dir };
        }
      }

      // Default to dist
      return { isStatic: true, outputDir: 'dist' };
    } catch {
      return { isStatic: false, outputDir: '' };
    }
  }

  private async detectPackageManager(buildDir: string): Promise<PackageManagerInfo> {
    if (await this.fileExists(path.join(buildDir, 'pnpm-lock.yaml'))) {
      return { manager: 'pnpm', hasLockfile: true };
    }
    if (await this.fileExists(path.join(buildDir, 'yarn.lock'))) {
      return { manager: 'yarn', hasLockfile: true };
    }
    const hasLockfile = await this.fileExists(path.join(buildDir, 'package-lock.json'));
    return { manager: 'npm', hasLockfile };
  }

  private getInstallBlock(pm: PackageManager, hasLockfile = true): string {
    switch (pm) {
      case 'pnpm':
        return hasLockfile
          ? 'RUN npm install -g pnpm\nRUN pnpm install --frozen-lockfile'
          : 'RUN npm install -g pnpm\nRUN pnpm install';
      case 'yarn':
        return hasLockfile
          ? 'RUN yarn install --frozen-lockfile'
          : 'RUN yarn install';
      default:
        return hasLockfile ? 'RUN npm ci' : 'RUN npm install';
    }
  }

  private getProdInstallBlock(pm: PackageManager, hasLockfile = true): string {
    switch (pm) {
      case 'pnpm':
        return hasLockfile
          ? 'RUN npm install -g pnpm\nRUN pnpm install --frozen-lockfile --prod'
          : 'RUN npm install -g pnpm\nRUN pnpm install --prod';
      case 'yarn':
        return hasLockfile
          ? 'RUN yarn install --frozen-lockfile --production'
          : 'RUN yarn install --production';
      default:
        return hasLockfile ? 'RUN npm ci --omit=dev' : 'RUN npm install --omit=dev';
    }
  }

  private getRunBuildCommand(pm: PackageManager): string {
    switch (pm) {
      case 'pnpm':
        return 'pnpm run build';
      case 'yarn':
        return 'yarn build';
      default:
        return 'npm run build';
    }
  }

  private getStartCommand(pm: PackageManager): string {
    switch (pm) {
      case 'pnpm':
        return 'pnpm start';
      case 'yarn':
        return 'yarn start';
      default:
        return 'npm start';
    }
  }

  private getLockfileCopyLine(_pm: PackageManager): string {
    // Copy all possible lockfiles - Docker COPY with glob ignores missing files
    return 'COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc* yarn.lock* package-lock.json* ./';
  }

  private generateStaticDockerfile(
    pm: PackageManager,
    installBlock: string,
    buildCmd: string,
    outputDirectory: string,
    envBlock: string = '',
  ): string {
    const copyLockfiles = this.getLockfileCopyLine(pm);
    const envLine = envBlock ? `${envBlock}\n` : '';

    // Use a smart copy script that finds index.html dynamically
    // This handles Angular 17+ which builds to dist/{project}/browser/
    return `# Auto-generated Dockerfile for static site
FROM node:20-alpine AS builder
WORKDIR /app
${copyLockfiles}
${installBlock}
COPY . .
${envLine}RUN ${buildCmd}

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

  private generateNextjsDockerfile(
    pm: PackageManager,
    installBlock: string,
    buildCmd: string,
  ): string {
    const copyLockfiles = this.getLockfileCopyLine(pm);
    const startCmd = this.getStartCommand(pm);

    return `# Auto-generated Dockerfile for Next.js
FROM node:20-alpine AS builder
WORKDIR /app
${copyLockfiles}
${installBlock}
COPY . .
# Ensure public folder exists (may be missing in some projects)
RUN mkdir -p public
RUN ${buildCmd}

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ${JSON.stringify(startCmd.split(' '))}
`;
  }

  private generateNuxtDockerfile(
    pm: PackageManager,
    installBlock: string,
    buildCmd: string,
    nuxtMajorVersion: number,
  ): string {
    const copyLockfiles = this.getLockfileCopyLine(pm);

    if (nuxtMajorVersion <= 2) {
      // Nuxt 2: builds to .nuxt/, needs full node_modules at runtime
      return `# Auto-generated Dockerfile for Nuxt 2
FROM node:20-alpine AS builder
WORKDIR /app
${copyLockfiles}
${installBlock}
COPY . .
ENV NODE_OPTIONS=--openssl-legacy-provider
RUN ${buildCmd}

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app ./
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["npx", "nuxt", "start"]
`;
    }

    // Nuxt 3: builds to .output/, standalone server
    return `# Auto-generated Dockerfile for Nuxt 3
FROM node:20-alpine AS builder
WORKDIR /app
${copyLockfiles}
${installBlock}
COPY . .
RUN ${buildCmd}

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/.output /app/.output
COPY --from=builder /app/package*.json ./
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
`;
  }

  private generateSvelteClassicDockerfile(
    pm: PackageManager,
    installBlock: string,
    buildCmd: string,
  ): string {
    const copyLockfiles = this.getLockfileCopyLine(pm);

    return `# Auto-generated Dockerfile for Svelte (classic)
FROM node:20-alpine AS builder
WORKDIR /app
${copyLockfiles}
${installBlock}
COPY . .
RUN ${buildCmd}

FROM nginx:alpine
# Svelte classic outputs to public/build, copy entire public folder
COPY --from=builder /app/public /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;
  }

  private generateNestjsDockerfile(
    pm: PackageManager,
    buildCmd: string,
    port: number,
    hasLockfile = true,
  ): string {
    const copyLockfiles = this.getLockfileCopyLine(pm);
    const installBlock = this.getInstallBlock(pm, hasLockfile);

    return `# Auto-generated Dockerfile for NestJS
FROM node:20-alpine AS builder
WORKDIR /app
${copyLockfiles}
${installBlock}
COPY . .
RUN ${buildCmd}

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
ENV NODE_ENV=production
EXPOSE ${port}
CMD ["node", "dist/main"]
`;
  }

  private generateNodejsDockerfile(
    pm: PackageManager,
    buildCommand: string | null,
    startCommand: string | null,
    port: number,
    hasLockfile = true,
  ): string {
    const copyLockfiles = this.getLockfileCopyLine(pm);
    const cmdArray = this.parseStartCommand(startCommand || this.getStartCommand(pm));

    if (buildCommand) {
      // Multi-stage: install all deps (incl. devDependencies) for build, then copy result
      const installBlock = this.getInstallBlock(pm, hasLockfile);

      return `# Auto-generated Dockerfile for Node.js (with build step)
FROM node:20-alpine AS builder
WORKDIR /app
${copyLockfiles}
${installBlock}
COPY . .
RUN ${buildCommand}

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app ./
RUN npm prune --omit=dev 2>/dev/null; true
ENV NODE_ENV=production
EXPOSE ${port}
CMD ${JSON.stringify(cmdArray)}
`;
    }

    // No build step: install production deps only
    const prodInstallBlock = this.getProdInstallBlock(pm, hasLockfile);

    return `# Auto-generated Dockerfile for Node.js
FROM node:20-alpine
WORKDIR /app
${copyLockfiles}
${prodInstallBlock}
COPY . .
ENV NODE_ENV=production
EXPOSE ${port}
CMD ${JSON.stringify(cmdArray)}
`;
  }

  private parseStartCommand(command: string): string[] {
    return command.split(' ').filter(Boolean);
  }

  private buildImage(
    imageTag: string,
    buildDir: string,
    deploymentId: string,
  ): Promise<{ success: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
      const args = ['build', '-t', imageTag, buildDir];
      const proc = spawn('docker', args);
      let output = '';
      let lineBuffer = '';

      const streamLine = (line: string) => {
        const trimmed = line.trim();
        if (trimmed) {
          this.logStream.sendLog(deploymentId, trimmed, 'info', 'build');
        }
      };

      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        lineBuffer += text;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        lines.forEach(streamLine);
      });

      proc.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        // Docker outputs build steps to stderr - stream them
        lineBuffer += text;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        lines.forEach(streamLine);
      });

      // Timeout
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve({
          success: false,
          output,
          error: `Docker build timed out after ${BUILD_TIMEOUT / 1000}s`,
        });
      }, BUILD_TIMEOUT);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        // Flush remaining buffer
        if (lineBuffer.trim()) {
          streamLine(lineBuffer);
        }
        resolve({
          success: code === 0,
          output,
          error: code !== 0 ? `Docker build exited with code ${code}` : undefined,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          success: false,
          output,
          error: err.message,
        });
      });
    });
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
