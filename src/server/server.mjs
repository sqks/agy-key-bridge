/**
 * HTTP 服务入口：面板 + 两个协议端点 + 账号接口。
 *
 * 路由分三类，边界是刻意设计的：
 * - /v1/*     对外开放（开启局域网后），靠 API Key 鉴权，给 dsh / Claude Code 用；
 * - /api/*    永远只认回环 —— 面板上有明文 API Key 和 refresh_token，不能跟着 API 摊出去；
 * - 静态面板  同样只认回环，远程查看走 SSH 端口转发。
 *
 * 请求流：读 body → 选账号 → 转 Gemini 格式 → 流式读取 → 按目标协议重新封装。
 * 上游一帧可能同时带来正文 / 思考 / 工具调用，三者分别落到对应字段。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PANEL_DIR,
  loadState,
  updateState,
  rotateKey,
} from '../state/state.mjs';
import {
  readCredentials,
  credentialSummary,
  invalidateCredentials,
} from '../credentials/credentials.mjs';
import { fetchModels, resolveModel as resolveUpstreamModel, generateStream } from '../upstream/upstream.mjs';
import {
  passwordMatches,
  issueToken,
  verifyToken,
  isAuthenticated,
  sessionCookie,
  clearCookie,
  expectedPassword,
} from '../auth/auth.mjs';
import { openAiToGemini, anthropicToGemini, toGeminiTools, generationConfig, toolCallId } from '../convert/convert.mjs';
import { rememberSignature, stats as signatureStats } from '../signatures/signatures.mjs';
import { handleAccountRoutes } from './account-routes.mjs';
import { ensureSeeded } from '../accounts/accounts.mjs';
import { setAutostart, autostartInstalled, autostartCommand, platformInfo } from '../autostart/autostart.mjs';
import { record, recent, clear as clearLog, Semaphore } from '../log/log.mjs';
import {
  chatId,
  msgId,
  sseHeaders,
  sseData,
  sseEvent,
  sseComment,
  openAiChunk,
  openAiCompletion,
  usageFromAgy,
  errorPayload,
} from '../compat/compat.mjs';

const VERSION = '1.0.0';
const startedAt = Date.now();
const state = loadState();
const semaphore = new Semaphore(state.maxConcurrency);

const log = (...args) => console.log(`[agy-bridge]`, ...args);

// ---------------------------------------------------------------- helpers

function safeEqual(a = '', b = '') {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function usageFromGemini(u) {
  return {
    prompt_tokens: u?.promptTokenCount ?? 0,
    completion_tokens: u?.candidatesTokenCount ?? 0,
    total_tokens: u?.totalTokenCount ?? ((u?.promptTokenCount ?? 0) + (u?.candidatesTokenCount ?? 0)),
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function baseUrl() {
  return `http://127.0.0.1:${state.port}/v1`;
}

// 排除 Clash TUN 的 fake-ip 段、link-local，以及各类虚拟网卡
const VIRTUAL_IFACE = /vmware|virtualbox|vethernet|loopback|wsl|hyper-v|tailscale|zerotier|radmin/i;

function lanCandidates() {
  const out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(iface)) continue;
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('198.18.') || info.address.startsWith('169.254.')) continue;
      out.push({ iface, address: info.address });
    }
  }
  return out;
}

let primaryCache = { value: null, at: 0 };

/** 一次 UDP connect 让内核选路由，拿默认出口的本地地址（不发包）。 */
function probePrimaryAddress() {
  if (Date.now() - primaryCache.at < 30_000) return Promise.resolve(primaryCache.value);
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch {}
      primaryCache = { value, at: Date.now() };
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 500);
    sock.on('error', () => { clearTimeout(timer); finish(null); });
    try {
      sock.connect(53, '223.5.5.5', () => {
        clearTimeout(timer);
        const addr = sock.address().address;
        const usable =
          addr && addr !== '0.0.0.0' && !addr.startsWith('198.18.') && !addr.startsWith('169.254.');
        finish(usable ? addr : null);
      });
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

async function addressPayload() {
  const candidates = lanCandidates();
  const primary = (await probePrimaryAddress()) || candidates[0]?.address || null;
  return {
    loopback: `http://127.0.0.1:${state.port}/`,
    apiBase: `http://127.0.0.1:${state.port}/v1`,
    lanAccess: Boolean(state.lanAccess),
    primary,
    lan: candidates.map((c) => ({ ...c, url: `http://${c.address}:${state.port}/` })),
    preferred:
      state.lanAccess && primary
        ? `http://${primary}:${state.port}/`
        : `http://127.0.0.1:${state.port}/`,
    externalApiBase:
      state.lanAccess && primary ? `http://${primary}:${state.port}/v1` : null,
  };
}

function openPanel(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd.exe', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (err) {
    log(`open browser failed: ${err.message}`);
  }
}

