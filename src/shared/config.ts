import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';

export type SessionScope = 'chat' | 'thread';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  // Feishu
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  // Whitelist
  allowedUserIds: string[];
  allowedChatIds: string[];
  // Scope
  scopeMode: SessionScope;
  defaultWorkDir: string;
  // Pool
  maxScopes: number;
  idleTtlMs: number;
  sweepMs: number;
  // Timeouts
  helloTimeoutMs: number;
  rpcTimeoutMs: number;
  dedupTtlMs: number;
  // Ack
  ackEmoji: string;
  // Runtime
  logLevel: LogLevel;
  // Derived paths
  storeDir: string;
  sessionsDir: string;
  inboxDir: string;
  socketPath: string;
  logsDir: string;
}

function parseList(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

function parseInt10(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(envPath?: string): AppConfig {
  const storeDir = path.join(os.homedir(), '.claude', 'channels', 'lark-channel');
  const envFile = envPath ?? path.join(storeDir, '.env');
  if (fs.existsSync(envFile)) {
    dotenv.config({ path: envFile });
  }
  const env = process.env;

  const appId = env.LARK_APP_ID ?? '';
  const appSecret = env.LARK_APP_SECRET ?? '';
  const domainRaw = (env.LARK_DOMAIN ?? 'feishu').toLowerCase();
  const domain: 'feishu' | 'lark' = domainRaw === 'lark' ? 'lark' : 'feishu';
  const scopeRaw = (env.LARK_CHANNEL_SCOPE_MODE ?? 'thread').toLowerCase();
  const scopeMode: SessionScope = scopeRaw === 'chat' ? 'chat' : 'thread';
  const logRaw = (env.LARK_CHANNEL_LOG_LEVEL ?? 'info').toLowerCase();
  const logLevel: LogLevel = (['error', 'warn', 'info', 'debug'] as const).includes(logRaw as LogLevel)
    ? (logRaw as LogLevel)
    : 'info';

  return {
    appId,
    appSecret,
    domain,
    allowedUserIds: parseList(env.LARK_ALLOWED_USER_IDS),
    allowedChatIds: parseList(env.LARK_ALLOWED_CHAT_IDS),
    scopeMode,
    defaultWorkDir: env.LARK_CHANNEL_DEFAULT_WORKDIR || os.homedir(),
    maxScopes: parseInt10(env.LARK_CHANNEL_MAX_SCOPES, 50),
    idleTtlMs: parseInt10(env.LARK_CHANNEL_IDLE_TTL_MS, 14_400_000),
    sweepMs: parseInt10(env.LARK_CHANNEL_SWEEP_MS, 300_000),
    helloTimeoutMs: parseInt10(env.LARK_CHANNEL_HELLO_TIMEOUT_MS, 15_000),
    rpcTimeoutMs: parseInt10(env.LARK_CHANNEL_RPC_TIMEOUT_MS, 60_000),
    dedupTtlMs: parseInt10(env.LARK_CHANNEL_DEDUP_TTL_MS, 60_000),
    ackEmoji: env.LARK_ACK_EMOJI ?? 'MeMeMe',
    logLevel,
    storeDir,
    sessionsDir: path.join(storeDir, 'sessions'),
    inboxDir: path.join(storeDir, 'inbox'),
    socketPath: path.join(storeDir, 'bridge.sock'),
    logsDir: path.join(storeDir, 'logs'),
  };
}

export function validateMasterConfig(cfg: AppConfig): string[] {
  const errors: string[] = [];
  if (!cfg.appId) errors.push('LARK_APP_ID is required');
  if (!cfg.appSecret) errors.push('LARK_APP_SECRET is required');
  return errors;
}
