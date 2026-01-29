// Agent Registration
export interface RegisterRequest {
  hostname: string;
  kubeVersion: string;
  resources: ResourceInfo;
}

export interface ResourceInfo {
  cpuCores: number;
  ramMb: number;
  diskGb: number;
}

export interface RegisterResponse {
  id: string;
  name: string;
  status: string;
  config: AgentConfig;
}

export interface AgentConfig {
  appsDomain?: string;
  serverIp?: string;
  [key: string]: unknown;
}

// Heartbeat
export type AgentStatus = 'online' | 'busy' | 'error';

export interface RunningPod {
  projectId: string;
  podName: string;
  status: string;
  restarts?: number;
}

export interface HeartbeatRequest {
  status: AgentStatus;
  resources: ResourceInfo;
  runningPods: RunningPod[];
  errorMessage?: string;
}

export interface HeartbeatResponse {
  received: boolean;
}

// Commands
export type CommandType =
  | 'DEPLOY'
  | 'STOP'
  | 'RESTART'
  | 'DELETE'
  | 'CREATE_NAMESPACE'
  | 'UPDATE_ENV';

export type CommandStatus = 'pending' | 'acked' | 'running' | 'completed' | 'failed';

export interface Command {
  id: string;
  type: CommandType;
  payload: CommandPayload;
  status: CommandStatus;
  createdAt: string;
}

export type CommandPayload =
  | DeployPayload
  | StopPayload
  | RestartPayload
  | DeletePayload
  | CreateNamespacePayload
  | UpdateEnvPayload;

export type Framework =
  | 'angular'
  | 'react'
  | 'react-vite'
  | 'vue'
  | 'nextjs'
  | 'nodejs'
  | 'nestjs'
  | 'docker'
  | 'static';

export interface DeployPayload {
  projectId: string;
  deploymentId: string;
  namespace: string;
  appName: string;
  domain: string;
  gitRepoUrl: string;
  gitBranch: string;
  githubToken?: string;
  framework: Framework;
  buildCommand: string | null;
  startCommand: string | null;
  outputDirectory: string | null;
  port: number;
  envVars: Record<string, string>;
  resourceConfig: {
    cpu: number;
    ram_mb: number;
    replicas: number;
  };
  // Legacy fields (optional)
  subdomain?: string;
  imageTag?: string;
}

export interface StopPayload {
  projectId: string;
  namespace: string;
  appName: string;
}

export interface RestartPayload {
  projectId: string;
  namespace: string;
  appName: string;
}

export interface DeletePayload {
  projectId: string;
  namespace: string;
  appName: string;
}

export interface CreateNamespacePayload {
  namespace: string;
  userId: string;
  githubToken?: string;
}

export interface UpdateEnvPayload {
  projectId: string;
  namespace: string;
  appName: string;
  envVars: Record<string, string>;
}

// Command Result
export interface CommandResultRequest {
  success: boolean;
  error?: string;
  logs?: string;
}

export interface CommandResultResponse {
  id: string;
  status: 'completed' | 'failed';
}

export interface AckResponse {
  id: string;
  status: 'acked';
}

export interface RunningResponse {
  id: string;
  status: 'running';
}

// Config
export interface BackendConfig {
  appsDomain: string;
  serverIp: string;
  [key: string]: unknown;
}