function alreadyRunning() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: state.port, path: '/api/health', timeout: 800 },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body).name === 'agy-key-bridge'); } catch { resolve(false); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function listenOn(port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** 切换绑定地址：0.0.0.0 时同一网络的其他设备也能打开面板。 */
async function rebind() {
  const host = state.lanAccess ? '0.0.0.0' : '127.0.0.1';
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  await listenOn(state.port, host);
}

let modelCache = [];
async function loadModels() {
  if (!modelCache.length) modelCache = await fetchModels().catch(() => []);
  return modelCache;
}
async function resolveModel(requested) {
  await loadModels();
  if (requested && modelCache.some((m) => m.id === requested)) return requested;
  if (state.model && modelCache.some((m) => m.id === state.model)) return state.model;
  return resolveUpstreamModel(requested);
}

function authOk(req) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const xkey = String(req.headers['x-api-key'] || '').trim();
  const provided = bearer || xkey;
  return safeEqual(provided, state.apiKey);
}

function rejectProxyOff(res) {
  sendJson(res, 503, errorPayload(
    'AGY reverse proxy is disabled. Turn it on in the bridge panel, then retry.',
    'proxy_disabled',
    'proxy_disabled',
  ));
}

// ---------------------------------------------------------------- status

async function statusPayload() {
  const models = await loadModels();
  const cred = credentialSummary(await readCredentials());
  return {
    ok: true,
    version: VERSION,
    proxyEnabled: state.proxyEnabled,
    execMode: Boolean(state.execMode),
    autostart: state.autostart,
    autostartRegistered: autostartInstalled(true),
    autostartCommand: autostartCommand(),
    apiKey: state.apiKey,
    baseUrl: baseUrl(),
    addresses: await addressPayload(),
    port: state.port,
    model: state.model || (models[0]?.id ?? ''),
    models,
    account: cred,
    upstream: { host: 'daily-cloudcode-pa.googleapis.com', project: 'aicode-consumers' },
    queue: semaphore.stats(),
    platform: platformInfo(),
    proxyUrl: (await import('../http/http.mjs')).proxyUrl(),
    signatures: signatureStats(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  };
}

// ---------------------------------------------------------------- proxy handlers

async function handleChatCompletions(req, res) {
  if (!state.proxyEnabled) return rejectProxyOff(res);
  if (!authOk(req)) {
    return sendJson(res, 401, errorPayload('invalid api key', 'auth_error', 'invalid_api_key'));
  }

  const body = await readBody(req);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const model = await resolveModel(body.model);
  const { system, contents } = openAiToGemini(body);
  const gemTools = toGeminiTools(tools);
  const cfg = generationConfig(body);
  const wantStream = body.stream === true;
  const includeUsage = body.stream_options?.include_usage === true;
  const id = chatId();
  const created = Math.floor(Date.now() / 1000);
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  await semaphore.acquire();
  const t0 = Date.now();
  try {
    if (wantStream) {
      sseHeaders(res);
      const keep = setInterval(() => sseComment(res), 10_000);
      sseData(res, openAiChunk({ id, model, created, delta: { role: 'assistant', content: '' } }));

      let text = '';
      let thoughts = 0;
      const calls = [];
      const meta = { usage: null };
      try {
        const st = await generateStream({
          model, system, contents, tools: gemTools, generationConfig: cfg,
          signal: controller.signal,
          onChunk: (chunk) => {
            if (chunk.thought) {
              thoughts += chunk.thought.length;
              sseData(res, openAiChunk({ id, model, created, delta: { reasoning_content: chunk.thought } }));
            }
            if (chunk.text) {
              text += chunk.text;
              sseData(res, openAiChunk({ id, model, created, delta: { content: chunk.text } }));
            }
            if (chunk.functionCall) calls.push(chunk.functionCall);
          },
        });
        meta.usage = st.usage;
      } catch (err) {
        clearInterval(keep);
        sseData(res, errorPayload(err.message));
        sseData(res, '[DONE]');
        res.end();
        record({ kind: 'chat', model, stream: true, ok: false, ms: Date.now() - t0, error: err.message });
        return;
      }

      clearInterval(keep);
      if (calls.length) {
        sseData(res, {
          id, object: 'chat.completion.chunk', created, model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: calls.map((call, index) => {
                const callId = rememberSignature(toolCallId(), call.thoughtSignature);
                return {
                  index,
                  id: callId,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
                };
              }),
            },
            finish_reason: null,
          }],
        });
        sseData(res, openAiChunk({ id, model, created, delta: {}, finish: 'tool_calls' }));
      } else {
        sseData(res, openAiChunk({ id, model, created, delta: {}, finish: 'stop' }));
      }
      if (includeUsage) {
        sseData(res, {
          id, object: 'chat.completion.chunk', created, model, choices: [],
          usage: usageFromGemini(meta.usage),
        });
      }
      sseData(res, '[DONE]');
      res.end();
      record({
        kind: 'chat', model, stream: true, tools: tools.length, calls: calls.length,
        ok: true, ms: Date.now() - t0, chars: text.length,
        preview: text.slice(0, 220), thoughts,
      });
      return;
    }

    let text = '';
    const calls = [];
    const st = await generateStream({
      model, system, contents, tools: gemTools, generationConfig: cfg,
      onChunk: (chunk) => {
        if (chunk.text) text += chunk.text;
        if (chunk.functionCall) calls.push(chunk.functionCall);
      },
    });

    const payload = openAiCompletion({ id, model, created, text, usage: usageFromGemini(st.usage) });
    if (calls.length) {
      payload.choices[0].finish_reason = 'tool_calls';
      payload.choices[0].message.content = text || null;
      payload.choices[0].message.tool_calls = calls.map((call) => ({
        id: rememberSignature(toolCallId(), call.thoughtSignature),
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
      }));
    }
    record({
      kind: 'chat', model, stream: false, tools: tools.length, calls: calls.length,
      ok: true, ms: Date.now() - t0, chars: text.length, preview: text.slice(0, 220),
    });
    return sendJson(res, 200, payload);
  } catch (err) {
    record({ kind: 'chat', model, ok: false, ms: Date.now() - t0, error: err.message });
    if (!res.headersSent) return sendJson(res, 500, errorPayload(err.message));
    try { sseData(res, errorPayload(err.message)); sseData(res, '[DONE]'); res.end(); } catch {}
  } finally {
    semaphore.release();
  }
}

