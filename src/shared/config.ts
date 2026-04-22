import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type SessionScope = 'chat' | 'thread';

/**
 * 用户侧的 JSON 配置（~/.claude/channels/lark-channel/config.json）。
 * 顶层扁平；所有字段 optional，未填时用默认值。
 */
export interface ConfigFile {
  debug?: boolean;
  feishu?: {
    appId?: string;
    appSecret?: string;
    domain?: 'feishu' | 'lark';
  };
  whitelist?: {
    users?: string[];
    chats?: string[];
  };
  scope?: {
    mode?: SessionScope;
    defaultWorkDir?: string;
  };
  pool?: {
    maxScopes?: number;
    idleTtlMs?: number;
    sweepMs?: number;
  };
  timeouts?: {
    helloMs?: number;
    rpcMs?: number;
    dedupMs?: number;
  };
  ackEmoji?: string;
}

export interface AppConfig {
  // 运行时开关
  debug: boolean;
  // Feishu 凭据
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  // 白名单
  allowedUserIds: string[];
  allowedChatIds: string[];
  // Scope 隔离
  scopeMode: SessionScope;
  defaultWorkDir: string;
  // tmux 池
  maxScopes: number;
  idleTtlMs: number;
  sweepMs: number;
  // 超时
  helloTimeoutMs: number;
  rpcTimeoutMs: number;
  dedupTtlMs: number;
  // Ack 表情
  ackEmoji: string;
  // 派生路径
  storeDir: string;
  configPath: string;
  sessionsDir: string;
  inboxDir: string;
  socketPath: string;
  logsDir: string;
}

const DEFAULTS = {
  domain: 'feishu' as const,
  scopeMode: 'thread' as SessionScope,
  maxScopes: 50,
  idleTtlMs: 14_400_000, // 4h
  sweepMs: 300_000,      // 5min
  helloTimeoutMs: 15_000,
  rpcTimeoutMs: 60_000,
  dedupTtlMs: 60_000,
  ackEmoji: 'MeMeMe',
};

/**
 * 加载配置。优先读 config.json，读不到/解析失败时返回默认值 + 空凭据。
 * 调用方可用 validateMasterConfig() 检查凭据是否齐全。
 */
export function loadConfig(overrideConfigPath?: string): AppConfig {
  const storeDir = path.join(os.homedir(), '.claude', 'channels', 'lark-channel');
  const configPath = overrideConfigPath ?? path.join(storeDir, 'config.json');

  let file: ConfigFile = {};
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      console.error(`[config] failed to parse ${configPath}:`, err);
      file = {};
    }
  }

  const feishu = file.feishu ?? {};
  const whitelist = file.whitelist ?? {};
  const scope = file.scope ?? {};
  const pool = file.pool ?? {};
  const timeouts = file.timeouts ?? {};

  const domain: 'feishu' | 'lark' = feishu.domain === 'lark' ? 'lark' : DEFAULTS.domain;
  const scopeMode: SessionScope = scope.mode === 'chat' ? 'chat' : DEFAULTS.scopeMode;

  return {
    debug: file.debug === true,
    appId: feishu.appId ?? '',
    appSecret: feishu.appSecret ?? '',
    domain,
    allowedUserIds: Array.isArray(whitelist.users) ? whitelist.users.filter(Boolean) : [],
    allowedChatIds: Array.isArray(whitelist.chats) ? whitelist.chats.filter(Boolean) : [],
    scopeMode,
    defaultWorkDir: scope.defaultWorkDir || os.homedir(),
    maxScopes: Number.isFinite(pool.maxScopes) ? pool.maxScopes! : DEFAULTS.maxScopes,
    idleTtlMs: Number.isFinite(pool.idleTtlMs) ? pool.idleTtlMs! : DEFAULTS.idleTtlMs,
    sweepMs:   Number.isFinite(pool.sweepMs)   ? pool.sweepMs!   : DEFAULTS.sweepMs,
    helloTimeoutMs: Number.isFinite(timeouts.helloMs) ? timeouts.helloMs! : DEFAULTS.helloTimeoutMs,
    rpcTimeoutMs:   Number.isFinite(timeouts.rpcMs)   ? timeouts.rpcMs!   : DEFAULTS.rpcTimeoutMs,
    dedupTtlMs:     Number.isFinite(timeouts.dedupMs) ? timeouts.dedupMs! : DEFAULTS.dedupTtlMs,
    ackEmoji: file.ackEmoji ?? DEFAULTS.ackEmoji,
    storeDir,
    configPath,
    sessionsDir: path.join(storeDir, 'sessions'),
    inboxDir: path.join(storeDir, 'inbox'),
    socketPath: path.join(storeDir, 'bridge.sock'),
    logsDir: path.join(storeDir, 'logs'),
  };
}

export function validateMasterConfig(cfg: AppConfig): string[] {
  const errors: string[] = [];
  if (!cfg.appId) errors.push('feishu.appId is required');
  if (!cfg.appSecret) errors.push('feishu.appSecret is required');
  return errors;
}
