/**
 * OpenAI 风格的 SSE 帧与 usage 构造。
 *
 * 纯函数集合，不持有状态，也不感知上游协议 —— 只是把"怎么拼帧"这件事
 * 从业务代码里挪出来，免得各处手拼字符串。
 */
let seq = 0;

export function chatId() {
  seq = (seq + 1) % 1e6;
  return `chatcmpl-agy-${Date.now().toString(36)}${seq.toString(36)}`;
}

export function msgId() {
  seq = (seq + 1) % 1e6;
  return `msg_agy_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
}

export function sseData(res, payload) {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
}

export function sseEvent(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function sseComment(res, text = 'keepalive') {
  res.write(`: ${text}\n\n`);
}

export function openAiChunk({ id, model, created, delta, finish = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

export function openAiCompletion({ id, model, created, text, usage }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
    ],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: usage?.total_tokens ?? ((usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)),
    },
  };
}

export function usageFromAgy(usage, promptChars, answerChars = 0) {
  const estIn = Math.max(1, Math.round(promptChars / 4));
  const estOut = Math.max(1, Math.round(answerChars / 4));
  if (!usage) {
    return { prompt_tokens: estIn, completion_tokens: estOut, total_tokens: estIn + estOut };
  }
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? 0;
  // agy 某些轮次只给 total，或只给 thinking 统计；用本地估算补齐。
  if (!input && !output) {
    const fallbackIn = total || estIn;
    return {
      prompt_tokens: fallbackIn,
      completion_tokens: estOut,
      total_tokens: fallbackIn + estOut,
    };
  }
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: total || input + output,
  };
}

export function errorPayload(message, type = 'upstream_error', code = null) {
  return { error: { message, type, code, param: null } };
}
