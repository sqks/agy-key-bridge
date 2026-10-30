/**
 * thoughtSignature 台账。
 *
 * Gemini 3 返回 functionCall 时会附一段签名，下一轮回传历史必须原样带上，
 * 否则上游 400 "Function call is missing a thought_signature"。
 * 但 OpenAI / Anthropic 的 tool_call 结构里没有放签名的地方，所以按我们下发的
 * 调用 id 暂存，agent 回传时再用同一个 id 取回。
 *
 * 容量上限 2000、TTL 30 分钟。取不到时由 convert 层降级成文本描述，
 * 宁可丢一次结构化调用，也不让整个请求挂掉。
 */
const TTL_MS = 30 * 60 * 1000;
const MAX = 2000;

const store = new Map();

export function rememberSignature(callId, signature) {
  if (!callId || !signature) return callId;
  store.set(callId, { signature, at: Date.now() });
  if (store.size > MAX) {
    const cutoff = Date.now() - TTL_MS;
    for (const [key, value] of store) {
      if (value.at < cutoff || store.size > MAX) store.delete(key);
    }
  }
  return callId;
}

export function recallSignature(callId) {
  if (!callId) return null;
  const hit = store.get(callId);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    store.delete(callId);
    return null;
  }
  return hit.signature;
}

export function stats() {
  return { tracked: store.size };
}
