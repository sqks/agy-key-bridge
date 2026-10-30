// 命令行登录：在无面板的环境里拿 refresh_token。
// 用法：node tools/login.mjs [--port 47914] [--print-token]
//
// 无头服务器上先做端口转发：
//   ssh -L 47914:127.0.0.1:47914 user@server
import { startLogin, loginState, cancelLogin, completeWithCode } from '../src/accounts/login.mjs';
import { list as listAccounts, activeId, revealRefreshToken } from '../src/accounts/accounts.mjs';

const args = process.argv.slice(2);
const portArg = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 47914;
const printToken = args.includes('--print-token');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mask(token) {
  if (!token) return '—';
  return `${token.slice(0, 12)}…${token.slice(-6)} (${token.length} chars)`;
}

const codeArgIndex = args.indexOf('--code');
const codeInput = codeArgIndex >= 0 ? args[codeArgIndex + 1] : '';

console.log('启动浏览器授权登录…\n');
const started = await startLogin({ port: portArg, mode: args.includes('--oob') ? 'oob' : 'loopback' });
console.log('1) 用浏览器打开这个地址完成授权：\n');
console.log('   ' + started.url + '\n');
console.log(`2) 回调地址是 ${started.redirectUri}`);
console.log(`   如果本机不是服务器，先做转发：ssh -L ${started.port}:127.0.0.1:${started.port} user@server\n`);
console.log('等待中…（Ctrl+C 取消）\n');

process.on('SIGINT', () => {
  cancelLogin();
  console.log('\n已取消。');
  process.exit(130);
});

if (codeInput) {
  console.log('用手动粘贴的授权码完成登录…');
  try {
    await completeWithCode(codeInput);
    const id = activeId();
    const account = listAccounts().find((a) => a.id === id);
    console.log('授权完成：' + (account?.email || id));
    console.log('  refresh_token: ' + (printToken ? revealRefreshToken(id) : mask(revealRefreshToken(id))));
    process.exit(0);
  } catch (err) {
    console.error('失败：' + err.message);
    cancelLogin();
    process.exit(1);
  }
}

for (;;) {
  await sleep(1500);
  const state = loginState();
  if (state.status === 'pending') {
    process.stdout.write('.');
    continue;
  }
  process.stdout.write('\n\n');
  if (state.status === 'done') {
    const id = activeId();
    const account = listAccounts().find((a) => a.id === id);
    console.log('授权完成。');
    console.log('  账号: ' + (account?.email || id));
    console.log('  当前账号池: ' + listAccounts().length + ' 个');
    if (printToken) {
      console.log('  refresh_token: ' + revealRefreshToken(id));
    } else {
      console.log('  refresh_token: ' + mask(revealRefreshToken(id)) + '（加 --print-token 输出完整值）');
    }
    console.log('\n账号已写入 data/accounts.json，服务会直接用它。');
    process.exit(0);
  }
  console.log('未完成：' + (state.error || state.status));
  process.exit(1);
}