async function handleAnthropicMessages(req, res) {
  if (!state.proxyEnabled) return rejectProxyOff(res);
  if (!authOk(req)) {
    return sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid api key' } });
  }

  const body = await readBody(req);
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const model = await resolveModel(body.model);
  const { system, contents } = anthropicToGemini(body);
  const gemTools = toGeminiTools(tools);
  const cfg = generationConfig(body);
  const wantStream = body.stream === true;
  const id = msgId();
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  await semaphore.acquire();
  const t0 = Date.now();
  try {
    if (wantStream) {
      sseHeaders(res);
      const keep = setInterval(() => sseComment(res), 10_000);
      let blockIndex = 0;
      let thinkingIndex = -1;
      let textIndex = -1;
      const calls = [];

      sseEvent(res, 'message_start', {
        type: 'message_start',
        message: {
          id, type: 'message', role: 'assistant', model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      let st;
      try {
        st = await generateStream({
          model, system, contents, tools: gemTools, generationConfig: cfg,
          signal: controller.signal,
          onChunk: (chunk) => {
            if (chunk.thought) {
              if (thinkingIndex < 0) {
                thinkingIndex = blockIndex++;
                sseEvent(res, 'content_block_start', {
                  type: 'content_block_start', index: thinkingIndex,
                  content_block: { type: 'thinking', thinking: '' },
                });
              }
              sseEvent(res, 'content_block_delta', {
                type: 'content_block_delta', index: thinkingIndex,
                delta: { type: 'thinking_delta', thinking: chunk.thought },
              });
            }
            if (chunk.text) {
              if (textIndex < 0) {
                textIndex = blockIndex++;
                sseEvent(res, 'content_block_start', {
                  type: 'content_block_start', index: textIndex,
                  content_block: { type: 'text', text: '' },
                });
              }
              sseEvent(res, 'content_block_delta', {
                type: 'content_block_delta', index: textIndex,
                delta: { type: 'text_delta', text: chunk.text },
              });
            }
            if (chunk.functionCall) calls.push(chunk.functionCall);
          },
        });
      } catch (err) {
        clearInterval(keep);
        sseEvent(res, 'error', { type: 'error', error: { type: 'api_error', message: err.message } });
        sseEvent(res, 'message_stop', { type: 'message_stop' });
        res.end();
        record({ kind: 'messages', model, stream: true, ok: false, ms: Date.now() - t0, error: err.message });
        return;
      }

      clearInterval(keep);
      if (thinkingIndex >= 0) sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: thinkingIndex });
      if (textIndex >= 0) sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: textIndex });

      calls.forEach((call) => {
        const index = blockIndex++;
        const callId = rememberSignature('toolu_' + id.slice(-8) + index, call.thoughtSignature);
        sseEvent(res, 'content_block_start', {
          type: 'content_block_start', index,
          content_block: { type: 'tool_use', id: callId, name: call.name, input: {} },
        });
        sseEvent(res, 'content_block_delta', {
          type: 'content_block_delta', index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args || {}) },
        });
        sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
      });

      sseEvent(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: st?.usage?.promptTokenCount ?? 0,
          output_tokens: st?.usage?.candidatesTokenCount ?? 0,
        },
      });
      sseEvent(res, 'message_stop', { type: 'message_stop' });
      res.end();
      record({
        kind: 'messages', model, stream: true, tools: tools.length, calls: calls.length,
        ok: true, ms: Date.now() - t0, chars: 0,
      });
      return;
    }

    let text = '';
    let thinking = '';
    const calls = [];
    const st = await generateStream({
      model, system, contents, tools: gemTools, generationConfig: cfg,
      onChunk: (chunk) => {
        if (chunk.thought) thinking += chunk.thought;
        if (chunk.text) text += chunk.text;
        if (chunk.functionCall) calls.push(chunk.functionCall);
      },
    });

    const content = [];
    if (thinking) content.push({ type: 'thinking', thinking });
    if (text) content.push({ type: 'text', text });
    calls.forEach((call, i) => content.push({
      type: 'tool_use',
      id: rememberSignature('toolu_' + id.slice(-8) + i, call.thoughtSignature),
      name: call.name,
      input: call.args || {},
    }));

    record({
      kind: 'messages', model, tools: tools.length, calls: calls.length,
      ok: true, ms: Date.now() - t0, chars: text.length, preview: text.slice(0, 220),
    });
    return sendJson(res, 200, {
      id, type: 'message', role: 'assistant', model, content,
      stop_reason: calls.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: st?.usage?.promptTokenCount ?? 0,
        output_tokens: st?.usage?.candidatesTokenCount ?? 0,
      },
    });
  } catch (err) {
    record({ kind: 'messages', model, ok: false, ms: Date.now() - t0, error: err.message });
    if (!res.headersSent) return sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: err.message } });
    try { res.end(); } catch {}
  } finally {
    semaphore.release();
  }
}

