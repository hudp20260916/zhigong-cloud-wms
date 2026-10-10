#!/usr/bin/env bash
# 啊平智能生产管理系统 —— 本地「桌面端 + 云服务器」一键同步
#
# 作用：把本机改好的代码平滑更新到腾讯云，并同步更新桌面端（本机启动器用的就是同一份代码），
#       最后做健康检查；失败自动回滚到上一版前端产物。
#
# 用法（在本机 Git Bash / 终端里，项目根目录执行）：
#   SSHPASS='服务器密码' bash deploy/sync-cloud.sh          # 常规更新
#   SSHPASS='服务器密码' bash deploy/sync-cloud.sh summary  # 更新 + 统一历史摘要
#   先做一次：           SSHPASS='服务器密码' bash deploy/sync-cloud.sh setup-key   # 装公钥，以后免密
#
# 环境变量（都有默认值，一般不用改）：
#   CLOUD_HOST / CLOUD_USER / APP_DIR / SERVICE / SSH_KEY / SSHPASS

set -euo pipefail

CLOUD_HOST="${CLOUD_HOST:-106.55.93.200}"
CLOUD_USER="${CLOUD_USER:-ubuntu}"
APP_DIR="${APP_DIR:-/opt/zhigong}"
SERVICE="${SERVICE:-zhigong}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_aping}"
MODE="${1:-}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
WORK_DIR="$(mktemp -d)"
STAMP="$(date +%Y%m%d-%H%M%S)"
PKG="zhigong-update-${STAMP}.tar.gz"

log() { printf '\033[1;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$1"; }
fail() { printf '\033[1;31m[失败]\033[0m %s\n' "$1" >&2; exit 1; }

if [ -n "${SSHPASS:-}" ] && ! command -v sshpass >/dev/null 2>&1; then
  fail "本机没有 sshpass。请先安装（MSYS2: pacman -S sshpass），或改用 setup-key 配免密后不带 SSHPASS 运行。"
fi

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=20)
[ -f "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")

if [ -n "${SSHPASS:-}" ]; then
  SSH=(sshpass -p "$SSHPASS" ssh "${SSH_OPTS[@]}" "$CLOUD_USER@$CLOUD_HOST")
  SCP=(sshpass -p "$SSHPASS" scp "${SSH_OPTS[@]}")
else
  SSH=(ssh "${SSH_OPTS[@]}" "$CLOUD_USER@$CLOUD_HOST")
  SCP=(scp "${SSH_OPTS[@]}")
fi

# ---------------------------------------------------------------- 免密初始化
if [ "$MODE" = "setup-key" ]; then
  log '准备本机密钥'
  [ -f "$SSH_KEY" ] || ssh-keygen -t ed25519 -f "$SSH_KEY" -N '' -C 'aping-sync' >/dev/null
  log '把公钥装到服务器（这一步需要密码，只此一次）'
  "${SSH[@]}" 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && sort -u ~/.ssh/authorized_keys > /tmp/ak 2>/dev/null || touch /tmp/ak; cat >> /tmp/ak; sort -u /tmp/ak > ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; rm -f /tmp/ak; echo "[服务器] 公钥已安装"' < "$SSH_KEY.pub"
  log '验证免密'
  ssh "${SSH_OPTS[@]}" "$CLOUD_USER@$CLOUD_HOST" 'echo "[服务器] 免密登录成功：$(whoami)@$(hostname)"'
  log "以后直接跑：bash deploy/sync-cloud.sh"
  exit 0
fi

# ------------------------------------------------------------ 1. 构建前端
log '第 1/5 步：构建前端产物'
if [ ! -d node_modules/@rollup/rollup-linux-x64-gnu ] && [ ! -d node_modules/@rollup/rollup-linux-x64-msvc ]; then
  log '  补装 rollup 原生二进制'
  npm i --no-save @rollup/rollup-linux-x64-gnu >/dev/null 2>&1 || true
fi
npm run build --workspace=web >/dev/null 2>&1 || fail '前端构建失败（服务器未做任何改动）'
[ -f web/dist/index.html ] || fail '构建产物不完整'

# ------------------------------------------------------------ 2. 打包
log '第 2/5 步：打包更新内容'
tar -czf "$WORK_DIR/$PKG" package.json server/package.json server/src shared web/dist
log "  打包完成 $(du -h "$WORK_DIR/$PKG" | cut -f1)"

