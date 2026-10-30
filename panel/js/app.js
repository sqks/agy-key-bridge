/**
 * 应用装配层：绑事件、串流程、开定时器。
 *
 * 这里不写渲染细节，也不写 HTTP 细节 —— 只负责「谁在什么时候触发什么」。
 * 读这个文件应该能一眼看出面板有哪些交互入口。
 */

import { $, store, api, copy, toast, loadStatus, loadAccounts, loadLogs, refreshAll, logout } from './core.js';
import {
  renderTop,
  renderOverview,
  renderAccounts,
  renderQuota,
  renderRelay,
  renderLogs,
  renderLogin,
} from './render.js';

const REFRESH_MS = 6000;

// ---------------------------------------------------------------- 刷新调度

/** 重画所有常驻区块。渲染函数彼此独立，这里按依赖顺序调一遍即可。 */
function paintAll() {
  renderTop();
  renderOverview();
  renderAccounts();
  renderQuota();
  renderRelay();
}

/** 首屏：并行拉数据再统一画，避免多次闪烁。 */
async function bootstrap() {
  await refreshAll();
  paintAll();
  const entries = await loadLogs().catch(() => []);
  renderLogs(entries);
}

// ---------------------------------------------------------------- 导航

$('nav').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-page]');
  if (!button) return;

  store.page = button.dataset.page;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b === button));
  document.querySelectorAll('.page').forEach((page) => {
    page.classList.toggle('on', page.id === `page-${store.page}`);
  });

  // 切到数据页时补一次最新数据，避免看到过期内容
  if (store.page === 'logs') loadLogs().then(renderLogs).catch(() => {});
  if (store.page === 'accounts') loadAccounts().then(() => {
    renderAccounts();
    renderQuota();
    renderTop();
  }).catch(() => {});
});

// ---------------------------------------------------------------- 概览开关

$('proxyToggle').addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  try {
    await api('/api/proxy', { method: 'POST', body: JSON.stringify({ enabled }) });
    await loadStatus();
    renderTop();
    renderOverview();
    toast(enabled ? '反向代理已开启' : '反向代理已关闭');
  } catch (err) {
    toast(`切换失败：${err.message}`, true);
    event.target.checked = !enabled;
  }
});

$('autostartToggle').addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  try {
    await api('/api/autostart', { method: 'POST', body: JSON.stringify({ enabled }) });
    await loadStatus();
    renderOverview();
    toast(enabled ? '开机启动已开启' : '开机启动已关闭');
  } catch (err) {
    toast(`切换失败：${err.message}`, true);
    event.target.checked = !enabled;
  }
});

$('lanToggle').addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  try {
    await api('/api/lan', { method: 'POST', body: JSON.stringify({ enabled }) });
    // 重新绑定监听要几百毫秒，稍等一下再刷新，否则会读到旧状态
    setTimeout(() => loadStatus().then(renderOverview).catch(() => {}), 900);
    toast(enabled ? '局域网访问已开启' : '局域网访问已关闭');
  } catch (err) {
    toast(`切换失败：${err.message}`, true);
    event.target.checked = !enabled;
  }
});

$('saveProxy').addEventListener('click', async () => {
  try {
    const data = await api('/api/proxyurl', {
      method: 'POST',
      body: JSON.stringify({ proxyUrl: $('proxyUrl').value.trim() }),
    });
    await loadStatus();
    renderOverview();
    toast(data.proxyUrl ? `代理已设为 ${data.proxyUrl}` : '已切回直连');
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
});

// ---------------------------------------------------------------- Key 与模型

$('copyKey').addEventListener('click', () => copy(store.status?.apiKey, 'API Key'));
$('copyBase').addEventListener('click', () => copy(store.status?.baseUrl, 'Base URL'));
$('copyExt').addEventListener('click', () => copy(store.status?.addresses?.externalApiBase, '跨机 Base URL'));

$('rotateKey').addEventListener('click', async () => {
  try {
    await api('/api/key/rotate', { method: 'POST', body: '{}' });
    await loadStatus();
    renderOverview();
    toast('已换新 Key');
  } catch (err) {
    toast(`换钥失败：${err.message}`, true);
  }
});

$('modelSelect').addEventListener('change', async (event) => {
  try {
    await api('/api/model', { method: 'POST', body: JSON.stringify({ model: event.target.value }) });
    await loadStatus();
    renderOverview();
    renderQuota();
    toast('默认模型已切换');
  } catch (err) {
    toast(`切换失败：${err.message}`, true);
  }
});

$('reloadModels').addEventListener('click', async () => {
  try {
    await api('/api/models/refresh', { method: 'POST', body: '{}' });
    await loadStatus();
    await loadAccounts();
    paintAll();
    toast('清单已刷新');
  } catch (err) {
    toast(`刷新失败：${err.message}`, true);
  }
});

// ---------------------------------------------------------------- 账号

$('addAccount').addEventListener('click', async () => {
  const refreshToken = $('newToken').value.trim();
  if (!refreshToken) {
    toast('先粘贴 refresh_token', true);
    return;
  }
  try {
    await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ refreshToken, label: $('newLabel').value.trim() }),
    });
    $('newToken').value = '';
    $('newLabel').value = '';
    await loadAccounts();
    paintAll();
    toast('账号已添加');
  } catch (err) {
    toast(`添加失败：${err.message}`, true);
  }
});

