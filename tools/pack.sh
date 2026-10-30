#!/usr/bin/env bash
# 打包给 Linux 服务器：不含 data/（账号与密钥）和 node_modules
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=agy-bridge
OUT="../${NAME}.tar.gz"

rm -f "$OUT"
tar -czf "$OUT" \
  --exclude="${NAME}/data" \
  --exclude="${NAME}/node_modules" \
  --exclude="${NAME}/.git" \
  --exclude="${NAME}/__pycache__" \
  -C .. "$NAME"

SIZE=$(du -h "$OUT" | cut -f1)
echo "打包完成：$(cd .. && pwd)/${NAME}.tar.gz  (${SIZE})"
echo
echo "上传：  scp ${OUT} user@server:/opt/"
echo "解包：  ssh user@server 'cd /opt && tar -xzf ${NAME}.tar.gz && cd ${NAME} && chmod +x start.sh && ./start.sh'"
