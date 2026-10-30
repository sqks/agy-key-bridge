/**
 * 渲染层：把 store 里的数据翻译成 DOM。
 *
 * 约定：
 *   - 所有函数都是「读 store / 读入参 → 写 DOM」，不发起请求，也不改 store；
 *   - 每个 renderXxx 只负责一个区块，互不调用（除 bar() 这种纯片段工具）；
 *   - 需要重新渲染时由 app.js 统一调度，避免互相触发。
 */

import { $, store, fmt, pct } from './core.js';

// ---------------------------------------------------------------- 片段

/**
 * 额度条。
 * 60% 以上绿色、20% 以上橙色、更低红色；没有数据时退化成标签，
 * 因为「上游没给配额」和「配额为 0」是两件事，不能都画成空条。
 */
export function bar(value) {
  const p = pct(value);
  if (p == null) return '<span class="tag">无数据</span>';
  const cls = p >= 60 ? '' : p >= 20 ? 'mid' : 'low';
  return (
    `<div class="row" style="gap:8px">` +
    `<div class="bar ${cls}"><i style="width:${p}%"></i></div>` +
    `<span style="font-family:var(--mono);font-size:11px;color:var(--muted)">${p}%</span>` +
    `</div>`
  );
}

// ---------------------------------------------------------------- 顶栏

export function renderTop() {
  const { status, accounts, activeId } = store;
  if (!status) return;

  const on = status.proxyEnabled;
  $('topState').className = 'pill ' + (on ? 'on' : 'off');
  $('topState').innerHTML = `<span class="dot"></span>${on ? '反代运行中' : '反代已关闭'}`;

  const current = accounts.find((a) => a.id === activeId);
  $('topAccount').textContent = current ? (current.email || current.id.slice(0, 8)) : '无账号';
  $('footVer').textContent = `v2 · ${status.models?.length || 0} models`;
}

// ---------------------------------------------------------------- 概览

export function renderOverview() {
  const { status, accounts } = store;
  if (!status) return;

  const on = status.proxyEnabled;
  $('mProxy').textContent = on ? '运行中' : '已关闭';
  $('mProxyNote').textContent = on ? `127.0.0.1:${status.port}` : '所有 /v1 请求返回 503';
  $('mModel').textContent = status.model || '—';
  $('mModelNote').textContent = `${status.models?.length || 0} 个可选`;
  $('mAccounts').textContent = accounts.length;

  // 所有账号里最紧的那个额度，作为「整体水位」
  const floors = accounts
    .map((a) => {
      const values = (a.quota?.models || []).map((m) => m.remaining).filter((v) => v != null);
      return values.length ? Math.min(...values) : null;
    })
    .filter((v) => v != null);
  $('mAccountsNote').textContent = floors.length
    ? `最低剩余 ${pct(Math.min(...floors))}%`
    : '未查询额度';

  $('proxyToggle').checked = on;
  $('autostartToggle').checked = Boolean(status.autostart);
  $('autostartInfo').textContent = status.autostartRegistered
    ? `已注册：${status.autostartCommand}`
    : (status.autostart ? '状态为开，但注册表 / systemd 未写入' : '未注册');

  // 反代关闭时把 Key 打码，避免截图外泄
  $('apiKey').textContent = on ? status.apiKey : status.apiKey.replace(/.(?=.{6})/g, '•');
  $('baseUrl').textContent = status.baseUrl;

  const external = status.addresses?.externalApiBase || '';
  $('extBase').textContent = external || '局域网访问未开启';
  $('copyExt').disabled = !external;

  renderModelSelect();
  renderLan();
  renderProxyField();
}

/** 模型下拉：用清单签名判断是否需要重建，避免每次轮询都把用户的选择冲掉。 */
function renderModelSelect() {
  const { status } = store;
  const select = $('modelSelect');
  const ids = (status.models || []).map((m) => m.id);
  const signature = ids.join(',');

  if (select.dataset.sig !== signature) {
    select.innerHTML = (status.models || [])
      .map((m) => `<option value="${m.id}">${m.displayName || m.id}${m.hidden ? ' · 隐藏' : ''}</option>`)
      .join('');
    select.dataset.sig = signature;
  }
  if (status.model) select.value = status.model;
}

function renderLan() {
  const { status } = store;
  const lan = status.addresses?.lanAccess;
  $('lanToggle').checked = Boolean(lan);
  $('lanInfo').textContent = lan
    ? '已开放：' + ((status.addresses.lan || []).map((x) => x.url).join('  ') || '未找到局域网网卡')
    : '关闭中，只有本机能访问';
}

function renderProxyField() {
  const { status } = store;
  const proxy = status.proxyUrl || '';
  $('proxyUrl').value = proxy;
  $('proxyInfo').textContent = proxy ? `当前出口经 ${proxy}` : '直连（未配置代理）';
}

// ---------------------------------------------------------------- 账号