async function handleApi(req, res, url) {
  // 面板永远只对回环开放：跨机接入只走 /v1，那里有 api key 兜底
  if (!isLoopback(req)) {
    return sendJson(res, 403, {
      ok: false,
      error: 'panel is loopback-only; use http://<this-host>:<port>/v1 with your api key',
    });
  }
  const route = url.pathname;

  // ---------------------------------------------------------------- 面板登录
  if (route === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (!passwordMatches(body?.password)) {
      record({ kind: 'auth', ok: false, error: 'bad password' });
      return sendJson(res, 401, { ok: false, error: '密码不正确' });
    }
    res.setHeader('set-cookie', sessionCookie(issueToken()));
    record({ kind: 'auth', ok: true });
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/auth/logout' && req.method === 'POST') {
    res.setHeader('set-cookie', clearCookie());
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/auth/status' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, authenticated: isAuthenticated(req) });
  }

  // ---------------------------------------------------------------- 账号
  if (route.startsWith('/api/accounts') || route.startsWith('/api/login')) {
    const body = req.method === 'POST' ? await readBody(req) : {};
    return handleAccountRoutes({ route, method: req.method, req, res, body, sendJson });
  }

  if (route === '/api/health') {
    return sendJson(res, 200, { ok: true, name: 'agy-key-bridge', version: VERSION });
  }

  if (route === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, await statusPayload());
  }

  if (route === '/api/proxy' && req.method === 'POST') {
    const body = await readBody(req);
    const enabled = Boolean(body.enabled);
    updateState({ proxyEnabled: enabled });
    log(`reverse proxy ${enabled ? 'enabled' : 'disabled'}`);
    return sendJson(res, 200, { ok: true, proxyEnabled: enabled });
  }

  if (route === '/api/proxyurl' && req.method === 'POST') {
    const body = await readBody(req);
    const proxyUrl = String(body.proxyUrl || '').trim();
    updateState({ proxyUrl });
    const { resetProxy, proxyUrl: effective } = await import('../http/http.mjs');
    resetProxy();
    return sendJson(res, 200, { ok: true, proxyUrl: effective() });
  }

  if (route === '/api/execmode' && req.method === 'POST') {
    const body = await readBody(req);
    const enabled = Boolean(body.enabled);
    updateState({ execMode: enabled });
    log(`agy exec mode ${enabled ? 'ON (--dangerously-skip-permissions)' : 'OFF (text only)'}`);
    return sendJson(res, 200, { ok: true, execMode: enabled });
  }

  if (route === '/api/autostart' && req.method === 'POST') {
    const body = await readBody(req);
    const enabled = Boolean(body.enabled);
    const result = setAutostart(enabled);
    if (result.ok) updateState({ autostart: enabled });
    return sendJson(res, result.ok ? 200 : 500, {
      ok: result.ok,
      autostart: enabled,
      registered: autostartInstalled(),
      error: result.error || null,
    });
  }

  if (route === '/api/model' && req.method === 'POST') {
    const body = await readBody(req);
    const model = String(body.model || '').trim();
    updateState({ model });
    return sendJson(res, 200, { ok: true, model });
  }

  if (route === '/api/lan' && req.method === 'POST') {
    const body = await readBody(req);
    const enabled = Boolean(body.enabled);
    updateState({ lanAccess: enabled });
    // 先回响应再换绑定，避免把这次请求自己踢掉
    sendJson(res, 200, { ok: true, lanAccess: enabled });
    setTimeout(() => {
      rebind()
        .then(() => log(`lan access ${enabled ? 'enabled on 0.0.0.0' : 'disabled (loopback only)'}`))
        .catch((err) => log(`rebind failed: ${err.message}`));
    }, 150);
    return;
  }

  if (route === '/api/models/refresh' && req.method === 'POST') {
    modelCache = await fetchModels({}).catch(() => modelCache);
    const models = modelCache;
    return sendJson(res, 200, { ok: true, models });
  }

  if (route === '/api/key/rotate' && req.method === 'POST') {
    const apiKey = rotateKey();
    log('api key rotated');
    return sendJson(res, 200, { ok: true, apiKey });
  }

  if (route === '/api/credentials' && req.method === 'GET') {
    invalidateCredentials();
    const cred = credentialSummary(await readCredentials(true));
    return sendJson(res, 200, { ok: cred.ok, account: cred });
  }

  if (route === '/api/logs' && req.method === 'DELETE') {
    clearLog();
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/logs') {
    return sendJson(res, 200, { ok: true, entries: recent(40), queue: semaphore.stats() });
  }

  if (route === '/api/export/dsh') {
    const credential = credentialSummary(await readCredentials());
    return sendJson(res, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      openai: {
        provider: 'agy',
        type: 'openai-compatible',
        baseURL: baseUrl(),
        apiKey: state.apiKey,
        model: state.model || modelCache[0]?.id,
      },
      anthropic: {
        provider: 'agy-anthropic',
        type: 'anthropic-compatible',
        baseURL: baseUrl(),
        apiKey: state.apiKey,
        model: state.model || modelCache[0]?.id,
      },
      account: {
        email: credential.email,
        authMethod: credential.authMethod,
        expiry: credential.expiry,
      },
    });
  }

  return sendJson(res, 404, { ok: false, error: `unknown api route: ${route}` });
}

