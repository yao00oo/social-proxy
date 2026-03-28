#!/bin/sh
# Social Proxy iMessage 同步 — macOS 专属
# curl -fsSL https://botook.ai/install-imessage.sh | sh
set -e

echo ""
echo "  Social Proxy iMessage 同步"
echo ""

# 检查 macOS
if [ "$(uname -s)" != "Darwin" ]; then
  echo "  ✗ 仅支持 macOS"
  exit 1
fi

# 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ 需要 Node.js，请先安装: https://nodejs.org"
  exit 1
fi
echo "  ✓ Node.js $(node -v)"

INSTALL_DIR="$HOME/.socialproxy/imessage"
mkdir -p "$INSTALL_DIR"

# 下载 botook-agent
if [ ! -d "$INSTALL_DIR/node_modules" ]; then
  echo "  下载中..."
  cd "$INSTALL_DIR"
  npm init -y --silent >/dev/null 2>&1
  npm install botook-agent --silent 2>/dev/null || {
    # fallback: clone from git
    echo "  从 GitHub 下载..."
    cd /tmp
    rm -rf social-proxy-tmp
    git clone --depth 1 https://github.com/yao00oo/social-proxy.git social-proxy-tmp 2>/dev/null
    cp -r social-proxy-tmp/botook-agent/* "$INSTALL_DIR/"
    rm -rf social-proxy-tmp
    cd "$INSTALL_DIR" && npm install --production --silent 2>/dev/null
  }
fi

echo ""
echo "  ✓ 安装完成！"
echo ""

# 启动
cd "$INSTALL_DIR"
if [ -f "node_modules/.bin/botook-agent" ]; then
  exec npx botook-agent
elif [ -f "src/cli.ts" ]; then
  exec npx ts-node src/cli.ts
else
  echo "  ✗ 启动失败，请手动运行: cd $INSTALL_DIR && npx botook-agent"
fi
