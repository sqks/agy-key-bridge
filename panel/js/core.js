/**
 * 面板前端的基础设施层。
 *
 * 职责边界很窄，只做三件事：
 *   1. 拿数据 —— 所有 /api/* 调用都收口在 api() 里；
 *   2. 放数据 —— store 是唯一的前端状态容器，渲染层只读不写；
 *   3. 小工具 —— DOM 选择、轻提示、剪贴板、数字格式。
 *
 * 刻意不做的：不碰 innerHTML（那是 render.js 的事），不绑事件（那是 app.js 的事）。
 * 这样读这个文件时，脑子里只需要装"数据怎么来"。
 */

// ---------------------------------------------------------------- DOM

export const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 状态

/**
 * 前端唯一的状态容器。
 * 每次刷新接口都会整体替换这里的字段，渲染函数只读它，不回写。
 */
export const store = {
  status: null,      // /api/status 的完整响应
  accounts: [],      // 账号列表
  activeId: null,    // 当前使用的账号 id
  quotaModels: [],   // 当前账号的额度明细
  page: 'overview',  // 当前所在页
  loginTimer: null,  // 授权轮询定时器
};

// ---------------------------------------------------------------- 轻提示

let toastTimer = null;

/** 右下角浮出一条提示，2.2 秒后自动消失。bad=true 时是红色失败样式。 */
export function toast(message, bad = false) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2200);
}

// ---------------------------------------------------------------- 请求

/**
 * 统一的后端调用。
 * 后端约定：成功返回 { ok: true, ... } 或普通对象；失败返回 { ok: false, error }。
 * 这里把 HTTP 状态和业务 ok 一起判，抛出的 Error.message 直接可读。
 */
export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error?.message || data.error || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * 复制文本。
 * 优先用异步剪贴板 API（需要安全上下文），失败时退回 textarea + execCommand，
 * 这样从局域网地址打开面板也能复制。
 */
export async function copy(text, label = '内容') {
  if (!text) {
    toast('没有可复制的内容', true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} 已复制`);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`${label} 已复制`);
  }
}

// ---------------------------------------------------------------- 数字格式

/** 千分位；null 显示为破折号。 */
export function fmt(n) {
  return n == null ? '—' : Number(n).toLocaleString('zh-CN');
}

/** 0~1 的小数转百分比整数；null 原样返回。 */
export function pct(v) {
  return v == null ? null : Math.round(v * 100);
}

/** 退出面板登录：清 cookie 后回到登录页。 */
export async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } catch {
    // 即使请求失败也照样跳走，cookie 过期后同样进不来
  }
  location.replace('/login');
}

// ---------------------------------------------------------------- 数据加载

/** 拉服务状态：反代开关、Key、地址、模型清单、平台信息。 */
export async function loadStatus() {
  store.status = await api('/api/status');
  return store.status;
}

/** 拉账号池，顺带把当前账号的额度明细同步到 store。 */
export async function loadAccounts() {
  const data = await api('/api/accounts');
  store.accounts = data.accounts || [];
  store.activeId = data.activeId;
  const current = store.accounts.find((a) => a.id === store.activeId);
  store.quotaModels = current?.quota?.models || [];
  return data;
}

/** 拉请求日志。 */
export async function loadLogs() {
  const data = await api('/api/logs');
  return data.entries || [];
}

/**
 * 首屏与手动刷新用：三份数据并行拉，任何一份失败都不该拖垮其余。
 * 账号接口在没登录时会慢（要向上游查额度），所以单独 catch。
 */
export async function refreshAll() {
  const [status, , logs] = await Promise.all([
    loadStatus(),
    loadAccounts().catch(() => null),
    loadLogs().catch(() => null),
  ]);
  return { status, logs };
}
