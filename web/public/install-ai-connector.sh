#!/bin/bash
# Botook AI Connector — 让 Claude Code / OpenClaw / Cursor 连上你的社交消息数据
# 安装内容：下载 skill 文件（SKILL.md + setup.sh）到 AI 工具的 skills 目录
# curl -fsSL https://botook.ai/install-ai-connector.sh | bash

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${GREEN}🌿 Botook — 安装小林到你的 AI 工具${NC}"
echo ""

# 检测平台
PLATFORM=""
if command -v claude &> /dev/null; then
  PLATFORM="claude"
  echo -e "${BLUE}检测到 Claude Code${NC}"
elif command -v openclaw &> /dev/null; then
  PLATFORM="openclaw"
  echo -e "${BLUE}检测到 OpenClaw${NC}"
else
  echo "未检测到已知的 AI 工具，将安装为通用 skill。"
  PLATFORM="generic"
fi

# 创建 skill 目录
SKILL_DIR=""
if [ "$PLATFORM" = "claude" ]; then
  SKILL_DIR="$HOME/.claude/skills/botook"
elif [ "$PLATFORM" = "openclaw" ]; then
  SKILL_DIR="$HOME/.openclaw/skills/botook"
else
  SKILL_DIR="$HOME/.claude/skills/botook"
fi

mkdir -p "$SKILL_DIR/scripts"

# 下载 SKILL.md
echo "📥 下载 skill 文件..."
curl -fsSL "https://botook.ai/skill/SKILL.md" -o "$SKILL_DIR/SKILL.md"
curl -fsSL "https://botook.ai/skill/scripts/setup.sh" -o "$SKILL_DIR/scripts/setup.sh"
chmod +x "$SKILL_DIR/scripts/setup.sh"

echo ""
echo -e "${GREEN}✅ 安装完成！${NC}"
echo ""
echo "skill 已安装到: $SKILL_DIR"
echo ""

if [ "$PLATFORM" = "claude" ]; then
  echo "现在打开 Claude Code，说："
  echo -e "  ${YELLOW}/botook setup${NC}"
  echo "或者直接说："
  echo -e "  ${YELLOW}帮我连接 botook${NC}"
elif [ "$PLATFORM" = "openclaw" ]; then
  echo "现在在 OpenClaw 里说："
  echo -e "  ${YELLOW}/botook setup${NC}"
else
  echo "现在在你的 AI 工具里说："
  echo -e "  ${YELLOW}帮我连接 botook${NC}"
fi
echo ""
