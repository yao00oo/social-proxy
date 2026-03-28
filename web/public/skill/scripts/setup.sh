#!/bin/bash
# Botook setup — 授权并配置数据库连接
set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

CONFIG_DIR="$HOME/.config/botook"
CONFIG_FILE="$CONFIG_DIR/config.json"

echo ""
echo -e "${GREEN}🌿 Botook 授权配置${NC}"
echo ""

# 检查是否已配置
if [ -f "$CONFIG_FILE" ]; then
  EXISTING_URL=$(cat "$CONFIG_FILE" | grep -o '"database_url":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$EXISTING_URL" ]; then
    echo -e "已有配置: ${BLUE}$CONFIG_FILE${NC}"
    echo -n "重新授权？(y/N): "
    read -r REPLY
    if [ "$REPLY" != "y" ] && [ "$REPLY" != "Y" ]; then
      echo "保持现有配置。"
      exit 0
    fi
  fi
fi

# 打开浏览器授权
echo "正在打开浏览器..."
echo -e "${YELLOW}请在浏览器中登录并点击「确认授权」${NC}"
echo ""

# macOS / Linux 兼容
if command -v open &> /dev/null; then
  open "https://botook.ai/connect?cli=1"
elif command -v xdg-open &> /dev/null; then
  xdg-open "https://botook.ai/connect?cli=1"
else
  echo "请手动打开: https://botook.ai/connect?cli=1"
fi

echo -n "请输入 6 位授权码: "
read -r CODE

if [ -z "$CODE" ]; then
  echo -e "${RED}授权码不能为空${NC}"
  exit 1
fi

# 用授权码换 DATABASE_URL
echo "验证授权码..."
RESPONSE=$(curl -fsSL "https://botook.ai/api/connect?code=$CODE" 2>/dev/null || echo '{"error":"请求失败"}')

# 解析响应
DB_URL=$(echo "$RESPONSE" | grep -o '"database_url":"[^"]*"' | cut -d'"' -f4)

if [ -z "$DB_URL" ]; then
  echo -e "${RED}授权失败，请检查授权码是否正确${NC}"
  echo "你也可以手动在 botook.ai 设置页获取 DATABASE_URL"
  echo -n "手动输入 DATABASE_URL: "
  read -r DB_URL
  if [ -z "$DB_URL" ]; then
    echo "已取消。"
    exit 1
  fi
fi

# 保存配置
mkdir -p "$CONFIG_DIR"
echo "{\"database_url\":\"$DB_URL\"}" > "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

echo ""
echo -e "${GREEN}✅ 授权成功！${NC}"
echo -e "配置已保存到: ${BLUE}$CONFIG_FILE${NC}"
echo ""

# 检测平台并配置 MCP
if command -v claude &> /dev/null; then
  echo "检测到 Claude Code，正在配置 MCP..."
  claude mcp add botook -e DATABASE_URL="$DB_URL" -- npx social-proxy-mcp 2>/dev/null && \
    echo -e "${GREEN}✅ MCP 已配置！试试说「看看消息」${NC}" || \
    echo -e "${YELLOW}自动配置失败，请手动添加 MCP server${NC}"
else
  echo "请在你的 AI 工具中添加 MCP server："
  echo "  Command: npx social-proxy-mcp"
  echo "  环境变量: DATABASE_URL=$DB_URL"
fi
echo ""