# ------------------------------------------------------------ 3. 上传
log '第 3/5 步：上传到服务器'
"${SCP[@]}" "$WORK_DIR/$PKG" "$CLOUD_USER@$CLOUD_HOST:/tmp/$PKG" || fail '上传失败'
log '  上传完成'

# ------------------------------------------------- 4. 生成远端更新脚本
cat > "$WORK_DIR/remote.sh" <<EOS
set -e
APP_DIR="$APP_DIR"
SERVICE="$SERVICE"
PKG="$PKG"
STAMP="$STAMP"

echo '[服务器] 备份当前版本'
tar -czf /tmp/backup-\$STAMP.tar.gz -C "\$APP_DIR" server/src shared web/dist

echo '[服务器] 解包新版'
rm -rf /tmp/upd-\$STAMP && mkdir -p /tmp/upd-\$STAMP
tar -xzf /tmp/\$PKG -C /tmp/upd-\$STAMP

echo '[服务器] 覆盖后端源码'
cp -f /tmp/upd-\$STAMP/package.json "\$APP_DIR/package.json"
cp -f /tmp/upd-\$STAMP/server/package.json "\$APP_DIR/server/package.json"
rm -rf "\$APP_DIR/server/src" "\$APP_DIR/shared"
cp -r /tmp/upd-\$STAMP/server/src "\$APP_DIR/server/src"
cp -r /tmp/upd-\$STAMP/shared "\$APP_DIR/shared"

echo '[服务器] 检查依赖'
if [ ! -d "\$APP_DIR/node_modules/express" ]; then
  cd "\$APP_DIR" && npm ci --omit=dev
else
  echo '[服务器] 依赖已存在，跳过安装'
fi

echo '[服务器] 切换前端产物'
rm -rf "\$APP_DIR/web/dist"
cp -r /tmp/upd-\$STAMP/web/dist "\$APP_DIR/web/dist"

echo '[服务器] 数据库迁移无需手动执行（服务启动时会跑 migrate()，幂等）'

echo '[服务器] 重启服务'
sudo systemctl restart \$SERVICE

echo '[服务器] 健康检查'
sleep 9
HOME_CODE=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/ || echo 000)
API_CODE=\$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3001/api/auth/login -H 'Content-Type: application/json' -d '{}' || echo 000)
echo "[服务器] 首页=\$HOME_CODE 登录接口=\$API_CODE"

if [ "\$HOME_CODE" != "200" ]; then
  echo '[服务器] 健康检查未通过，回滚上一版'
  sudo systemctl stop \$SERVICE
  rm -rf "\$APP_DIR/server/src" "\$APP_DIR/shared" "\$APP_DIR/web/dist"
  mkdir -p "\$APP_DIR/web"
  tar -xzf /tmp/backup-\$STAMP.tar.gz -C "\$APP_DIR"
  sudo systemctl start \$SERVICE
  sleep 8
  echo "[服务器] 回滚后首页=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/)"
  exit 1
fi

rm -f /tmp/\$PKG
rm -rf /tmp/upd-\$STAMP
ls -dt /tmp/backup-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
echo '[服务器] 更新成功'
EOS

log '第 4/5 步：服务器端更新并重启'
"${SSH[@]}" 'bash -s' < "$WORK_DIR/remote.sh" || fail '服务器端更新失败（已尝试回滚，请登录服务器确认）'

# ------------------------------------------------------------ 5. 可选摘要
if [ "$MODE" = "summary" ]; then
  log '第 5/5 步：统一历史订单摘要'
  "${SSH[@]}" "cd $APP_DIR && ./node_modules/.bin/tsx server/src/scripts/normalize-order-summary.ts"
else
  log '第 5/5 步：跳过摘要统一（需要时用 bash deploy/sync-cloud.sh summary）'
fi

rm -rf "$WORK_DIR"

# ------------------------------------------------------------ 桌面端同步说明
log '完成。云端：http://106.55.93.200'
echo ''
echo '------------------------------------------------------------------'
echo '  桌面端同步：本机启动器直接读同一份代码，无需额外操作。'
echo '  双击「启动系统.bat」即为最新版（前端已重新构建到 web/dist）。'
echo '------------------------------------------------------------------'
