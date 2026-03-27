#!/bin/bash
# Botook Agent — 一行命令安装、登录、启动
set -e

INSTALL_DIR="$HOME/.botook"
BIN_DIR="$INSTALL_DIR/bin"
REPO="https://botook.ai"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║        botook-agent installer        ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# 1. 检测系统
OS=$(uname -s)
ARCH=$(uname -m)
echo "● 系统: $OS $ARCH"

if [ "$OS" != "Darwin" ]; then
  echo "⚠ 目前仅支持 macOS，Windows/Linux 版本即将推出"
  exit 1
fi

# 2. 检查 Node.js
if ! command -v node &> /dev/null; then
  echo "✗ 需要 Node.js，请先安装: https://nodejs.org"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# 3. 创建安装目录
mkdir -p "$BIN_DIR"
echo "✓ 安装目录: $INSTALL_DIR"

# 4. 下载 agent（当前直接用 npx 运行源码）
if [ ! -d "$INSTALL_DIR/agent" ]; then
  echo "● 下载 botook-agent..."
  git clone --depth 1 https://github.com/yao00oo/social-proxy.git "$INSTALL_DIR/agent-repo" 2>/dev/null || true
  cp -r "$INSTALL_DIR/agent-repo/botook-agent" "$INSTALL_DIR/agent"
  rm -rf "$INSTALL_DIR/agent-repo"
  cd "$INSTALL_DIR/agent" && npm install 2>/dev/null
  echo "✓ 下载完成"
else
  echo "✓ botook-agent 已安装"
fi

# 5. 登录（如果还没登录）
if [ ! -f "$INSTALL_DIR/config.json" ]; then
  echo ""
  echo "● 正在打开浏览器登录..."
  cd "$INSTALL_DIR/agent" && npx ts-node src/cli.ts login
fi

# 6. 启动同步
echo ""
echo "● 开始同步..."
cd "$INSTALL_DIR/agent" && npx ts-node src/cli.ts start
