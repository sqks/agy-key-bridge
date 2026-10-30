/**
 * 运行时状态：本地 API Key、各项开关、端口、默认模型。
 *
 * 存放位置是 <项目根>/data/state.json。这是唯一会被频繁读写的状态文件，
 * 账号与日志分开存放，避免互相覆盖。
 *
 * 设计取舍：
 * - 用普通 JSON 而不是数据库：单进程单机、数据只有几 KB，够用且好排查；
 * - 环境变量优先于文件（PORT / LAN_ACCESS / PROXY_URL / AGY_API_KEY / DEFAULT_MODEL），
 *   容器部署时不用改文件；
 * - 落盘用同步写：调用频率极低，换来"改完立刻生效"的确定性。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const DATA_DIR = path.join(ROOT, 'data');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const PANEL_DIR = path.join(ROOT, 'panel');

export const DEFAULT_PORT = 47913;
export const AUTOSTART_VALUE = 'AgyKeyBridge';

const freshKey = () => 'sk-agy-' + crypto.randomBytes(24).toString('hex');

/** 面板登录密码。放 state 里是为了能在面板改，默认 admin123。 */
export const DEFAULT_PANEL_PASSWORD = 'admin123';

const defaults = (port = DEFAULT_PORT) => ({
  apiKey: freshKey(),
  proxyEnabled: true,
  autostart: true,
  lanAccess: false,
  execMode: false,
  port,
  model: '',
  maxConcurrency: 2,
  timeoutSec: 240,
  allowRemotePanel: false,
  panelPassword: DEFAULT_PANEL_PASSWORD,
  panelSecret: crypto.randomBytes(32).toString('hex'),
  createdAt: new Date().toISOString(),
});

let cache = null;

function applyEnv(state) {
  const port = Number(process.env.PORT || process.env.AGY_PORT || 0);
  if (Number.isInteger(port) && port > 0) state.port = port;
  if (process.env.LAN_ACCESS === '1' || process.env.LAN_ACCESS === 'true') state.lanAccess = true;
  if (typeof process.env.PROXY_URL === 'string' && process.env.PROXY_URL.trim()) {
    state.proxyUrl = process.env.PROXY_URL.trim();
  }
  if (process.env.AGY_API_KEY) state.apiKey = process.env.AGY_API_KEY;
  if (process.env.DEFAULT_MODEL) state.model = process.env.DEFAULT_MODEL;
  if (process.env.ALLOW_REMOTE_PANEL === '1') state.allowRemotePanel = true;
  return state;
}

export function loadState() {
  if (cache) return cache;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    raw = null;
  }

  cache = applyEnv({ ...defaults(), ...(raw || {}) });
  if (!cache.apiKey) cache.apiKey = freshKey();

  // 老版本的文件里没有 panelSecret / panelPassword：补写一次，
  // 否则每次重启都会重新随机 key，把已登录的会话全踢掉。
  const missing = !raw || !raw.panelSecret || !raw.panelPassword;
  if (missing) {
    try { writeState(cache); } catch {}
  }

  return cache;
}

export function writeState(next = cache) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  cache = next;
  return next;
}

// 原地更新，保证已经持有 state 引用的模块看到最新值
export function updateState(patch) {
  const current = loadState();
  Object.assign(current, patch);
  return writeState(current);
}

export function rotateKey() {
  return updateState({ apiKey: freshKey() }).apiKey;
}
