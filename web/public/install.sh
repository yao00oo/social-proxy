#!/bin/sh
# Social Proxy Terminal — 一行命令安装
# curl -fsSL https://botook.ai/install.sh | sh
set -e

INSTALL_DIR="$HOME/.socialproxy"
BIN_DIR="$INSTALL_DIR/bin"
REPO="https://botook.ai/terminal"

echo ""
echo "  Social Proxy Terminal"
echo ""

# 检测 Node.js >= 18
HAS_NODE=false
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 18 ] 2>/dev/null; then
    HAS_NODE=true
  fi
fi

if [ "$HAS_NODE" = false ]; then
  # 检测 bun
  if command -v bun >/dev/null 2>&1; then
    HAS_NODE=true  # bun 兼容 node API
  else
    echo "  未检测到 Node.js >= 18"
    echo "  正在安装 Bun..."
    curl -fsSL https://bun.sh/install | bash 2>/dev/null
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    echo ""
  fi
fi

# 创建目录
mkdir -p "$BIN_DIR"

# 下载编译好的 JS
echo "  下载中..."
for f in cli.js auth.js config.js http.js logger.js terminal.js; do
  curl -fsSL "$REPO/$f" -o "$BIN_DIR/$f"
done

# 下载 package.json 并安装依赖
curl -fsSL "$REPO/package.json" -o "$BIN_DIR/package.json"
cd "$BIN_DIR"
if command -v node >/dev/null 2>&1; then
  npm install --production --silent 2>/dev/null
elif command -v bun >/dev/null 2>&1; then
  bun install --production 2>/dev/null
fi

# 创建启动脚本
cat > "$BIN_DIR/socialproxy-terminal" << 'EOF'
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "$DIR/cli.js" "$@"
elif command -v bun >/dev/null 2>&1; then
  exec bun "$DIR/cli.js" "$@"
else
  echo "需要 Node.js 或 Bun"; exit 1
fi
EOF
chmod +x "$BIN_DIR/socialproxy-terminal"

# 加到 PATH
SHELL_RC="$HOME/.zshrc"
[ "$(basename "$SHELL")" = "bash" ] && SHELL_RC="$HOME/.bashrc"
if ! grep -q "socialproxy" "$SHELL_RC" 2>/dev/null; then
  printf '\n# Social Proxy Terminal\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$SHELL_RC"
fi
export PATH="$BIN_DIR:$PATH"

echo ""
echo "  ✓ 安装完成！"
echo ""
echo "  运行：socialproxy-terminal"
echo ""
echo "  如果提示找不到命令：source $SHELL_RC"
echo ""

# 直接启动
exec "$BIN_DIR/socialproxy-terminal"
