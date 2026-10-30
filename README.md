# AGY Bridge

把 Antigravity（agy）的模型额度变成一条标准的 **OpenAI + Anthropic 双协议**端点。
dsh、Claude Code、Kimi Code 这类 agent 填上 baseURL 和 apiKey 就能直接用。

它不启动 `agy.exe`，只借用它的 OAuth 凭据直连上游，所以原生工具调用和思考过程
都能按协议透传。

---

## 这个项目做了什么

- **双协议端点**：`/v1/chat/completions`（OpenAI）与 `/v1/messages`（Anthropic），共用一把 key
- **原生工具调用**：`functionCall` 直出，多轮工具结果、`thoughtSignature` 回传都通，干活的是调用方
- **思考流**：Gemini 的 `thought` 片段转成 `reasoning_content` / `thinking` 块
- **账号池**：可放多份 refresh_token，自动换 access_token，某个账号失败自动换下一个
- **额度查询**：按账号查每个模型的剩余配额与重置时间
- **控制面板**：反代开关、API Key、模型选择、账号管理、接入配置、请求日志
- **开机自启**：Windows 写注册表，Linux 写 systemd user unit

---

## 使用说明

### 环境要求

- Python 3.8
- Node 20

### 启动

```bash
python script/start.py
```

Windows 也可以双击 `script/run.cmd`，Linux / macOS 用 `./script/run.sh`。

启动器分五步走：

```
1/5 环境检查   操作系统 / Python / 项目完整性 / Node 版本
2/5 依赖准备   缺 Node 会问你要不要装、装到哪
3/5 网络放行   开了局域网访问时，检查防火墙并自动放行端口
4/5 Nginx 反代 有 nginx 就问要不要挂上去；没有就问要不要装
5/5 启动       按系统选择前台或后台无窗口
```

第 3 步只在需要时出现：默认只监听 `127.0.0.1`，本机访问不用碰防火墙；只有开了
局域网访问才会检查，没规则就自动加（Windows `netsh`、Linux `ufw` / `firewalld`）。
加不上（权限不足）会把该手敲的命令打出来。

第 4 步检测到 nginx 会问你一句，同意后写一份独立配置
（`conf.d/agy-bridge.conf`）反代到本机端口。没有 nginx 时给三个选择：自动下载、
指定本地安装包、跳过。配置写完会先跑 `nginx -t`，不通过就回滚主配置。

常用参数：

| 参数 | 作用 |
|---|---|
| `--check` | 只体检，不启动 |
| `--yes` | 缺依赖 / 加防火墙规则 / 配 nginx 都自动确认 |
| `--install-dir <目录>` | 指定 Node 安装位置 |
| `--detach` | 后台启动 |
| `--no-open` | 不自动打开浏览器 |
| `--port <端口>` | 覆盖端口，默认 47913 |
| `--lan` | 本次启动开启局域网访问，并自动放行防火墙端口 |
| `--no-firewall` | 跳过防火墙检查 |
| `--nginx` | 无条件把面板挂到 nginx 上 |
| `--no-nginx` | 跳过 nginx 集成 |
| `--nginx-port <端口>` | nginx 监听端口，默认 8080 |
| `--nginx-dir <目录>` | 自动下载 nginx 时装到哪 |

`--lan` 只影响这一次启动（走环境变量），要长期生效就在面板里打开「局域网访问」。

### 面板登录

面板前有一道密码门，**默认密码 `admin123`**。改密码：面板打开后改
`data/state.json` 里的 `panelPassword`，重启生效。

登录态是 12 小时 HMAC 签名的 cookie，右上角「退出」即刻失效。签名密钥存在
`state.json` 的 `panelSecret`，换设备或删掉这一项，所有已登录会话立即作废。

面板不限制来源地址，**密码是唯一门槛**；`/v1/*` 不经过这道门 —— 那是给 agent 用的，靠 API Key 鉴权。