$('accountRows').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-act]');
  if (!button) return;

  const { act, id } = button.dataset;
  try {
    if (act === 'active') {
      await api(`/api/accounts/${encodeURIComponent(id)}/active`, { method: 'POST', body: '{}' });
      toast('已切换当前账号');
    } else if (act === 'refresh') {
      await api(`/api/accounts/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: '{}' });
      toast('token 已刷新');
    } else if (act === 'token') {
      const data = await api(`/api/accounts/${encodeURIComponent(id)}/token`);
      await copy(data.refreshToken, 'refresh_token');
      return;
    } else if (act === 'remove') {
      if (!confirm('删除这个账号？')) return;
      await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('已删除');
    }
    await loadAccounts();
    paintAll();
  } catch (err) {
    toast(`操作失败：${err.message}`, true);
  }
});

$('refreshQuotaAll').addEventListener('click', async () => {
  try {
    for (const account of store.accounts) {
      await api(`/api/accounts/${encodeURIComponent(account.id)}/quota`, { method: 'POST', body: '{}' });
    }
    await loadAccounts();
    paintAll();
    toast('额度已刷新');
  } catch (err) {
    toast(`刷新失败：${err.message}`, true);
  }
});

$('quotaRefresh').addEventListener('click', async () => {
  if (!store.activeId) {
    toast('没有账号', true);
    return;
  }
  try {
    const data = await api(`/api/accounts/${encodeURIComponent(store.activeId)}/quota`, {
      method: 'POST',
      body: '{}',
    });
    store.quotaModels = data.quota?.models || [];
    renderQuota();
    toast('额度已更新');
  } catch (err) {
    toast(`查询失败：${err.message}`, true);
  }
});

$('quotaRows').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-default]');
  if (!button) return;
  try {
    await api('/api/model', { method: 'POST', body: JSON.stringify({ model: button.dataset.default }) });
    await loadStatus();
    renderOverview();
    renderQuota();
    toast('默认模型已切换');
  } catch (err) {
    toast(`切换失败：${err.message}`, true);
  }
});

// ---------------------------------------------------------------- 授权登录

/** 停掉轮询定时器（状态终态或用户取消时调）。 */
function stopLoginPolling() {
  if (store.loginTimer) {
    clearInterval(store.loginTimer);
    store.loginTimer = null;
  }
}

/**
 * 轮询一次登录状态。
 * pending 继续等；done 刷新账号池；其它终态停表。
 */
async function pollLogin() {
  const data = await api('/api/login/status');
  renderLogin(data.login);
  if (!data.login || data.login.status === 'pending') return;

  stopLoginPolling();
  if (data.login.status === 'done') {
    await loadAccounts();
    paintAll();
    toast('授权完成，账号已加入');
  }
}

/** mode: 'loopback' 走本地回调，'oob' 让 Google 把码显示在页面上。 */
async function beginLogin(mode) {
  try {
    const data = await api('/api/login/start', { method: 'POST', body: JSON.stringify({ mode }) });
    renderLogin(data.login);
    stopLoginPolling();
    store.loginTimer = setInterval(() => pollLogin().catch(() => {}), 2000);
  } catch (err) {
    toast(`启动授权失败：${err.message}`, true);
  }
}

$('startLogin').addEventListener('click', () => beginLogin('loopback'));
$('startLoginOob').addEventListener('click', () => beginLogin('oob'));

$('copyLoginUrl').addEventListener('click', () => copy($('loginUrl').dataset.full, '授权链接'));
$('openLogin').addEventListener('click', () => {
  const url = $('loginUrl').dataset.full;
  if (url) window.open(url, '_blank');
});

$('cancelLogin').addEventListener('click', async () => {
  try {
    const data = await api('/api/login/cancel', { method: 'POST', body: '{}' });
    renderLogin(data.login);
    stopLoginPolling();
  } catch (err) {
    toast(err.message, true);
  }
});

$('submitLoginCode').addEventListener('click', async () => {
  const input = $('loginCode').value.trim();
  if (!input) {
    toast('先粘贴授权码或回调 URL', true);
    return;
  }
  try {
    const data = await api('/api/login/complete', { method: 'POST', body: JSON.stringify({ input }) });
    renderLogin(data.login);
    stopLoginPolling();
    $('loginCode').value = '';
    await loadAccounts();
    paintAll();
    toast('授权完成，账号已加入');
  } catch (err) {
    toast(`提交失败：${err.message}`, true);
  }
});

// ---------------------------------------------------------------- 接入页复制

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', () => {
    const map = { dsh: 'rDsh', claude: 'rClaude', openai: 'rOpenai', ext: 'rExt' };
    const labels = { dsh: 'dsh 配置', claude: 'Claude Code 环境变量', openai: 'OpenAI 环境变量', ext: '跨机配置' };
    const kind = button.dataset.copy;
    copy($(map[kind]).dataset.full, labels[kind]);
  });
});

// ---------------------------------------------------------------- 日志

$('clearLog').addEventListener('click', async () => {
  try {
    await api('/api/logs', { method: 'DELETE' });
    renderLogs(await loadLogs());
    toast('日志已清空');
  } catch (err) {
    toast(`清空失败：${err.message}`, true);
  }
});

$('logoutBtn').addEventListener('click', () => logout());

$('refreshBtn').addEventListener('click', async () => {
  await refreshAll();
  paintAll();
  renderLogs(await loadLogs().catch(() => []));
  toast('已刷新');
});

// ---------------------------------------------------------------- 启动

bootstrap().catch((err) => {
  $('topState').innerHTML = '<span class="dot"></span>连接失败';
  toast(err.message, true);
});

// 常驻轮询：日志页只刷日志，其余页刷状态，减少无谓请求
setInterval(() => {
  if (store.page === 'logs') {
    loadLogs().then(renderLogs).catch(() => {});
  } else {
    loadStatus().then(() => {
      renderTop();
      renderOverview();
    }).catch(() => {});
  }
}, REFRESH_MS);
