/**
 * 协议转换层：OpenAI / Anthropic 请求 → Gemini 原生格式，以及响应字段的映射。
 *
 * 两个容易踩的坑都在这里收口：
 *
 * 1. tools schema
 *    Gemini 的校验比 agent 侧严格 —— 多余关键字（additionalProperties / $schema /
 *    title）直接 400；required 里出现 properties 没定义的键也 400。
 *    cleanSchema 负责剥键并修剪 required，两处都做过针对性验证。
 *
 * 2. thoughtSignature
 *    Gemini 3 要求回传 functionCall 时带上模型签发的思维签名，否则 400。
 *    签名由 signatures 模块按调用 id 暂存，这里在构造历史时取回。
 */
import crypto from 'node:crypto';
import { recallSignature } from '../signatures/signatures.mjs';

const DROP_SCHEMA_KEYS = new Set([
  '$schema', 'additionalProperties', 'title', 'default', 'examples', '$id', '$ref', 'definitions',
]);

/**
 * Gemini 的 Schema 只认一部分 JSON Schema 关键字，且校验比 agent 侧严：
 * - 多余关键字（additionalProperties / $schema / title …）直接 400
 * - required 里出现 properties 没定义的键，也 400
 * 所以这里既剥键也修 required。
 */
function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROP_SCHEMA_KEYS.has(key)) continue;
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      // Gemini 用 type 数组 + nullable 表达联合类型，这里取第一个可用分支
      const branch = Array.isArray(value) ? value.find((v) => v && typeof v === 'object') : null;
      if (branch) Object.assign(out, cleanSchema(branch));
      continue;
    }
    out[key] = cleanSchema(value);
  }

  if (!out.type && out.properties) out.type = 'object';
  if (out.type === 'array' && !out.items) out.items = { type: 'string' };

  if (Array.isArray(out.required)) {
    const props = out.properties && typeof out.properties === 'object' ? out.properties : {};
    const valid = out.required.filter(
      (key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(props, key),
    );
    if (valid.length) out.required = valid;
    else delete out.required;
  }

  if (out.type === 'object' && !out.properties) out.properties = {};
  if (out.type === 'object' && out.properties && typeof out.properties !== 'object') {
    delete out.properties;
  }

  return out;
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function safeJson(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

export function toGeminiTools(tools = []) {
  const out = [];
  for (const entry of Array.isArray(tools) ? tools : []) {
    const fn = entry?.function || entry;
    if (!fn?.name || !TOOL_NAME_RE.test(fn.name)) continue;
    const rawParams = fn.parameters ?? fn.input_schema;
    const parameters =
      rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
        ? cleanSchema(rawParams)
        : { type: 'object', properties: {} };
    out.push({
      name: fn.name,
      description: String(fn.description || '').slice(0, 1024),
      parameters,
    });
  }
  return out;
}

/** OpenAI chat/completions 请求体 → { system, contents } */
export function openAiToGemini(body) {
  const systems = [];
  const contents = [];
  const toolNames = new Map();
  for (const m of body.messages || []) {
    for (const call of m?.tool_calls || []) {
      if (call?.id && call.function?.name) toolNames.set(call.id, call.function.name);
    }
  }
  for (const msg of body.messages || []) {
    if (!msg) continue;
    const role = msg.role;
    if (role === 'system' || role === 'developer') {
      const t = textOf(msg.content);
      if (t) systems.push(t);
      continue;
    }
    if (role === 'tool' || role === 'function') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: toolNames.get(msg.tool_call_id) || msg.name || 'tool',
              response: { output: textOf(msg.content) },
            },
          },
        ],
      });
      continue;
    }
    if (role === 'assistant') {
      const parts = [];
      const t = textOf(msg.content);
      if (t) parts.push({ text: t });
      for (const call of msg.tool_calls || []) {
        const fn = call?.function || {};
        if (!fn.name) continue;
        const sig = recallSignature(call.id);
        if (sig) {
          parts.push({ functionCall: { name: fn.name, args: safeJson(fn.arguments) }, thoughtSignature: sig });
        } else {
          parts.push({ text: '[tool call ' + fn.name + '] ' + String(fn.arguments || '{}') });
        }
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    const t = textOf(msg.content);
    if (t) contents.push({ role: 'user', parts: [{ text: t }] });
  }
  return { system: systems.join('\n\n'), contents };
}

/** Anthropic messages 请求体 → { system, contents } */
export function anthropicToGemini(body) {
  const systems = [];
  const sys = body.system;
  if (typeof sys === 'string') systems.push(sys);
  else if (Array.isArray(sys)) {
    const t = sys.map((b) => (typeof b === 'string' ? b : b?.text || '')).filter(Boolean).join('\n');
    if (t) systems.push(t);
  }

  const toolNames = new Map();
  for (const m of body.messages || []) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block?.type === 'tool_use' && block.id && block.name) toolNames.set(block.id, block.name);
    }
  }

  const contents = [];
  for (const msg of body.messages || []) {
    if (!msg) continue;
    const isModel = msg.role === 'assistant';
    const parts = [];
    const blocks = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: textOf(msg.content) }];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && block.text) parts.push({ text: block.text });
      else if (block.type === 'tool_use' && block.name) {
        const sig = recallSignature(block.id);
        if (sig) {
          parts.push({ functionCall: { name: block.name, args: safeJson(block.input) }, thoughtSignature: sig });
        } else {
          parts.push({ text: '[tool call ' + block.name + '] ' + JSON.stringify(block.input || {}) });
        }
      } else if (block.type === 'tool_result') {
        const name = toolNames.get(block.tool_use_id) || 'tool';
        parts.push({
          functionResponse: {
            name,
            response: { output: textOf(block.content) },
          },
        });
      }
    }
    if (parts.length) contents.push({ role: isModel ? 'model' : 'user', parts });
  }
  return { system: systems.join('\n\n'), contents };
}

export function generationConfig(body, { thinking = true } = {}) {
  const cfg = {};
  const max = body.max_tokens ?? body.max_completion_tokens;
  if (Number.isFinite(max) && max > 0) cfg.maxOutputTokens = Math.min(max, 65536);
  if (Number.isFinite(body.temperature)) cfg.temperature = body.temperature;
  if (Number.isFinite(body.top_p)) cfg.topP = body.top_p;
  if (thinking) {
    cfg.thinkingConfig = { includeThoughts: true };
  }
  return cfg;
}

export function openAiChunkBase(id, model, created) {
  return { id, object: 'chat.completion.chunk', created, model };
}

export function openAiDelta(content, model, id, created, extra = {}) {
  return {
    ...openAiChunkBase(id, model, created),
    choices: [{ index: 0, delta: content, finish_reason: null }],
    ...extra,
  };
}

export function toolCallId() {
  return 'call_' + crypto.randomBytes(12).toString('hex');
}

export function msgIdShort() {
  return 'msg_' + crypto.randomBytes(12).toString('hex');
}