// ---------------------------------------------------------------- static

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, url) {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('panel is loopback-only; /v1/* is the network entry point');
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const target = path.join(PANEL_DIR, rel);
  if (!target.startsWith(PANEL_DIR) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(target).pipe(res);
}

/**
 * 登录页。单独走一条路径，不参与认证 —— 否则进不去。
 * 同样只对回环开放（局域网访问只放 /v1）。
 */
function serveLogin(req, res) {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('panel is loopback-only; /v1/* is the network entry point');
  }
  const target = path.join(PANEL_DIR, 'login.html');
  if (!fs.existsSync(target)) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('login.html missing');
  }
  res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
  fs.createReadStream(target).pipe(res);
}

/** 已登录时再访问登录页，直接送回面板。 */
function redirectToPanel(res) {
  res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
  res.end();
}

/** 未登录时把页面请求打到登录页，而不是返回 401 —— 浏览器体验更好。 */
function redirectToLogin(res) {
  res.writeHead(302, { location: '/login', 'cache-control': 'no-store' });
  res.end();
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${state.port}`);
  try {
    // --- 公开路由：健康检查、登录接口、登录页 ---
    if (url.pathname === '/api/health') return await handleApi(req, res, url);
    if (url.pathname.startsWith('/api/auth/')) return await handleApi(req, res, url);

    if (url.pathname === '/login') {
      if (req.method === 'GET' && isAuthenticated(req)) return redirectToPanel(res);
      return serveLogin(req, res);
    }

    // --- 面板 API：必须登录 ---
    if (url.pathname.startsWith('/api/')) {
      if (!isAuthenticated(req)) return sendJson(res, 401, { ok: false, error: '请先登录' });
      return await handleApi(req, res, url);
    }

    // --- 模型端点：靠 api key 鉴权，与面板登录无关 ---
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const models = await loadModels();
      return sendJson(res, 200, {
        object: 'list',
        data: models.map((m) => ({
          id: m.id, object: 'model', created: 0, owned_by: 'antigravity',
          context_window: m.maxTokens, max_output_tokens: m.maxOutputTokens,
        })),
      });
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return await handleChatCompletions(req, res);
    }
    if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') {
      const body = await readBody(req);
      const { system, contents } = anthropicToGemini(body);
      const size = String(system || '').length + JSON.stringify(contents || []).length;
      return sendJson(res, 200, { input_tokens: Math.max(1, Math.round(size / 4)) });
    }
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      return await handleAnthropicMessages(req, res);
    }
    if (url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, name: 'agy-key-bridge', version: VERSION });
    }
    if (url.pathname.startsWith('/v1/')) {
      return sendJson(res, 404, errorPayload(`unsupported endpoint ${url.pathname}`));
    }
    // 面板静态资源同样要登录，否则直接 GET / 就看到 Key 了
    if (!isAuthenticated(req)) return redirectToLogin(res);
    return serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) return sendJson(res, 500, { ok: false, error: err.message });
    try { res.end(); } catch {}
  }
});

async function listenWithFallback(port, host, attempts = 10) {
  for (let offset = 0; offset <= attempts; offset += 1) {
    try {
      await listenOn(port + offset, host);
      return { ok: true, port: port + offset };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') return { ok: false, error: err.message };
    }
  }
  return { ok: false, error: `no free port in ${port}..${port + attempts}` };
}

async function boot() {
  try {
    if (await ensureSeeded()) log('seeded antigravity account from windows credential manager');
  } catch (err) {
    log('account seeding skipped: ' + err.message);
  }

  const argv = new Set(process.argv.slice(2));
  const wantOpen = argv.has('--open');
  const silent = argv.has('--autostart');

  // 已有实例：不抢端口，直接把面板亮出来
  if (!silent && (await alreadyRunning())) {
    const url = `http://127.0.0.1:${state.port}/`;
    log(`already running →${url}`);
    if (wantOpen) {
      openPanel(url);
process.exit(2); // 让启动脚本知道我什么都没做
    }
    return;
  }

  if (state.autostart && !autostartInstalled()) {
    const r = setAutostart(true);
    log(`autostart registered on first run: ${r.ok ? 'yes' : 'failed: ' + r.error}`);
  }

  const host = state.lanAccess ? '0.0.0.0' : '127.0.0.1';
  const started = await listenWithFallback(state.port, host);
  if (!started.ok) {
    console.error(`[agy-bridge] cannot bind port ${state.port}: ${started.error}`);
    process.exit(1);
  }
  if (started.port !== state.port) updateState({ port: started.port });

  loadModels().catch(() => {});

  log(`panel    http://127.0.0.1:${started.port}/`);
  if (state.lanAccess) {
    const lans = lanCandidates();
    if (lans.length) {
      for (const c of lans) log(`lan      http://${c.address}:${started.port}/  (${c.iface})`);
    } else {
      log('lan      (no non-virtual IPv4 interface found)');
    }
  }
  log(`api base ${baseUrl()}`);
  log('upstream daily-cloudcode-pa.googleapis.com · project aicode-consumers');
  log(`proxy    ${state.proxyEnabled ? 'ON' : 'OFF'} | autostart ${state.autostart ? 'ON' : 'OFF'}`);

  if (wantOpen) openPanel(`http://127.0.0.1:${started.port}/`);
}

function gracefulShutdown(signal) {
  log(`${signal} received, shutting down`);
  const done = () => process.exit(0);
  setTimeout(done, 3000).unref();
  try {
    server.close(done);
    server.closeAllConnections?.();
  } catch {
    done();
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => gracefulShutdown(signal));

process.on('uncaughtException', (err) => log('uncaught:', err.message));
process.on('unhandledRejection', (err) => log('unhandled:', err?.message || err));

boot();
