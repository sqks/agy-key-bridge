/**
 * 账号与登录相关的面板接口，挂在 /api/accounts/* 与 /api/login/* 下。
 *
 * 这些接口只应在回环可达 —— 由 server.mjs 的 handleApi 统一拦截，
 * 这里不再重复判断来源，保持单一职责。
 */
import { startLogin, loginState, cancelLogin, completeWithCode } from '../accounts/login.mjs';
import {
  list as listAccounts,
  activeId,
  setActive,
  add as addAccount,
  remove as removeAccount,
  fetchQuota,
  cachedQuota,
  refresh as refreshAccount,
  acquireToken,
  revealRefreshToken,
} from '../accounts/accounts.mjs';

export async function handleAccountRoutes({ route, method, req, res, body, sendJson }) {
  if (route === '/api/accounts' && method === 'GET') {
    let quotaSummary = null;
    try {
      const { account, token } = await acquireToken();
      quotaSummary = await fetchQuota(account.id, token).catch(() => null);
    } catch {}
    return sendJson(res, 200, {
      ok: true,
      activeId: activeId(),
      accounts: listAccounts().map((a) => ({
        ...a,
        quota: a.quota || (quotaSummary && a.id === activeId() ? quotaSummary : null),
        cachedQuota: cachedQuota(a.id),
      })),
    });
  }

  if (route === '/api/login/start' && method === 'POST') {
    try {
      const login = await startLogin({ port: Number(body?.port) || 47914, mode: body?.mode === 'oob' ? 'oob' : 'loopback' });
      return sendJson(res, 200, { ok: true, login });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (route === '/api/login/complete' && method === 'POST') {
    try {
      const login = await completeWithCode(body?.input);
      return sendJson(res, 200, { ok: true, login, accounts: listAccounts(), activeId: activeId() });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  if (route === '/api/login/status' && method === 'GET') {
    return sendJson(res, 200, { ok: true, login: loginState() });
  }

  if (route === '/api/login/cancel' && method === 'POST') {
    return sendJson(res, 200, { ok: true, login: cancelLogin() });
  }

  if (route === '/api/accounts' && method === 'POST') {
    const { refreshToken, email, label } = body || {};
    try {
      const id = await addAccount({ refreshToken, email, label });
      return sendJson(res, 200, { ok: true, id, accounts: listAccounts(), activeId: activeId() });
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  const match = /^\/api\/accounts\/([^/]+)(?:\/(active|quota|refresh|token))?$/.exec(route);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2] || '';

    if (method === 'DELETE' && !action) {
      const ok = removeAccount(id);
      return sendJson(res, ok ? 200 : 404, { ok, accounts: listAccounts(), activeId: activeId() });
    }
    if (method === 'POST' && action === 'active') {
      const ok = setActive(id);
      return sendJson(res, ok ? 200 : 404, { ok, activeId: activeId() });
    }
    if (action === 'token' && method === 'GET') {
      try {
        return sendJson(res, 200, { ok: true, refreshToken: revealRefreshToken(id) });
      } catch (err) {
        return sendJson(res, 404, { ok: false, error: err.message });
      }
    }
    if (action === 'quota') {
      try {
        const quota = await fetchQuota(id);
        return sendJson(res, 200, { ok: true, quota });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
    if (method === 'POST' && action === 'refresh') {
      try {
        await refreshAccount(id);
        const quota = await fetchQuota(id).catch(() => null);
        return sendJson(res, 200, { ok: true, accounts: listAccounts(), quota });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }
  }

  return sendJson(res, 404, { ok: false, error: `unknown account route: ${route}` });
}
