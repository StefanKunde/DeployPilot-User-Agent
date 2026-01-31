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
  | 'UPDATE_ENV'
  | 'ADD_CUSTOM_DOMAIN'
  | 'REMOVE_CUSTOM_DOMAIN'
  | 'CREATE_DATABASE'
  | 'DELETE_DATABASE'
  | 'UPDATE_DATABASE_PASSWORD'
  | 'ENABLE_DATABASE_EXTERNAL_ACCESS'
  | 'DISABLE_DATABASE_EXTERNAL_ACCESS'
  | 'CREATE_BACKUP'
  | 'RESTORE_BACKUP';

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
  | UpdateEnvPayload
  | CustomDomainPayload
  | CreateDatabasePayload
  | DeleteDatabasePayload
  | UpdateDatabasePasswordPayload
  | EnableDatabaseExternalAccessPayload
  | DisableDatabaseExternalAccessPayload
  | CreateBackupPayload
  | RestoreBackupPayload;

export type Framework =
  | 'angular'
  | 'react'
  | 'react-vite'
  | 'vue'
  | 'vue-vite'
  | 'nextjs'
  | 'nuxt'
  | 'nodejs'
  | 'nestjs'
  | 'svelte'
  | 'svelte-vite'
  | 'vite'
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
  gitToken?: string;
  commitSha?: string;
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

export interface CustomDomainPayload {
  projectId: string;
  domainId: string;
  namespace: string;
  appName: string;
  domain: string;
}

export type DatabaseType = 'postgres' | 'mongodb' | 'redis';

export interface CreateDatabasePayload {
  databaseId: string;
  name: string;
  type: DatabaseType;
  version: string;
  namespace: string;
  storageSize: string;
  username: string;
  password: string;
  databaseName: string;
  memoryRequest: string;
  memoryLimit: string;
  cpuRequest: string;
  cpuLimit: string;
  enableExternalAccess: boolean;
  externalHost: string | null;
  externalPort: number;
}

export interface DeleteDatabasePayload {
  databaseId: string;
  name: string;
  namespace: string;
  type: DatabaseType;
  externalAccessEnabled: boolean;
  externalHost: string | null;
}

export interface UpdateDatabasePasswordPayload {
  databaseId: string;
  name: string;
  namespace: string;
  type: DatabaseType;
  username: string;
  password: string;
}

export interface EnableDatabaseExternalAccessPayload {
  databaseId: string;
  name: string;
  namespace: string;
  type: DatabaseType;
  port: number;
  externalHost: string;
}

export interface DisableDatabaseExternalAccessPayload {
  databaseId: string;
  name: string;
  namespace: string;
  type: DatabaseType;
  externalHost: string;
}

// Backup
export interface BackupCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface CreateBackupPayload {
  backupId: string;
  databaseId: string;
  databaseType: 'postgresql' | 'mongodb';
  databaseName: string;
  namespace: string;
  credentials: BackupCredentials;
}

export interface RestoreBackupPayload {
  backupId: string;
  databaseId: string;
  databaseType: 'postgresql' | 'mongodb';
  databaseName: string;
  namespace: string;
  downloadUrl: string;
  credentials: BackupCredentials;
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
