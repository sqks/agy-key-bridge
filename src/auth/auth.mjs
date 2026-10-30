/**
 * 面板登录态。
 *
 * 面板上有明文 API Key 和 refresh_token，所以除了"只认回环"，再加一道密码门。
 * 这里只管三件事：比对密码、签发 cookie、校验 cookie。
 *
 * 设计取舍：
 * - 用 HMAC 签名的无状态 token，服务端不存会话表 —— 重启不掉登录，也不用清理；
 * - 签名密钥落 state.json（panelSecret），换设备就自动失效；
 * - 比对走 timingSafeEqual，避免按字节逐位试探；
 * - cookie 只带过期时间和签名，不带用户名，伪造需要密钥。
 */

import crypto from 'node:crypto';
import { loadState, writeState } from '../state/state.mjs';

export const PANEL_COOKIE = 'agy_panel';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 小时

function secret() {
  const state = loadState();
  if (!state.panelSecret) {
    state.panelSecret = crypto.randomBytes(32).toString('hex');
    try {
      writeState(state);
    } catch {}
  }
  return state.panelSecret;
}

function sign(expiresAt) {
  return crypto.createHmac('sha256', secret()).update(String(expiresAt)).digest('base64url');
}

/** 期望的密码；没配过就用默认值。 */
export function expectedPassword() {
  return loadState().panelPassword || 'admin123';
}

/** 用常量时间比较密码，长度不同直接失败（长度本身不敏感）。 */
export function passwordMatches(input) {
  const expected = Buffer.from(expectedPassword(), 'utf8');
  const given = Buffer.from(String(input ?? ''), 'utf8');
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

/** 签发一个带过期时间的 token。 */
export function issueToken() {
  const expiresAt = Date.now() + TTL_MS;
  return `${expiresAt}.${sign(expiresAt)}`;
}

/** 校验 token：先看格式，再看过期，最后验签。 */
export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [rawExpires, signature] = token.split('.');
  const expiresAt = Number(rawExpires);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;

  const expected = sign(expiresAt);
  const given = Buffer.from(String(signature || ''), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

/** 从 Cookie 头里挑出指定名字的值；不引入 cookie 解析依赖。 */
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

/** 当前请求是否已登录。 */
export function isAuthenticated(req) {
  return verifyToken(readCookie(req.headers.cookie, PANEL_COOKIE));
}

/** Set-Cookie 头。HttpOnly 防脚本读取，SameSite=Lax 够用且不影响跳转。 */
export function sessionCookie(token) {
  const maxAge = Math.floor(TTL_MS / 1000);
  return `${PANEL_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${PANEL_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
