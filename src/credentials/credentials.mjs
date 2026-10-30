/**
 * 读取 Windows 凭据管理器里的 gemini:antigravity（agy 的登录态）。
 *
 * 只在 Windows 上有意义：其它平台直接返回不可用，让 accounts 走 refresh_token
 * 那条路，绝不在这里 spawn 任何 shell。
 *
 * agy 自己会刷新它存的那份凭据，所以这里缓存 60 秒、临近过期时提前重读，
 * 重读就能拿到新值 —— 不需要我们实现刷新（账号池有自己的刷新逻辑）。
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../state/state.mjs';

const SCRIPT = path.join(ROOT, 'tools', 'read-cred.ps1');
const SHELLS = ['pwsh.exe', 'powershell.exe'];
const TTL_MS = 60_000;
const REFRESH_WINDOW_MS = 300_000;

let cache = { value: null, at: 0 };
let inflight = null;

function runShell(shell, args) {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      args,
      {
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        // 即使退出码非 0，脚本也会把结构化 JSON 写在 stdout。
        if (stdout && stdout.trim().startsWith('{')) return resolve(stdout.trim());
        reject(new Error((stderr || stdout || err?.message || 'credential read failed').trim()));
      },
    );
  });
}

export async function readCredentials(force = false) {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      error: 'windows credential manager only; add accounts with a refresh_token instead',
    };
  }
  const now = Date.now();
  const fresh = cache.value && !force && now - cache.at < TTL_MS;
  const expirySoon =
    cache.value?.ok &&
    Date.parse(cache.value.expiry || 0) - now < REFRESH_WINDOW_MS;
  if (fresh && !expirySoon) return cache.value;
  if (inflight) return inflight;

  inflight = (async () => {
    const errors = [];
    for (const shell of SHELLS) {
      try {
        const out = await runShell(shell, [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          SCRIPT,
        ]);
        const parsed = JSON.parse(out);
        cache = { value: parsed, at: Date.now() };
        return parsed;
      } catch (err) {
        errors.push(`${shell}: ${err.message}`);
      }
    }
    const failed = { ok: false, error: errors.join(' | ') };
    cache = { value: failed, at: Date.now() };
    return failed;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}

export function credentialSummary(cred) {
  if (!cred || cred.ok === false) {
    return { ok: false, error: cred?.error || 'unavailable' };
  }
  const expiryMs = Date.parse(cred.expiry || 0);
  return {
    ok: true,
    source: cred.source,
    target: cred.target,
    email: cred.email,
    authMethod: cred.authMethod,
    tokenType: cred.tokenType,
    expiry: cred.expiry,
    expiresInSec: Number.isFinite(expiryMs)
      ? Math.max(0, Math.round((expiryMs - Date.now()) / 1000))
      : null,
    accessTokenTail: cred.accessToken ? cred.accessToken.slice(-8) : null,
    hasRefreshToken: Boolean(cred.refreshToken),
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken,
  };
}

export function invalidateCredentials() {
  cache = { value: null, at: 0 };
}
