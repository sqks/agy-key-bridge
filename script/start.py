#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AGY Bridge 启动器
=================

一条命令完成：环境检查 → 缺什么问你要不要装 → 按当前系统选启动方式 → 起服务。

为什么用 Python 做入口：它是三平台都预装或易装的通用运行时，而本项目真正的
业务在 Node 上跑。这个脚本只负责「把环境准备好、把 Node 服务拉起来」，不掺和业务。

支持的行为：
  python script/start.py                 交互式启动（缺 Node 会问你）
  python script/start.py --check         只做体检，不启动
  python script/start.py --yes           缺依赖时自动装，不再逐项询问
  python script/start.py --install-dir D 指定 Node 安装目录
  python script/start.py --no-open       启动但不自动开浏览器
  python script/start.py --detach        后台启动（Windows 无窗口）

退出码：0 正常结束；1 环境不满足；2 用户取消。
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

# 同目录的 nginx 模块；缺了也不影响主流程
try:
    import nginx
except ImportError:
    nginx = None

# ---------------------------------------------------------------- 常量

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "src" / "server" / "server.mjs"
PANEL = ROOT / "panel" / "index.html"
ENV_CACHE = ROOT / "data" / "env.json"

MIN_NODE_MAJOR = 20
DEFAULT_PORT = 47913
DEFAULT_NGINX_PORT = 8080

MIRRORS = [
    "https://nodejs.org/dist",
    "https://npmmirror.com/mirrors/node",
]

IS_WIN = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"
IS_LINUX = platform.system() == "Linux"

# ---------------------------------------------------------------- 输出

