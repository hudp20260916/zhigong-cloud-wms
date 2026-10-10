#!/usr/bin/env bash
# 腾讯云轻量服务器一键部署（Ubuntu 22.04 / Debian 12）
#
# 用法（在服务器上用 root 执行）：
#   curl -fsSL https://raw.githubusercontent.com/hudp20260916/zhigong-cloud-wms/main/deploy/tencent-cloud.sh -o setup.sh
#   bash setup.sh
#
# 如果 GitHub 下载慢，就在本地把本仓库的 deploy/tencent-cloud.sh 内容
# 粘到控制台的「登录(WebShell)」里执行，效果一样。
#
# 脚本做了什么：装 Node 22 → 拉代码 → 装依赖 → 构建前端 → 写 systemd 服务 → 配每日备份
# 最终服务跑在 3001 端口，访问 http://<你的公网IP>:3001

set -e

APP_DIR=/opt/zhigong
REPO=${REPO:-https://github.com/hudp20260916/zhigong-cloud-wms.git}
# GitHub 拉不动时可以换成镜像，例如：
# REPO=https://ghfast.top/https://github.com/hudp20260916/zhigong-cloud-wms.git
PORT=${PORT:-3001}
JWT_SECRET=${JWT_SECRET:-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')}

echo "==> 1/6 安装 Node 22 与 git"
if ! command -v node >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg git
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> 2/6 获取代码"
mkdir -p "$(dirname "$APP_DIR")"
if [ -d "$APP_DIR/.git" ]; then
  cd "$APP_DIR" && git pull --ff-only || echo "拉取失败，沿用现有代码"
else
  rm -rf "$APP_DIR"
  git clone --depth 1 "$REPO" "$APP_DIR"
fi

echo "==> 3/6 安装依赖"
cd "$APP_DIR"
npm ci

echo "==> 4/6 构建前端（产物 web/dist，由后端直接托管）"
npm run build
mkdir -p "$APP_DIR/server/data"

echo "==> 5/6 写 systemd 服务"
cat > /etc/systemd/system/zhigong.service <<EOF
[Unit]
Description=Zhigong Cloud WMS
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/server
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=JWT_SECRET=$JWT_SECRET
Environment=DB_FILE=$APP_DIR/server/data/app.db
ExecStart=/bin/bash -lc 'cd $APP_DIR && exec ./node_modules/.bin/tsx server/src/index.ts'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable zhigong
systemctl restart zhigong

echo "==> 6/6 配每日备份（保留 7 天）"
cat > /usr/local/bin/zhigong-backup.sh <<'EOF'
#!/usr/bin/env bash
D=/opt/zhigong/server/data
[ -f "$D/app.db" ] || exit 0
mkdir -p /opt/zhigong/backups
cp "$D/app.db" "/opt/zhigong/backups/app-$(date +%F).db"
find /opt/zhigong/backups -name 'app-*.db' -mtime +7 -delete
EOF
chmod +x /usr/local/bin/zhigong-backup.sh
(crontab -l 2>/dev/null | grep -v zhigong-backup; echo "0 3 * * * /usr/local/bin/zhigong-backup.sh") | crontab -

sleep 3
echo
echo "================ 部署完成 ================"
echo "本机自检：  curl http://127.0.0.1:$PORT/api/health"
echo "外网访问：  http://<你的公网IP>:$PORT"
echo "服务状态：  systemctl status zhigong"
echo "查看日志：  journalctl -u zhigong -f"
echo "本次 JWT_SECRET：$JWT_SECRET"
echo "=========================================="
systemctl --no-pager status zhigong | head -12 || true
