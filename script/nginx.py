#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nginx 集成：检测安装、生成反代配置、校验并重载；缺 nginx 时引导安装。

放在单独的模块里，是因为这块逻辑和"启动服务"没有耦合 —— 有人只想跑 Node，
不想碰 nginx；有人已经有 nginx，只想让脚本把配置写好。

设计取舍：
- 配置写独立文件（conf.d/agy-bridge.conf），不去改用户的主配置；
- 只有在 nginx.conf 缺 include 时才动它，且改前备份、改后 nginx -t 校验，
  校验不过就回滚；
- proxy_buffering 必须关 —— 面板和 /v1 都是 SSE，缓冲会让流式失效。
"""

from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

IS_WIN = platform.system() == "Windows"
IS_LINUX = platform.system() == "Linux"

SITE_NAME = "agy-bridge.conf"
DEFAULT_LISTEN = 8080


# ---------------------------------------------------------------- 检测

def _candidate_paths() -> list[Path]:
    """优先 PATH，其次各平台常见安装位置。"""
    found: list[Path] = []

    on_path = shutil.which("nginx")
    if on_path:
        found.append(Path(on_path))

    guesses: list[Path] = []
    if IS_WIN:
        for env in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                guesses += [
                    Path(base) / "nginx" / "nginx.exe",
                    Path(base) / "Programs" / "nginx" / "nginx.exe",
                ]
        guesses.append(Path("C:/nginx/nginx.exe"))
    else:
        guesses += [Path("/usr/sbin/nginx"), Path("/usr/local/sbin/nginx"), Path("/usr/local/nginx/sbin/nginx")]

    for candidate in guesses:
        if candidate.is_file() and candidate not in found:
            found.append(candidate)

    return found


def _nginx_binary(home: Path) -> Path | None:
    """在安装目录里定位可执行文件。"""
    for candidate in (home / ("nginx.exe" if IS_WIN else "nginx"),
                      home / ("nginx.exe" if IS_WIN else "sbin/nginx"),
                      home / "bin" / "nginx"):
        if candidate.is_file():
            return candidate
    return None


def detect() -> dict | None:
    """
    找 nginx。返回 {exe, prefix, version, conf_dir}，找不到返回 None。
    prefix 用来跑 -p，conf_dir 是放配置的地方。
    """
    for exe in _candidate_paths():
        prefix = exe.parent
        version = None
        try:
            out = subprocess.run([str(exe), "-v"], capture_output=True, text=True, timeout=10)
            text = (out.stderr or "") + (out.stdout or "")
            match = re.search(r"nginx/(\d+\.\d+\.\d+)", text)
            if match:
                version = match.group(1)
        except Exception:
            continue

        conf_dir = _conf_dir(exe, prefix, version)
        return {"exe": exe, "prefix": prefix, "version": version, "conf_dir": conf_dir}

    return None


def _conf_dir(exe: Path, prefix: Path, version: str | None) -> Path:
    """Linux 上是 /etc/nginx，Windows 上是 <prefix>/conf。"""
    if IS_WIN:
        return prefix / "conf"
    for candidate in (Path("/etc/nginx"), prefix / "conf", Path("/usr/local/nginx/conf")):
        if candidate.is_dir():
            return candidate
    return prefix / "conf"


# ---------------------------------------------------------------- 配置

SITE_TEMPLATE = """# 由 AGY Bridge 启动器生成 —— 把面板和 /v1 反代到本机服务
# 上游：http://127.0.0.1:{upstream}
server {{
    listen {listen};
    server_name _;

    # 面板体积小，直接转发；SSE 不能被缓冲
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;

    location / {{
        proxy_pass http://127.0.0.1:{upstream};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
    }}
}}
"""


def site_path(info: dict) -> Path:
    return info["conf_dir"] / "conf.d" / SITE_NAME


def write_site(info: dict, listen_port: int, upstream_port: int) -> Path:
    """写反代配置，同时确保 nginx.conf 会 include 它。"""
    target = site_path(info)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        SITE_TEMPLATE.format(listen=listen_port, upstream=upstream_port),
        encoding="utf-8",
    )
    ensure_include(info)
    return target


def _http_block_span(text: str) -> tuple[int, int] | None:
    """
    找到 nginx.conf 里 http { ... } 的区间。
    nginx 配置是花括号嵌套的，这里做一次简单的计数匹配，够用且不引依赖。
    """
    start = re.search(r"\bhttp\s*\{", text)
    if not start:
        return None
    depth = 0
    index = start.end() - 1
    while index < len(text):
        char = text[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return start.end() - 1, index
        index += 1
    return None


def include_line(info: dict) -> str:
    directory = site_path(info).parent
    # Windows 上给绝对路径，避免相对路径随 -p 变化；Linux 上用通配更常见
    return f"    include {directory.as_posix()}/*.conf;" if IS_WIN else "    include conf.d/*.conf;"


def ensure_include(info: dict) -> bool:
    """
    确认 nginx.conf 会加载 conf.d/*.conf。返回 True 表示文件被改过。
    改前备份成 nginx.conf.agy-bak，只改一次。
    """
    nginx_conf = info["conf_dir"] / "nginx.conf"
    if not nginx_conf.is_file():
        return False

    text = nginx_conf.read_text(encoding="utf-8", errors="ignore")
    if "conf.d/*.conf" in text or SITE_NAME in text:
        return False

    span = _http_block_span(text)
    if not span:
        return False

    _, close_index = span
    line = include_line(info) + "\n"
    updated = text[:close_index] + "\n" + line + text[close_index:]

    backup = nginx_conf.with_suffix(".conf.agy-bak")
    try:
        if not backup.exists():
            backup.write_text(text, encoding="utf-8")
        nginx_conf.write_text(updated, encoding="utf-8")
        return True
    except Exception:
        return False


def restore_backup(info: dict) -> bool:
    """nginx -t 失败时把主配置还原回去。"""
    nginx_conf = info["conf_dir"] / "nginx.conf"
    backup = nginx_conf.with_suffix(".conf.agy-bak")
    if not backup.is_file():
        return False
    try:
        nginx_conf.write_text(backup.read_text(encoding="utf-8"), encoding="utf-8")
        return True
    except Exception:
        return False


def test_config(info: dict) -> tuple[bool, str]:
    """跑 nginx -t。Windows 上要带 -p 指定 prefix，否则找不到 conf。"""
    cmd = [str(info["exe"]), "-t"]
    if IS_WIN:
        cmd = [str(info["exe"]), "-t", "-p", str(info["prefix"])]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        message = ((out.stderr or "") + (out.stdout or "")).strip()
        return out.returncode == 0, message
    except Exception as err:
        return False, str(err)


def reload_config(info: dict) -> tuple[bool, str]:
    """重载配置。Linux 优先用 systemctl，失败退回 nginx -s。"""
    if not IS_WIN and shutil.which("systemctl"):
        try:
            out = subprocess.run(["systemctl", "reload", "nginx"], capture_output=True, text=True, timeout=30)
            if out.returncode == 0:
                return True, "systemctl reload nginx"
        except Exception:
            pass

    cmd = [str(info["exe"]), "-s", "reload"]
    if IS_WIN:
        cmd = [str(info["exe"]), "-s", "reload", "-p", str(info["prefix"])]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return out.returncode == 0, ((out.stderr or "") + (out.stdout or "")).strip()
    except Exception as err:
        return False, str(err)


def start_nginx(info: dict) -> tuple[bool, str]:
    """还没跑起来的 nginx 需要先 start，-s reload 会报错。"""
    cmd = [str(info["exe"])] if not IS_WIN else [str(info["exe"]), "-p", str(info["prefix"])]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        return out.returncode == 0, ((out.stderr or "") + (out.stdout or "")).strip()
    except Exception as err:
        return False, str(err)


# ---------------------------------------------------------------- 安装

def default_install_dir() -> Path:
    if IS_WIN:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home())
        return Path(base) / "Programs" / "nginx"
    return Path.home() / ".local" / "nginx"


def latest_windows_version() -> str:
    """从下载页抓一个稳定版本号，抓不到就用兜底值。"""
    try:
        with urllib.request.urlopen("https://nginx.org/en/download.html", timeout=20) as res:
            html = res.read().decode("utf-8", errors="ignore")
        versions = re.findall(r"nginx-(\d+\.\d+\.\d+)\.zip", html)
        if versions:
            return max(versions, key=lambda v: tuple(int(x) for x in v.split(".")))
    except Exception:
        pass
    return "1.27.4"


def download(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "agy-bridge-installer"})
    with urllib.request.urlopen(request, timeout=120) as res, open(target, "wb") as fh:
        total = int(res.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = res.read(1 << 16)
            if not chunk:
                break
            fh.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  下载中 {done * 100 // total:3d}%  {done / 1048576:6.1f} MB", end="")
    print("\r" + " " * 42 + "\r")


def unpack(archive: Path, dest: Path) -> Path:
    """解压安装包，返回找到 nginx 的目录。"""
    dest.mkdir(parents=True, exist_ok=True)
    if archive.suffix.lower() == ".zip":
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(dest)
    elif archive.name.endswith((".tar.gz", ".tgz", ".tar.xz")):
        mode = "r:xz" if archive.name.endswith(".tar.xz") else "r:gz"
        with tarfile.open(archive, mode) as tf:
            tf.extractall(dest)
    else:
        raise RuntimeError(f"不认识的包格式：{archive.name}")

    direct = _nginx_binary(dest)
    if direct:
        return direct.parent
    for child in sorted(dest.iterdir()):
        if child.is_dir():
            binary = _nginx_binary(child)
            if binary:
                return binary.parent
    raise RuntimeError("解压后没找到 nginx 可执行文件")


def install_from_file(archive: Path, dest: Path) -> dict | None:
    home = unpack(archive, dest)
    return reindex(home)


def install_from_download(dest: Path) -> dict | None:
    """Windows 走官方 zip；Linux 建议用包管理器，这里也支持源码包放进来。"""
    if not IS_WIN:
        raise RuntimeError("Linux 请用包管理器安装（apt install nginx / dnf install nginx），或改用本地安装包")

    version = latest_windows_version()
    filename = f"nginx-{version}.zip"
    url = f"https://nginx.org/download/{filename}"
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / filename
        download(url, archive)
        return install_from_file(archive, dest)


def reindex(home: Path) -> dict | None:
    """安装完重新探测一遍，顺便把 prefix 对齐到实际目录。"""
    info = detect()
    if info:
        return info
    binary = _nginx_binary(home)
    if not binary:
        return None
    return {"exe": binary, "prefix": binary.parent, "version": None, "conf_dir": _conf_dir(binary, binary.parent, None)}


def package_manager_hint() -> str:
    if IS_LINUX:
        if shutil.which("apt"):
            return "sudo apt update && sudo apt install -y nginx"
        if shutil.which("dnf"):
            return "sudo dnf install -y nginx"
        if shutil.which("yum"):
            return "sudo yum install -y nginx"
        if shutil.which("pacman"):
            return "sudo pacman -S nginx"
    return ""
