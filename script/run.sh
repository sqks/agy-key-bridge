#!/usr/bin/env sh
# Linux / macOS 入口：找到 Python，交给 start.py
set -e
cd "$(dirname "$0")/.."

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "没找到 Python 3.8+，先装一个再运行本脚本。" >&2
  echo "  Debian/Ubuntu: sudo apt install python3" >&2
  echo "  Fedora:        sudo dnf install python3" >&2
  echo "  macOS:         brew install python3" >&2
  exit 1
fi

exec "$PY" script/start.py "$@"