export function renderAccounts() {
  const { accounts, activeId } = store;
  const rows = $('accountRows');

  if (!accounts.length) {
    rows.innerHTML = '<tr><td colspan="5" class="empty">还没有账号</td></tr>';
    return;
  }

  rows.innerHTML = accounts.map((account) => {
    const values = (account.quota?.models || []).map((m) => m.remaining).filter((v) => v != null);
    const floor = values.length ? Math.min(...values) : null;
    const isActive = account.id === activeId;
    const expiry = account.expiry ? new Date(account.expiry).toLocaleString('zh-CN') : '—';

    return `<tr>
      <td>
        <div style="font-weight:500">${account.email || account.id.slice(0, 8)}</div>
        <div style="font-family:var(--mono);font-size:10.5px;color:var(--muted)">${account.label || ''}</div>
      </td>
      <td>${isActive ? '<span class="tag accent">当前</span>' : '<span class="tag">备用</span>'}</td>
      <td>${bar(floor)}</td>
      <td class="mono">${expiry}</td>
      <td style="text-align:right;white-space:nowrap">
        ${isActive ? '' : `<button class="btn ghost" data-act="active" data-id="${account.id}">设为当前</button>`}
        <button class="btn ghost" data-act="refresh" data-id="${account.id}">刷新</button>
        <button class="btn ghost" data-act="token" data-id="${account.id}">复制 token</button>
        <button class="btn ghost danger" data-act="remove" data-id="${account.id}">删除</button>
      </td>
    </tr>`;
  }).join('');
}

// ---------------------------------------------------------------- 额度

export function renderQuota() {
  const { quotaModels, status } = store;
  const rows = $('quotaRows');

  if (!quotaModels.length) {
    rows.innerHTML = '<tr><td colspan="4" class="empty">暂无额度数据，点右上角「重新查询」</td></tr>';
    return;
  }

  rows.innerHTML = quotaModels.map((model) => `
    <tr>
      <td>
        <div style="font-weight:500">${model.displayName || model.id}</div>
        <div style="font-family:var(--mono);font-size:10.5px;color:var(--muted)">${model.id}</div>
      </td>
      <td>${bar(model.remaining)}</td>
      <td class="mono">${model.resetTime ? new Date(model.resetTime).toLocaleString('zh-CN') : '—'}</td>
      <td style="text-align:right">
        ${model.id === status?.model
          ? '<span class="tag accent">默认</span>'
          : `<button class="btn ghost" data-default="${model.id}">设为默认</button>`}
      </td>
    </tr>`).join('');
}

// ---------------------------------------------------------------- 接入配置

export function renderRelay() {
  const { status } = store;
  if (!status) return;

  const base = `http://127.0.0.1:${status.port}`;
  const key = status.apiKey;
  const external = status.addresses?.externalApiBase || '';
  const externalHost = external ? external.replace(/\/v1$/, '') : '';

  const snippets = {
    dsh: `baseURL: ${base}/v1\napiKey: ${key}\nmodel: ${status.model || ''}`,
    claude: `set ANTHROPIC_BASE_URL=${base}\nset ANTHROPIC_AUTH_TOKEN=${key}`,
    openai: `set OPENAI_BASE_URL=${base}/v1\nset OPENAI_API_KEY=${key}`,
    ext: external
      ? `set ANTHROPIC_BASE_URL=${externalHost}\nset ANTHROPIC_AUTH_TOKEN=${key}\nset OPENAI_BASE_URL=${external}`
      : '',
  };

  // 展示时把换行压成间隔，完整内容留在 dataset 里等复制按钮取
  for (const [kind, target] of [['dsh', 'rDsh'], ['claude', 'rClaude'], ['openai', 'rOpenai'], ['ext', 'rExt']]) {
    const el = $(target);
    el.textContent = snippets[kind] ? snippets[kind].replace(/\n/g, '   ') : '局域网访问未开启';
    el.dataset.full = snippets[kind];
  }
}

/** 把授权会话状态画到账号页的登录框里。 */
export function renderLogin(login) {
  const box = $('loginBox');
  if (!login || login.status === 'idle') {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  $('loginUrl').textContent = login.url || '—';
  $('loginUrl').dataset.full = login.url || '';

  const notes = {
    pending:
      `等待你在浏览器里完成授权。回调地址 ${login.redirectUri || ''}。` +
      (login.mode === 'oob'
        ? '这一种不需要回调可达 —— Google 会把授权码显示在页面上，复制回来粘下面即可。'
        : `若服务跑在远程服务器，请先做端口转发：ssh -L ${login.port}:127.0.0.1:${login.port} user@server`),
    done: '授权完成，账号已加入。',
    error: `授权失败：${login.error || 'unknown'}`,
    expired: '授权超时，重新点一次。',
    cancelled: '已取消。',
  };
  $('loginNote').textContent = notes[login.status] || login.status;
}

// ---------------------------------------------------------------- 日志

export function renderLogs(entries) {
  const rows = $('logRows');
  if (!entries.length) {
    rows.innerHTML = '<tr><td colspan="7" class="empty">暂无请求</td></tr>';
    return;
  }

  rows.innerHTML = entries.map((entry) => {
    const time = new Date(entry.ts).toLocaleTimeString('zh-CN');
    const result = entry.ok
      ? '<span class="tag" style="border-color:#bbf7d0;background:var(--ok-soft);color:var(--ok)">ok</span>'
      : `<span class="tag" style="border-color:#fecaca;background:var(--bad-soft);color:var(--bad)">${String(entry.error || 'fail').slice(0, 28)}</span>`;

    return `<tr>
      <td class="mono">${time}</td>
      <td>${entry.kind || '-'}</td>
      <td class="mono">${entry.model || '-'}</td>
      <td class="mono">${entry.calls ? entry.calls : '—'}</td>
      <td class="mono">${entry.ms != null ? entry.ms + 'ms' : '-'}</td>
      <td class="mono">${entry.chars != null ? fmt(entry.chars) : '-'}</td>
      <td style="text-align:right">${result}</td>
    </tr>`;
  }).join('');
}