class C:
    """终端配色。Windows 10 之后默认支持 ANSI，老终端会自动退化成无色。"""
    RESET = "\033[0m"
    DIM = "\033[2m"
    BOLD = "\033[1m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    RED = "\033[31m"
    CYAN = "\033[36m"


def _enable_ansi() -> None:
    if not IS_WIN:
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
    except Exception:
        for name in ("RESET", "DIM", "BOLD", "GREEN", "YELLOW", "RED", "CYAN"):
            setattr(C, name, "")


def say(message: str = "", color: str = "") -> None:
    print(f"{color}{message}{C.RESET}" if color else message)


def ok(message: str) -> None:
    say(f"  ✓ {message}", C.GREEN)


def warn(message: str) -> None:
    say(f"  ! {message}", C.YELLOW)


def fail(message: str) -> None:
    say(f"  ✗ {message}", C.RED)


def section(title: str) -> None:
    say()
    say(title, C.BOLD)


def ask_yes_no(question: str, default: bool = True, assume_yes: bool = False) -> bool:
    if assume_yes:
        return default
    hint = "Y/n" if default else "y/N"
    try:
        answer = input(f"{question} [{hint}] ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        say()
        return False
    if not answer:
        return default
    return answer in ("y", "yes", "是", "1")


def ask_path(question: str, default: Path) -> Path:
    try:
        answer = input(f"{question}\n  默认 {default}\n  直接回车使用默认值: ").strip()
    except (EOFError, KeyboardInterrupt):
        say()
        return default
    if not answer:
        return default
    return Path(os.path.expanduser(os.path.expandvars(answer))).resolve()


# ---------------------------------------------------------------- 环境检查

def read_env_cache() -> dict:
    try:
        return json.loads(ENV_CACHE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_env_cache(data: dict) -> None:
    try:
        ENV_CACHE.parent.mkdir(parents=True, exist_ok=True)
        ENV_CACHE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass


def node_executable(home: Path) -> Path | None:
    """在给定的 Node 安装目录里找可执行文件。"""
    candidates = [
        home / ("node.exe" if IS_WIN else "bin/node"),
        home / "bin" / ("node.exe" if IS_WIN else "node"),
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def probe_node(path: Path) -> tuple[int, int, int] | None:
    """跑一次 `node -v`，成功返回 (major, minor, patch)。"""
    try:
        out = subprocess.run(
            [str(path), "-v"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode != 0:
            return None
        version = out.stdout.strip().lstrip("v")
        major, minor, patch = (version.split(".") + ["0", "0"])[:3]
        return int(major), int(minor), int(patch)
    except Exception:
        return None


def find_node() -> tuple[Path | None, tuple[int, int, int] | None, str]:
    """
    按优先级找一个可用的 Node：缓存 → PATH → 常见安装位置。
    返回 (路径, 版本, 来源说明)。
    """
    cache = read_env_cache()
    if cache.get("nodeHome"):
        candidate = node_executable(Path(cache["nodeHome"]))
        if candidate:
            version = probe_node(candidate)
            if version:
                return candidate, version, "上次安装的位置"

    on_path = shutil.which("node")
    if on_path:
        candidate = Path(on_path)
        version = probe_node(candidate)
        if version:
            return candidate, version, "PATH"

    guesses: list[Path] = []
    if IS_WIN:
        local = os.environ.get("LOCALAPPDATA")
        program = os.environ.get("ProgramFiles")
        if local:
            guesses.append(Path(local) / "Programs" / "nodejs")
        if program:
            guesses.append(Path(program) / "nodejs")
    else:
        guesses += [Path("/usr/local"), Path("/usr"), Path.home() / ".local" / "node"]

    for home in guesses:
        candidate = node_executable(home)
        if candidate:
            version = probe_node(candidate)
            if version:
                return candidate, version, str(home)

    return None, None, ""


def default_install_dir() -> Path:
    if IS_WIN:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "Programs" / "nodejs"
    return Path.home() / ".local" / "node"


def node_platform_tag() -> str:
    """把当前平台翻成 Node 官方发行包的标签。"""
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    if IS_WIN:
        return f"win-{arch}"
    if IS_MAC:
        return f"darwin-{arch}"
    return f"linux-{arch}"


def latest_lts() -> str:
    """从官方索引里挑最新的 LTS 版本号（形如 22.11.0）。"""
    for mirror in MIRRORS:
        try:
            with urllib.request.urlopen(f"{mirror}/index.json", timeout=20) as res:
                data = json.load(res)
            for entry in data:
                if entry.get("lts"):
                    return entry["version"].lstrip("v")
        except Exception:
            continue
    raise RuntimeError("拿不到 Node 版本列表，网络可能不通；可以手动安装后在 PATH 里放好 node")


def download(url: str, target: Path) -> None:
    """带进度地把文件下到 target。"""
    tmp = target.with_suffix(target.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "agy-bridge-installer"})
    with urllib.request.urlopen(request, timeout=60) as res, open(tmp, "wb") as fh:
        total = int(res.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = res.read(1 << 16)
            if not chunk:
                break
            fh.write(chunk)
            done += len(chunk)
            if total:
                percent = done * 100 // total
                mb = done / 1048576
                sys.stdout.write(f"\r  下载中 {percent:3d}%  {mb:6.1f} MB")
                sys.stdout.flush()
    sys.stdout.write("\r" + " " * 40 + "\r")
    tmp.replace(target)


def install_node(dest: Path, assume_yes: bool) -> Path | None:
    """下载并解压官方 Node 发行包，返回 node 可执行文件路径。"""
    version = latest_lts()
    tag = node_platform_tag()
    ext = "zip" if IS_WIN else "tar.xz"
    name = f"node-v{version}-{tag}"
    filename = f"{name}.{ext}"

    dest.mkdir(parents=True, exist_ok=True)
    say(f"  目标版本 {version}  平台 {tag}  目录 {dest}", C.DIM)

    last_error = None
    for mirror in MIRRORS:
        url = f"{mirror}/v{version}/{filename}"
        say(f"  尝试 {url}", C.DIM)
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                archive = Path(tmpdir) / filename
                download(url, archive)
                say("  解压中…", C.DIM)
                if ext == "zip":
                    with zipfile.ZipFile(archive) as zf:
                        zf.extractall(dest)
                else:
                    with tarfile.open(archive, "r:xz") as tf:
                        tf.extractall(dest)
            break
        except Exception as err:  # 换下一个镜像
            last_error = err
            warn(f"这个镜像失败：{err}")
    else:
        fail(f"下载失败：{last_error}")
        return None

    home = dest / name
    exe = node_executable(home)
    if not exe:
        fail(f"解压后没找到 node 可执行文件，检查 {home}")
        return None

    version_info = probe_node(exe)
    if not version_info or version_info[0] < MIN_NODE_MAJOR:
        fail("装完的版本仍然低于要求")
        return None

    write_env_cache({"nodeHome": str(home), "nodeVersion": ".".join(map(str, version_info))})
    ok(f"Node 已就绪：{exe}")
    say(f"  建议把 {home if not IS_WIN else home} 加入 PATH，以后就不必再依赖本脚本定位。", C.DIM)
    return exe


def check_project() -> bool:
    """确认跑的是完整源码，而不是缺文件的拷贝。"""
    problems = []
    if not SERVER.is_file():
        problems.append(f"缺少 {SERVER.relative_to(ROOT)}")
    if not PANEL.is_file():
        problems.append(f"缺少 {PANEL.relative_to(ROOT)}")
    if not problems:
        ok(f"项目文件完整（{ROOT.name}）")
        return True
    for item in problems:
        fail(item)
    say("  这个目录不是完整的项目根，请在解压后的项目目录里运行本脚本。", C.DIM)
    return False


def port_in_use(port: int) -> bool:
    import socket
    with socket.socket() as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) == 0


# ---------------------------------------------------------------- 防火墙

RULE_NAME = "AGY Bridge"


def state_lan_enabled() -> bool:
    """读 data/state.json 的 lanAccess，判断服务起来后会不会监听 0.0.0.0。"""
    try:
        data = json.loads((ROOT / "data" / "state.json").read_text(encoding="utf-8"))
        return bool(data.get("lanAccess"))
    except Exception:
        return False


def _usable_ipv4(ip: str) -> bool:
    """排掉回环、link-local 和 Clash 之类 TUN 的 fake-ip 段。"""
    if not ip:
        return False
    return not ip.startswith(("127.", "169.254.", "198.18.", "198.19.", "0."))


def local_ipv4_candidates() -> list[str]:
    """
    列出可能的局域网地址。标准库拿不到网卡名，分不清 VMware 之类的虚拟网卡，
    所以这里返回全部候选，让用户挑和自己同网段的那个，而不是硬猜一个。
    """
    import socket

    found: list[str] = []

    def add(ip: str) -> None:
        if _usable_ipv4(ip) and ip not in found:
            found.append(ip)

    # 内核按默认路由选出来的地址（不发包）
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("223.5.5.5", 53))
            add(sock.getsockname()[0])
        finally:
            sock.close()
    except Exception:
        pass

    # 回退/补充：按主机名解析
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            add(ip)
    except Exception:
        pass

    return found


def reach_hint(port: int) -> list[str]:
    """给「从别的机器验证」的命令，有几个候选就给几条。"""
    return [f"curl http://{ip}:{port}/v1/models" for ip in local_ipv4_candidates()[:3]]


def firewall_hint(port: int) -> str:
    """手动放行命令。自动放行失败时直接把它贴给用户。"""
    if IS_WIN:
        return (
            f'netsh advfirewall firewall add rule name="{RULE_NAME}" dir=in '
            f'action=allow protocol=TCP localport={port}'
        )
    if IS_LINUX:
        if shutil.which("ufw"):
            return f"sudo ufw allow {port}/tcp"
        if shutil.which("firewall-cmd"):
            return (
                f"sudo firewall-cmd --permanent --add-port={port}/tcp && "
                f"sudo firewall-cmd --reload"
            )
        return f"在你的防火墙里放行 TCP {port}"
    return f"在系统防火墙设置里放行 TCP {port}"


def firewall_rule_exists(port: int):
    """
    能否确认规则已存在：True / False，探测不了的平台返回 None。
    探测不改变系统状态，失败就当作"未知"，交给用户判断。
    """
    if IS_WIN:
        try:
            out = subprocess.run(
                ["netsh", "advfirewall", "firewall", "show", "rule", f"name={RULE_NAME}"],
                capture_output=True, text=True, timeout=10,
            )
            return out.returncode == 0
        except Exception:
            return False

    if IS_LINUX:
        if shutil.which("ufw"):
            try:
                out = subprocess.run(
                    ["sudo", "-n", "ufw", "status"],
                    capture_output=True, text=True, timeout=10,
                )
                if out.returncode == 0:
                    return f"{port}/tcp" in out.stdout or f"{port} " in out.stdout
            except Exception:
                pass
            return None
        if shutil.which("firewall-cmd"):
            try:
                out = subprocess.run(
                    ["firewall-cmd", "--list-ports"],
                    capture_output=True, text=True, timeout=10,
                )
                if out.returncode == 0:
                    return f"{port}/tcp" in out.stdout
            except Exception:
                pass
            return None

    return None


def firewall_allow(port: int):
    """
    尝试自动放行端口。返回 (成功, 说明)。
    Windows 需要管理员；Linux 用 sudo -n（免密）尝试，不会卡在密码提示上。
    """
    if IS_WIN:
        try:
            out = subprocess.run(
                ["netsh", "advfirewall", "firewall", "add", "rule", f"name={RULE_NAME}",
                 "dir=in", "action=allow", "protocol=TCP", f"localport={port}"],
                capture_output=True, text=True, timeout=20,
            )
            return out.returncode == 0, (out.stdout or out.stderr or "").strip()
        except Exception as err:
            return False, str(err)

    if IS_LINUX:
        if shutil.which("ufw"):
            try:
                out = subprocess.run(
                    ["sudo", "-n", "ufw", "allow", f"{port}/tcp"],
                    capture_output=True, text=True, timeout=30,
                )
                return out.returncode == 0, (out.stdout or out.stderr or "").strip()
            except Exception as err:
                return False, str(err)
        if shutil.which("firewall-cmd"):
            try:
                subprocess.run(
                    ["sudo", "-n", "firewall-cmd", "--permanent", f"--add-port={port}/tcp"],
                    capture_output=True, text=True, timeout=30,
                )
                out = subprocess.run(
                    ["sudo", "-n", "firewall-cmd", "--reload"],
                    capture_output=True, text=True, timeout=30,
                )
                return out.returncode == 0, (out.stdout or out.stderr or "").strip()
            except Exception as err:
                return False, str(err)
        return False, "没有找到 ufw 或 firewalld"

    return False, f"{platform.system()} 不支持自动放行"


# ---------------------------------------------------------------- 启动

def launch_foreground(node: Path, args: list[str], env: dict | None = None) -> int:
    """前台运行，日志直接打在终端上，Ctrl+C 结束。"""
    cmd = [str(node), str(SERVER)] + args
    say()
    say("启动命令：" + " ".join(cmd), C.DIM)
    say("按 Ctrl+C 停止服务。", C.DIM)
    say()
    try:
        return subprocess.call(cmd, cwd=str(ROOT), env=env)
    except KeyboardInterrupt:
        say("\n已停止。")
        return 0


def launch_detached(node: Path, args: list[str], env: dict | None = None) -> int:
    """后台运行：Windows 用 pythonw 关掉控制台，Unix 用 setsid 脱离终端。"""
    if IS_WIN:
        pythonw = Path(sys.executable).with_name("pythonw.exe")
        launcher = Path(__file__).resolve().parent / "launcher.py"
        if pythonw.is_file() and launcher.is_file():
            subprocess.Popen(
                [str(pythonw), str(launcher)],
                cwd=str(ROOT),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=env,
            )
            ok("已在后台启动（无窗口）")
            return 0
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
        subprocess.Popen(
            [str(node), str(SERVER)] + args,
            cwd=str(ROOT),
            creationflags=flags,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        ok("已在后台启动")
        return 0

    subprocess.Popen(
        [str(node), str(SERVER)] + args,
        cwd=str(ROOT),
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    ok("已在后台启动")
    return 0


# ---------------------------------------------------------------- 主流程

def main(argv: list[str] | None = None) -> int:
    _enable_ansi()

    parser = argparse.ArgumentParser(
        description="AGY Bridge 启动器：检查环境、按需安装 Node、按系统起服务",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--check", action="store_true", help="只体检，不启动")
    parser.add_argument("--yes", "-y", action="store_true", help="缺依赖时自动安装，不再询问")
    parser.add_argument("--install-dir", default="", help="指定 Node 安装目录")
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--detach", action="store_true", help="后台启动")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="服务端口，默认 47913")
    parser.add_argument("--lan", action="store_true", help="本次启动开启局域网访问（监听 0.0.0.0）")
    parser.add_argument("--no-firewall", action="store_true", help="不检查也不修改防火墙")
    parser.add_argument("--nginx", action="store_true", help="无条件把面板挂到 nginx 上")
    parser.add_argument("--no-nginx", action="store_true", help="跳过 nginx 集成")
    parser.add_argument("--nginx-port", type=int, default=0, help="nginx 监听端口，默认 8080")
    parser.add_argument("--nginx-dir", default="", help="nginx 安装目录（自动下载时用）")
    parser.add_argument("pass_through", nargs="*", help=argparse.SUPPRESS)
    opts = parser.parse_args(argv)

    say()
    say("  AGY Bridge", C.BOLD + C.CYAN)
    say("  Antigravity → OpenAI / Anthropic 中转站", C.DIM)
    say()

    section("1/5 环境检查")
    os_name = {"Windows": "Windows", "Darwin": "macOS"}.get(platform.system(), platform.system())
    ok(f"操作系统 {os_name} {platform.release()} ({platform.machine()})")
    py = platform.python_version()
    ok(f"Python {py}")
    if sys.version_info < (3, 8):
        fail("需要 Python 3.8 以上")
        return 1

    if not check_project():
        return 1

    node, version, source = find_node()
    need_install = node is None
    too_old = version is not None and version[0] < MIN_NODE_MAJOR

    if node and not too_old:
        ok(f"Node {'.'.join(map(str, version))}  ({node}) · 来源 {source}")
    elif node and too_old:
        warn(f"Node 版本过低：{'.'.join(map(str, version))}，需要 {MIN_NODE_MAJOR}+")
        need_install = True
    else:
        warn(f"没有找到 Node.js（需要 {MIN_NODE_MAJOR}+）")

    if opts.check:
        section("体检结果")
        say("  环境满足要求，可以启动。" if not need_install else "  需要补装 Node 才能启动。",
            C.GREEN if not need_install else C.YELLOW)
        return 0 if not need_install else 1

    section("2/5 依赖准备")
    if need_install:
        say("  本项目的业务跑在 Node 上，缺它不能启动。")
        say("  选项：", C.DIM)
        say("    1) 自动下载官方发行包（推荐）", C.DIM)
        say("    2) 我自己装，然后重新运行本脚本", C.DIM)
        say("    3) 退出", C.DIM)
        try:
            choice = input("  请选择 [1]: ").strip() or "1"
        except (EOFError, KeyboardInterrupt):
            say()
            return 2

        if choice == "3":
            say("  已退出。")
            return 2
        if choice == "2":
            say()
            say("  装好后把 node 放进 PATH，再运行：python script/start.py", C.YELLOW)
            return 2

        target_dir = Path(opts.install_dir).resolve() if opts.install_dir else default_install_dir()
        if not opts.install_dir and not opts.yes:
            target_dir = ask_path("  安装到哪个目录？", default_install_dir())

        try:
            node = install_node(target_dir, opts.yes)
        except Exception as err:
            fail(f"安装失败：{err}")
            return 1
        if not node:
            return 1
        version = probe_node(node)
        if not version or version[0] < MIN_NODE_MAJOR:
            fail("安装后的 Node 版本仍不可用")
            return 1
    else:
        ok("依赖齐全，无需安装")

    port = opts.port
    lan = opts.lan or state_lan_enabled()
    # 显式 --lan 代表"我就是要给别人连"，直接放行，不再多问一句
    auto_allow = opts.lan and not opts.no_firewall

    section("3/5 网络放行")
    if opts.no_firewall:
        say("  已跳过（--no-firewall）", C.DIM)
    elif not lan:
        say("  只监听 127.0.0.1，本机访问不需要放行防火墙。", C.DIM)
        say("  要让别的机器连，加 --lan 重新运行，或在面板里打开「局域网访问」。", C.DIM)
    else:
        exists = firewall_rule_exists(port)
        if exists is True:
            ok(f"防火墙已放行 TCP {port}")
        elif exists is False:
            warn(f"防火墙可能没放行 TCP {port}")
        else:
            warn("无法确认防火墙状态，如果别的机器连不上就手动放行（命令在下面）")

        if exists is not True:
            say(f"  端口 {port} · 监听 0.0.0.0", C.DIM)
            should_allow = auto_allow or opts.yes or ask_yes_no("  现在添加放行规则吗？", True, False)
            if should_allow:
                done, message = firewall_allow(port)
                if done:
                    ok("已添加放行规则")
                else:
                    fail(f"自动添加失败：{message or '权限不足'}")
                    say("  用管理员/root 执行：", C.DIM)
                    say("    " + firewall_hint(port), C.CYAN)
            else:
                say("  已跳过，记得手动放行：", C.DIM)
                say("    " + firewall_hint(port), C.CYAN)

        # 本机防火墙只是第一层，公网接入还有别的关卡，说清楚免得白折腾
        say()
        say("  这里只处理本机防火墙。云服务器的安全组、路由器端口映射要另外放行。", C.DIM)
        say("  要让公网直接连，先套一层 HTTPS —— /v1 是明文 HTTP，Key 会原样上网。", C.DIM)

        hints = reach_hint(port)
        if hints:
            say("  从另一台机器验证（挑和你同网段的地址，以面板「访问地址」为准）：", C.DIM)
            for line in hints:
                say("    " + line, C.DIM)

    section("4/5 Nginx 反代")
    nginx_port = opts.nginx_port or DEFAULT_NGINX_PORT
    if opts.no_nginx or nginx is None:
        say("  已跳过（--no-nginx）" if opts.no_nginx else "  跳过（没找到 nginx 模块）", C.DIM)
    else:
        info = nginx.detect()
        if info is None:
            warn("没有检测到 nginx")
            say("  挂到 nginx 的好处：换端口、套 TLS、和别的站点共存。", C.DIM)
            say("    1) 自动下载安装", C.DIM)
            say("    2) 我已有安装包，指定路径", C.DIM)
            say("    3) 跳过", C.DIM)
            try:
                choice = input("  请选择 [3]: ").strip() or "3"
            except (EOFError, KeyboardInterrupt):
                say()
                choice = "3"

            if choice == "1":
                target_dir = Path(opts.nginx_dir).resolve() if opts.nginx_dir else nginx.default_install_dir()
                if not opts.nginx_dir and not opts.yes:
                    target_dir = ask_path("  安装到哪个目录？", nginx.default_install_dir())
                try:
                    info = nginx.install_from_download(target_dir)
                except Exception as err:
                    fail(f"下载安装失败：{err}")
                    hint = nginx.package_manager_hint()
                    if hint:
                        say("  改用包管理器：", C.DIM)
                        say("    " + hint, C.CYAN)
            elif choice == "2":
                package = ask_path("  安装包路径（.zip / .tar.gz）", Path.home() / "Downloads")
                target_dir = ask_path("  安装到哪个目录？", nginx.default_install_dir())
                try:
                    info = nginx.install_from_file(package, target_dir)
                except Exception as err:
                    fail(f"解压安装失败：{err}")
            else:
                say("  已跳过，服务仍按原端口运行。", C.DIM)

        if info:
            version = info.get("version") or "?"
            ok(f"nginx {version} · {info['exe']}")
            wants = opts.nginx or ask_yes_no("  把面板挂到 nginx 上吗？", True, opts.yes)
            if wants:
                if not opts.nginx_port and not opts.yes:
                    try:
                        raw = input(f"  nginx 监听端口 [{DEFAULT_NGINX_PORT}]: ").strip()
                        if raw.isdigit():
                            nginx_port = int(raw)
                    except (EOFError, KeyboardInterrupt):
                        say()
                        nginx_port = DEFAULT_NGINX_PORT

                try:
                    site = nginx.write_site(info, nginx_port, port)
                    ok(f"配置已写入 {site}")
                    passed, message = nginx.test_config(info)
                    if passed:
                        ok("nginx -t 通过")
                        reloaded, note = nginx.reload_config(info)
                        if reloaded:
                            ok("已重载 nginx")
                            say(f"  面板：http://127.0.0.1:{nginx_port}/ （仍需登录密码）", C.GREEN)
                        else:
                            warn(f"重载失败：{note}")
                            say("  手动执行：nginx -s reload", C.DIM)
                    else:
                        fail("nginx -t 未通过，已回滚主配置")
                        if nginx.restore_backup(info):
                            say("  nginx.conf 已还原，检查上方报错后重试。", C.DIM)
                        first_line = (message or "").strip().splitlines()[0] if message else ""
                        if first_line:
                            say("  " + first_line, C.DIM)
                except Exception as err:
                    fail(f"写配置失败：{err}")
            else:
                say("  已跳过 nginx 配置。", C.DIM)

    section("5/5 启动")
    if port_in_use(port):
        warn(f"端口 {port} 已有服务在跑，直接打开面板")
        if not opts.no_open:
            open_panel(port)
        return 0

    args = []
    if not opts.no_open:
        args.append("--open")
    if opts.pass_through:
        args += opts.pass_through

    # --lan 通过环境变量传给 Node；不写 state.json，避免和面板开关互相打架
    child_env = os.environ.copy()
    if opts.lan:
        child_env["LAN_ACCESS"] = "1"
    if opts.port:
        child_env["PORT"] = str(port)

    say(f"  启动方式：{'后台无窗口' if opts.detach and IS_WIN else '前台'}"
        f"（{os_name}）{'·  局域网' if lan else '·  仅本机'}", C.DIM)

    if opts.detach:
        code = launch_detached(node, args, child_env)
        if code == 0 and not opts.no_open:
            wait_and_open(port)
        return code

    return launch_foreground(node, args, child_env)


def open_panel(port: int) -> None:
    url = f"http://127.0.0.1:{port}/"
    try:
        if IS_WIN:
            os.startfile(url)  # type: ignore[attr-defined]
        elif IS_MAC:
            subprocess.Popen(["open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.Popen(["xdg-open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ok(f"已打开面板 {url}")
    except Exception:
        say(f"  面板地址：{url}")


def wait_and_open(port: int, timeout: float = 12.0) -> None:
    """后台启动时等端口起来再开浏览器，避免打开一个连不上的页面。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_in_use(port):
            open_panel(port)
            return
        time.sleep(0.4)
    warn(f"服务没在 {timeout:.0f} 秒内就绪，稍后手动打开 http://127.0.0.1:{port}/")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        say("\n已取消。")
        sys.exit(130)
