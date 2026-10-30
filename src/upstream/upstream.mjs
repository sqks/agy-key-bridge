/**
 * 上游模型接口：直连 daily-cloudcode-pa.googleapis.com。
 *
 * 这里不启动 agy，只借用它的 OAuth 凭据。三个必须做对的地方：
 *
 * 1. 域名 —— daily-cloudcode-pa 才是 agy 真正请求的那个；
 *    cloudcode-pa 会对这类客户端返回 403 SUBSCRIPTION_REQUIRED。
 * 2. project 字段 —— 固定 aicode-consumers，不是 default-cli-project。
 * 3. User-Agent —— 上游按 UA 判定 tier，缺了就是 403 "not a valid license"。
 *
 * 响应是 SSE，每帧包一层 { response: { candidates, usageMetadata } }。
 * parts 里可能同时出现正文、thought（思考过程）和 functionCall（原生工具调用），
 * 逐个回调给上层，由 convert 层翻译成 OpenAI / Anthropic 的 wire 格式。
 */
import crypto from 'node:crypto';
import { acquireToken } from '../accounts/accounts.mjs';
import { request, readAll } from '../http/http.mjs';

const BASE = 'https://daily-cloudcode-pa.googleapis.com';
const PROJECT = 'aicode-consumers';
const USER_AGENT =
  'antigravity/cli/1.4.10 (aidev_client; os_type=windows; arch=amd64; cl=1009308193; auth_method=consumer)';

let modelCache = { value: [], at: 0 };

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'user-agent': USER_AGENT,
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
}

async function token() {
  const { token: value } = await acquireToken();
  if (!value) throw new Error('no usable antigravity account');
  return value;
}

function postJson(path, body, authToken, signal) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      ...authHeaders(authToken || ''),
      'content-length': payload.length,
    },
    body: payload,
    signal,
  });
}

/** 列出真实可用模型（含配额、是否支持 thinking）。 */
export async function fetchModels({ signal } = {}) {
  if (Date.now() - modelCache.at < 300_000 && modelCache.value.length) return modelCache.value;
  const t = await token();
  const res = await postJson('/v1internal:fetchAvailableModels', { project: PROJECT }, t, signal);
  if (res.statusCode !== 200) {
    const text = await readAll(res);
    throw new Error(`fetchAvailableModels ${res.statusCode}: ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(await readAll(res));
  const models = Object.entries(data.models || {}).map(([id, m]) => ({
    id,
    displayName: m.displayName || id,
    maxTokens: m.maxTokens || 0,
    maxOutputTokens: m.maxOutputTokens || 0,
    supportsThinking: Boolean(m.supportsThinking),
    supportsImages: Boolean(m.supportsImages),
    provider: m.apiProvider || '',
    quota: m.quotaInfo?.remainingFraction ?? null,
    resetTime: m.quotaInfo?.resetTime || null,
  }));

  // fetchAvailableModels 不列 4-argon 这一批，但直接调是通的
  const extras = ['gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-4-argon-low'];
  for (const id of extras) {
    if (models.some((m) => m.id === id)) continue;
    models.unshift({
      id,
      displayName: 'Gemini 4 Argon (' + id.split('-').pop().replace(/^./, (c) => c.toUpperCase()) + ')',
      maxTokens: 1000000,
      maxOutputTokens: 65536,
      supportsThinking: true,
      supportsImages: true,
      provider: 'API_PROVIDER_GOOGLE_GEMINI',
      quota: null,
      resetTime: null,
      hidden: true,
    });
  }

  modelCache = { value: models, at: Date.now() };
  return models;
}

export async function resolveModel(requested) {
  const models = await fetchModels().catch(() => []);
  const ids = models.map((m) => m.id);
  if (!ids.length) return requested || 'gemini-3.5-flash-lite';
  if (requested && ids.includes(requested)) return requested;
  const hint = String(requested || '').toLowerCase();
  return (
    ids.find((id) => hint.includes('opus') && id.includes('opus')) ||
    ids.find((id) => hint.includes('sonnet') && id.includes('sonnet')) ||
    ids.find((id) => hint.includes('haiku') && id.includes('haiku')) ||
    ids.find((id) => hint.includes('claude') && id.startsWith('claude')) ||
    ids.find((id) => hint.includes('flash') && id.includes('flash')) ||
    ids.find((id) => hint.includes('gemini') && id.includes('gemini')) ||
    ids.find((id) => hint.includes('gpt') && id.includes('gpt')) ||
    ids[0]
  );
}

function newSessionId() {
  return crypto.randomBytes(8).readBigInt64LE().toString();
}

/**
 * 调一次 streamGenerateContent，把上游 SSE 帧逐块交给 onChunk。
 * chunk 形如 { text, thought, functionCall, thoughtSignature }
 */
export async function generateStream({
  model,
  sessionId,
  system,
  contents,
  tools,
  generationConfig = {},
  signal,
  onChunk,
  requestType = 'agent',
}) {
  const t = await token();
  const body = {
    project: PROJECT,
    requestId: crypto.randomUUID(),
    request: {
      contents,
      ...(system ? { systemInstruction: { role: 'user', parts: [{ text: system }] } } : {}),
      generationConfig,
      sessionId: sessionId || newSessionId(),
      ...(tools && tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
    },
    model,
    userAgent: 'antigravity',
    requestType,
  };

  const res = await postJson('/v1internal:streamGenerateContent?alt=sse', body, t, signal);

  if (res.statusCode !== 200) {
    const text = await readAll(res);
    let detail = text;
    try {
      detail = JSON.parse(text).error?.message || text;
    } catch {}
    throw new Error(`upstream ${res.statusCode}: ${String(detail).slice(0, 300)}`);
  }

  let buf = '';
  const state = { usage: null, finishReason: null, modelVersion: null, responseId: null };

  for await (const piece of res) {
    buf += piece.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        continue;
      }
      const response = frame.response || frame;
      if (response.usageMetadata) state.usage = response.usageMetadata;
      if (response.modelVersion) state.modelVersion = response.modelVersion;
      if (response.responseId) state.responseId = response.responseId;
      const candidate = response.candidates?.[0];
      if (!candidate) continue;
      if (candidate.finishReason) state.finishReason = candidate.finishReason;
      for (const part of candidate.content?.parts || []) {
        if (typeof part.text === 'string' && part.text.length) {
          onChunk?.({
            text: part.thought ? '' : part.text,
            thought: part.thought ? part.text : '',
          });
        }
        if (part.functionCall) {
          onChunk?.({
            functionCall: { name: part.functionCall.name, args: part.functionCall.args || {} },
            thoughtSignature: part.thoughtSignature || null,
          });
        }
      }
    }
  }

  return state;
}