起来后浏览器打开 `http://127.0.0.1:47913/`，先看到登录页，输入密码才进面板。

### 配置账号

面板「账号」页三种方式任选：

- **浏览器授权登录**：授权后自动回调，什么都不用复制
- **登录（页面给码）**：Google 把授权码显示在页面上，复制粘贴回来，无头服务器用这个
- **粘贴 refresh_token**：从已有机器上取

命令行等价：

```bash
node tools/login.mjs --oob --print-token
```

### 接入

```powershell
# Claude Code
set ANTHROPIC_BASE_URL=http://127.0.0.1:47913
set ANTHROPIC_AUTH_TOKEN=sk-agy-xxxx
```

```powershell
# Kimi Code / 任意 OpenAI 兼容 agent
set OPENAI_BASE_URL=http://127.0.0.1:47913/v1
set OPENAI_API_KEY=sk-agy-xxxx
```

```yaml
# dsh
baseURL: http://127.0.0.1:47913/v1
apiKey:  sk-agy-xxxx
```

模型名可以随便填，匹配不上会落到面板选的默认模型。面板「接入」页可以把这几组配置一键复制。

### 部署到服务器

```powershell
powershell -ExecutionPolicy Bypass -File tools\pack.ps1
scp ..\agy-key-bridge.tar.gz user@server:/opt/
```

```bash
cd /opt && tar -xzf agy-key-bridge.tar.gz && cd agy-key-bridge
chmod +x script/run.sh && ./script/run.sh
```

把 `data/accounts.json` 一起拷过去就不用重新授权。服务器连不上 Google 时在面板
「接入 → 出网代理」填 HTTP 代理，或者设 `PROXY_URL` 环境变量。

### 公网访问

**面板不限制来源地址**——能不能连上只取决于服务监听在哪。访问控制靠密码门：任何来源都要先登录。

**一、前置 nginx 或 Caddy 做 TLS（推荐）**

服务只听 `127.0.0.1`，由 nginx 对外提供 HTTPS，密码和 Key 都不会明文上网：

```
bridge.example.com {
    reverse_proxy 127.0.0.1:47913;
}
```

启动器第 4 步就是干这个的（`--nginx` 可强制）。

**二、直接暴露端口**

启动时加 `--lan`，或在面板打开「局域网访问」——它控制的是监听地址（`127.0.0.1` ↔ `0.0.0.0`），
打开后面板和 `/v1` 都能从外部访问。

这条路上有三件事必须你自己确认：

- **改掉默认密码**。面板上就能改，`admin123` 放在公网上等于没有密码。
- **放行链路**：本机防火墙（启动器会做）、云安全组 `TCP 47913`、路由器端口映射。
- **明文风险**：这条路是 HTTP，密码和 API Key 会原样经过网络。临时用可以，
  长期跑请回到方案一。面板上有钥匙图标的那一行就是明文 Key，谁嗅到谁能用。

`/v1/*` 与面板登录无关，它只认 API Key —— 用方案一时，agent 那边把 baseURL 指到
`https://bridge.example.com/v1` 即可。

---

## 查看日志

**面板「日志」页**：最近 40 次调用，含模型、工具调用数、耗时、字符数、成败。失败会直接
显示错误摘要。

**前台运行时**，Node 的日志直接打在终端：

```
[agy-bridge] panel    http://127.0.0.1:47913/
[agy-bridge] api base http://127.0.0.1:47913/v1
[agy-bridge] upstream daily-cloudcode-pa.googleapis.com · project aicode-consumers
[agy-bridge] proxy    ON | autostart ON
```

**后台运行时**：

- Windows：`data/launcher.log`
- Linux systemd：`journalctl --user -u agy-bridge -f`
- 手动起的话看启动时重定向到哪，默认没有落盘

启动器自己的判断（环境探测、下载进度、安装结果）只打在它自己的终端里，不写文件。
