/**
 * 账号池：每个账号存一份 refresh_token，桥接层自己换 access_token。
 *
 * 为什么自己刷 token：Antigravity 的 OAuth client 是 desktop 类型，刷新时必须
 * 带 client_secret，只给 refresh_token 会返回 400 "client_secret is missing"。
 * 下面的 client_id / client_secret 取自 agy 二进制，与它登录时用的完全一致。
 *
 * 存储：<项目根>/data/accounts.json，refresh_token 是明文。
 * 它等价于账号登录态，不要提交、不要外传（.gitignore 已排除）。
 *
 * 选号策略：优先 active 账号，失败自动落到下一个 —— 单个账号额度耗尽或 token
 * 失效不该让整个网关不可用。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../state/state.mjs';
import { readCredentials } from '../credentials/credentials.mjs';
import { request, readAll } from '../http/http.mjs';

const FILE = path.join(DATA_DIR, 'accounts.json');

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const REFRESH_MARGIN_MS = 120_000;

let cache = null;

function read() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = { accounts: Array.isArray(raw.accounts) ? raw.accounts : [], activeId: raw.activeId || null };
  } catch {
    cache = { accounts: [], activeId: null };
  }
  return cache;
}

function write() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8');
  return cache;
}

export function list() {
  return read().accounts.map((a) => ({
    id: a.id,
    email: a.email,
    label: a.label || '',
    expiry: a.expiry,
    hasRefreshToken: Boolean(a.refreshToken),
    addedAt: a.addedAt,
    lastUsedAt: a.lastUsedAt || null,
    quota: a.quota || null,
  }));
}

export function activeId() {
  const store = read();
  if (store.activeId && store.accounts.some((a) => a.id === store.activeId)) return store.activeId;
  return store.accounts[0]?.id || null;
}

export function setActive(id) {
  const store = read();
  if (!store.accounts.some((a) => a.id === id)) return false;
  store.activeId = id;
  write();
  return true;
}

function find(id) {
  return read().accounts.find((a) => a.id === id) || null;
}

/** 用 refresh_token 换新的 access_token。 */
export async function refresh(id) {
  const store = read();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) throw new Error(`account ${id} not found`);
  if (!account.refreshToken) throw new Error(`account ${id} has no refresh_token`);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: account.refreshToken,
  });
  const res = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await readAll(res);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let detail = text;
    try {
      detail = JSON.parse(text).error_description || text;
    } catch {}
    throw new Error(`refresh failed ${res.statusCode}: ${String(detail).slice(0, 200)}`);
  }
  const data = JSON.parse(text);
  account.accessToken = data.access_token;
  account.expiry = new Date(Date.now() + (data.expires_in || 3599) * 1000).toISOString();
  if (data.refresh_token) account.refreshToken = data.refresh_token;
  account.refreshedAt = new Date().toISOString();
  write();
  return account.accessToken;
}

async function ensureToken(account) {
  const expiry = Date.parse(account.expiry || 0);
  if (account.accessToken && Number.isFinite(expiry) && expiry - Date.now() > REFRESH_MARGIN_MS) {
    return account.accessToken;
  }
  return refresh(account.id);
}

/** 从一台机器导出的 refresh_token 建账号；email 用 userinfo 补齐。 */
export async function add({ refreshToken, email = '', label = '' } = {}) {
  if (!refreshToken || typeof refreshToken !== 'string') throw new Error('refreshToken is required');
  const store = read();
  const existing = store.accounts.find((a) => a.refreshToken === refreshToken);
  if (existing) return existing.id;

  const draft = {
    id: crypto.randomUUID(),
    email: email || '',
    label: label || '',
    refreshToken,
    accessToken: null,
    expiry: new Date(0).toISOString(),
    addedAt: new Date().toISOString(),
    lastUsedAt: null,
    quota: null,
  };
  store.accounts.push(draft);

  const token = await refresh(draft.id);
  if (!draft.email) {
    try {
      const res = await request('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: `Bearer ${token}` },
      });
      const text = await readAll(res);
      if (res.statusCode < 300) {
        const info = JSON.parse(text);
        if (info?.email) draft.email = info.email;
      }
    } catch {}
  }
  if (!store.activeId) store.activeId = draft.id;
  write();
  return draft.id;
}

