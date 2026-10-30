/**
 * 浏览器授权登录：拿到 refresh_token 的两条路径。
 *
 * 1. loopback（默认）
 *    redirect_uri = http://127.0.0.1:<port>/callback，Google 授权后自动回调，
 *    用户什么都不用复制。跨机器使用时靠 SSH 端口转发把回调送回服务器。
 *
 * 2. oob
 *    redirect_uri = urn:ietf:wg:oauth:2.0:oob，Google 把授权码显示在页面上，
 *    用户复制粘贴回来。无头服务器上最省事，不需要任何端口可达。
 *
 * 为什么不走设备码（device/code）：agy 的 client 是 desktop 类型，
 * 请求 device/code 会得到 401 invalid_client: Invalid client type。
 *
 * 安全：PKCE(S256) + state 双向校验 + 5 分钟超时；code_verifier 只留在进程内存。
 * 会话是单例的，同一时间只允许一个待完成的授权。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { request, readAll } from '../http/http.mjs';
import { add, setActive } from './accounts.mjs';

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/aicode',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/cclog',
].join(' ');

const TIMEOUT_MS = 5 * 60 * 1000;

let session = null;

export function loginState() {
  if (!session) return { status: 'idle' };
  return {
    status: session.status,
    url: session.url,
    redirectUri: session.redirectUri,
    port: session.port,
    mode: session.mode,
    email: session.email || null,
    error: session.error || null,
    startedAt: session.startedAt,
  };
}

function page(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.6 -apple-system,"Segoe UI",sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#fafafa;color:#18181b}
.card{background:#fff;border:1px solid #e7e7e9;border-radius:14px;padding:28px 34px;text-align:center;max-width:420px}
h1{font-size:16px;margin:0 0 8px}p{color:#71717a;font-size:13px;margin:0}</style>
<div class="card"><h1>${title}</h1><p>${message}</p></div>`;
}

function closeSession(status, extra = {}) {
  if (!session) return;
  session.status = status;
  Object.assign(session, extra);
  if (session.server) {
    try {
      session.server.close();
    } catch {}
  }
  if (session.timer) clearTimeout(session.timer);
}

/** 拿授权码换 token 并落账号。回调与手动粘贴共用同一条路径。 */
async function exchangeCode(code, verifier, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  }).toString();
  const tokenRes = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
    body,
  });
  const tokenText = await readAll(tokenRes);
  if (tokenRes.statusCode !== 200) {
    let detail = tokenText;
    try {
      detail = JSON.parse(tokenText).error_description || tokenText;
    } catch {}
    throw new Error(String(detail).slice(0, 200));
  }
  const data = JSON.parse(tokenText);
  if (!data.refresh_token) {
    throw new Error('Google 没有返回 refresh_token；去 myaccount.google.com/permissions 移除该应用授权后重试');
  }
  const id = await add({ refreshToken: data.refresh_token });
  await setActive(id);
  return id;
}

/** 从「整条回调 URL」或「纯 code」里取出授权码。 */
export function extractCode(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('粘贴内容为空');

  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    const code = u.searchParams.get('code');
    if (code) return { code, state: u.searchParams.get('state') };
    const err = u.searchParams.get('error');
    if (err) throw new Error('Google 返回了错误：' + err);
    throw new Error('这条 URL 里没有 code 参数');
  }

  const m = /[?&]code=([^&\s]+)/.exec(raw);
  if (m) {
    const st = /[?&]state=([^&\s]+)/.exec(raw);
    return { code: decodeURIComponent(m[1]), state: st ? decodeURIComponent(st[1]) : null };
  }

  if (/^[\w\-./]+$/.test(raw) && raw.length >= 16) return { code: raw, state: null };
  throw new Error('看不出这是授权码或回调 URL');
}

/** 手动粘贴授权码完成登录（不需要回调端口可达）。 */
export async function completeWithCode(input) {
  if (!session || session.status !== 'pending') {
    throw new Error('没有正在等待的登录会话，先点一次「浏览器授权登录」');
  }
  const { code, state } = extractCode(input);
  if (state && session.antistate && state !== session.antistate) {
    throw new Error('state 不匹配，请重新发起授权');
  }
  const id = await exchangeCode(code, session.verifier, session.redirectUri);
  closeSession('done', { email: id });
  return loginState();
}

export async function startLogin({ port = 47914, mode = 'loopback' } = {}) {
  if (session && session.status === 'pending') return loginState();

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const antistate = crypto.randomBytes(16).toString('base64url');
  // oob：Google 直接把授权码显示在页面上，不需要回调端口
  const redirectUri = mode === 'oob' ? 'urn:ietf:wg:oauth:2.0:oob' : `http://127.0.0.1:${port}/callback`;

  const url =
    'https://accounts.google.com/o/oauth2/auth?' +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      state: antistate,
    }).toString();

  const server = mode === 'oob' ? null : http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (u.pathname !== '/callback') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    const err = u.searchParams.get('error');
    if (err) {
      closeSession('error', { error: err });
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('授权失败', `Google 返回：${err}`));
      return;
    }

    if (u.searchParams.get('state') !== antistate) {
      closeSession('error', { error: 'state mismatch' });
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('授权失败', '回调 state 不匹配，请重新发起。'));
      return;
    }

    const code = u.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('授权失败', '没有收到 code。'));
      return;
    }

    try {
      const id = await exchangeCode(code, verifier, redirectUri);
      closeSession('done', { email: id });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('授权完成', '账号已加入池子，可以关闭这个页面了。'));
    } catch (error) {
      closeSession('error', { error: error.message });
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('授权失败', error.message));
    }
  });

  if (server) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  }

  session = {
    status: 'pending',
    url,
    redirectUri,
    port,
    verifier,
    antistate,
    mode,
    server,
    startedAt: new Date().toISOString(),
  };
  session.timer = setTimeout(() => closeSession('expired'), TIMEOUT_MS);
  session.timer.unref?.();

  return loginState();
}

export function cancelLogin() {
  if (!session) return { status: 'idle' };
  closeSession('cancelled');
  return loginState();
}
