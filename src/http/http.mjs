/**
 * 统一 HTTPS 出口。所有对 Google 的请求都从这里走，代理只配一处。
 *
 * 代理是自己实现的 CONNECT 隧道（TunnelAgent），原因：
 * - Node 原生 https.request 不读 HTTPS_PROXY，服务器上会直接连不通；
 * - 引 undici 的 ProxyAgent 要加依赖，而这个项目刻意保持零运行时依赖；
 * - CONNECT 隧道把域名交给代理端解析，本机 DNS 污染不影响结果。
 *
 * 只支持 http:// 与 https:// 代理，不认 SOCKS。
 * Clash 的 mixed-port 同时开 HTTP 与 SOCKS，填 http://127.0.0.1:7890 即可。
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';
import { loadState } from '../state/state.mjs';

/** 在代理上开 CONNECT 隧道，再在隧道里做 TLS。 */
class TunnelAgent extends https.Agent {
  constructor(proxy, options = {}) {
    super({ keepAlive: true, ...options });
    this.proxy = proxy instanceof URL ? proxy : new URL(proxy);
  }

  createConnection(options, callback) {
    const proxy = this.proxy;
    const targetHost = options.host;
    const targetPort = options.port || 443;
    const proxyPort = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);

    const socket = net.connect(proxyPort, proxy.hostname, () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`,
      );
    });

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('latin1');
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 16 * 1024) {
          socket.destroy();
          callback(new Error('proxy CONNECT response too large'));
        }
        return;
      }
      socket.off('data', onData);
      const statusLine = buffer.split('\r\n')[0] || '';
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
        socket.destroy();
        callback(new Error(`proxy CONNECT failed: ${statusLine}`));
        return;
      }
      const secure = tls.connect({ socket, servername: targetHost }, () => callback(null, secure));
      secure.once('error', (err) => callback(err));
    };

    socket.on('data', onData);
    socket.once('error', (err) => callback(err));
  }
}

let cache = { key: null, agent: null };

export function proxyUrl() {
  const state = loadState();
  const explicit = typeof state.proxyUrl === 'string' ? state.proxyUrl.trim() : '';
  return (
    explicit ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    ''
  );
}

function agent(explicit) {
  const url = explicit === undefined ? proxyUrl() : explicit;
  if (!url) return undefined;
  if (cache.key === url) return cache.agent;
  cache = { key: url, agent: new TunnelAgent(url) };
  return cache.agent;
}

export function resetProxy() {
  cache = { key: null, agent: null };
}

/** 发一个请求，resolve 到响应流。body 传 Buffer/string 或 undefined。 */
export function request(target, { method = 'GET', headers = {}, body, signal, proxy } = {}) {
  return new Promise((resolve, reject) => {
    const url = target instanceof URL ? target : new URL(target);
    const mod = url.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        signal,
        agent: agent(proxy),
      },
      resolve,
    );
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('upstream request timeout')));
    if (body != null) req.write(body);
    req.end();
  });
}

export function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

export async function requestJson(target, options = {}) {
  const res = await request(target, options);
  const text = await readAll(res);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let detail = text;
    try {
      detail = JSON.parse(text).error_description || JSON.parse(text).error?.message || text;
    } catch {}
    const err = new Error(`${res.statusCode}: ${String(detail).slice(0, 300)}`);
    err.status = res.statusCode;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from ${String(target)}`);
  }
}