export function remove(id) {
  const store = read();
  const before = store.accounts.length;
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.activeId === id) store.activeId = store.accounts[0]?.id || null;
  if (store.accounts.length === before) return false;
  write();
  return true;
}

/** 首次运行：把本机 agy 的登录态导进来，省得用户手动填。 */
export async function ensureSeeded() {
  const store = read();
  if (store.accounts.length) return false;
  if (process.env.AGY_SKIP_SEED === '1') return false;

  if (process.env.AGY_REFRESH_TOKEN) {
    try {
      const id = await add({
        refreshToken: process.env.AGY_REFRESH_TOKEN.trim(),
        email: process.env.AGY_EMAIL || '',
      });
      await setActive(id);
      return true;
    } catch {
      // 落到凭据管理器那条路
    }
  }
  const cred = await readCredentials(true).catch(() => null);
  if (!cred?.ok || !cred.refreshToken) return false;
  try {
    const id = await add({ refreshToken: cred.refreshToken, email: cred.email || '' });
    await setActive(id);
    return true;
  } catch {
    return false;
  }
}

/** 取一个能用的账号 token：优先 active，其次任意一个。 */
export async function acquireToken() {
  const store = read();
  const order = [];
  const preferred = store.accounts.find((a) => a.id === activeId());
  if (preferred) order.push(preferred);
  for (const a of store.accounts) if (a !== preferred) order.push(a);
  if (!order.length) throw new Error('no antigravity account configured');

  let lastError = null;
  for (const account of order) {
    try {
      const token = await ensureToken(account);
      account.lastUsedAt = new Date().toISOString();
      write();
      return { token, account };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`all accounts failed to refresh: ${lastError?.message || 'unknown'}`);
}

/** 拉某个账号的模型额度。 */
export async function fetchQuota(id, token) {
  const store = read();
  const account = store.accounts.find((a) => a.id === id);
  if (!account) throw new Error('account not found');
  const t = token || (await ensureToken(account));
  const payload = Buffer.from(JSON.stringify({ project: 'aicode-consumers' }), 'utf8');
  const res = await request('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${t}`,
      'user-agent':
        'antigravity/cli/1.4.10 (aidev_client; os_type=windows; arch=amd64; cl=1009308193; auth_method=consumer)',
      'content-type': 'application/json',
      'content-length': payload.length,
    },
    body: payload,
  });
  if (res.statusCode !== 200) {
    const text = await readAll(res);
    throw new Error(`quota ${res.statusCode}: ${text.slice(0, 160)}`);
  }
  const data = JSON.parse(await readAll(res));
  const models = Object.entries(data.models || {})
    .map(([mid, m]) => ({
      id: mid,
      displayName: m.displayName || mid,
      remaining: m.quotaInfo?.remainingFraction ?? null,
      resetTime: m.quotaInfo?.resetTime || null,
      maxTokens: m.maxTokens || 0,
      maxOutputTokens: m.maxOutputTokens || 0,
      thinking: Boolean(m.supportsThinking),
    }))
    .sort((a, b) => (b.remaining ?? -1) - (a.remaining ?? -1));
  account.quota = { at: new Date().toISOString(), models };
  write();
  return account.quota;
}

export function revealRefreshToken(id) {
  const account = read().accounts.find((a) => a.id === id);
  if (!account) throw new Error('account not found');
  if (!account.refreshToken) throw new Error('account has no refresh_token');
  return account.refreshToken;
}

export function cachedQuota(id) {
  const account = find(id);
  return account?.quota || null;
}
