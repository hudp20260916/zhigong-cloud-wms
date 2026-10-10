#!/usr/bin/env bash
# 腾讯云更新脚本（在服务器上用 ubuntu 用户执行）
#
# 用法（推荐一条命令搞定）：
#   curl -fsSL https://raw.githubusercontent.com/hudp20260916/zhigong-cloud-wms/main/deploy/update-cloud.sh | bash
#
# 或者进到应用目录手动执行：
#   cd /opt/zhigong && bash deploy/update-cloud.sh
#
# 做了什么：备份数据库 → 拉最新代码 → 装/补依赖 → 构建前端 → 重启服务 → 体检
# 特点：数据库不清空（igrations 由服务启动自动执行），体检不通过会提示回滚命令。

set -e

APP_DIR=${APP_DIR:-/opt/zhigong}
SERVICE=${SERVICE:-zhigong}
BRANCH=${BRANCH:-main}
STAMP=$(date +%Y%m%d-%H%M%S)
PORT=${PORT:-3001}

cd "$APP_DIR"

echo "==> 1/6 备份数据库（不清空，仅快照）"
mkdir -p "$APP_DIR/backups"
DB_FILE=$(systemctl show -p Environment "$SERVICE" --value 2>/dev/null | tr ' ' '\n' | grep '^DB_FILE=' | cut -d= -f2-)
DB_FILE=${DB_FILE:-$APP_DIR/server/data/app.db}
if [ -f "$DB_FILE" ]; then
  sqlite3 "$DB_FILE" ".backup '$APP_DIR/backups/app-$STAMP.db'" 2>/dev/null \
    || cp "$DB_FILE" "$APP_DIR/backups/app-$STAMP.db"
  echo "    已备份到 backups/app-$STAMP.db"
else
  echo "    未找到数据库文件：$DB_FILE（跳过）"
fi
# 只保留最近 7 份备份
ls -1t "$APP_DIR"/backups/app-*.db 2>/dev/null | tail -n +8 | xargs -r rm -f

echo "==> 2/6 拉取最新代码（分支 $BRANCH）"
if [ -d "$APP_DIR/.git" ]; then
  git fetch --depth 1 origin "$BRANCH" || echo "    拉取失败，沿用现有代码"
  git reset --hard "origin/$BRANCH"
else
  echo "    ⚠ 不是 git 仓库，跳过代码更新，请改用 tencent-cloud.sh 重新部署"
fi

echo "==> 3/6 安装依赖"
# 坑：npm 可能漏装 rollup 原生二进制导致 vite build 失败，这里统一兜底
if [ ! -d node_modules/@rollup/rollup-linux-x64-gnu ]; then
  npm i --no-save @rollup/rollup-linux-x64-gnu || true
fi
npm ci --omit=dev || npm ci || echo "    依赖安装异常，继续尝试启动"

echo "==> 4/6 构建前端（产物 web/dist，由后端托管）"
npm run build --workspace=web

echo "==> 5/6 重启服务"
sudo systemctl restart "$SERVICE"
sleep 8

echo "==> 6/6 体检"
HOME_CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || echo 000)
LOGIN_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}' || echo 000)
echo "    首页 $HOME_CODE / 登录接口 $LOGIN_CODE"

if [ "$HOME_CODE" = "200" ]; then
  echo "✅ 更新完成，外网访问：http://$(curl -s ifconfig.me 2>/dev/null || echo '<服务器公网IP>')"
else
  echo "❌ 体检未通过。回滚命令："
  echo "   cd $APP_DIR && sudo systemctl stop $SERVICE"
  echo "   git checkout -B $BRANCH HEAD@{1} 2>/dev/null || true"
  echo "   cp $APP_DIR/backups/app-$STAMP.db $DB_FILE"
  echo "   sudo systemctl start $SERVICE"
  echo "   查看日志：sudo journalctl -u $SERVICE -n 50 --no-pager"
  exit 1
fi
