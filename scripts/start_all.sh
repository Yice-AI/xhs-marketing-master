#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🚀 启动小红书营销工具..."
echo "   项目目录: $PROJECT_ROOT"
echo ""

cd "$PROJECT_ROOT"

echo "1️⃣  启动浏览器服务..."
bash "$SCRIPT_DIR/start_browser.sh"
if [ $? -ne 0 ]; then
    echo "❌ 浏览器服务启动失败"
    exit 1
fi
echo ""

echo "2️⃣  启动 MCP 服务..."
cd "$PROJECT_ROOT"
./bin/xiaohongshu-mcp-darwin-arm64 \
    --port :8080 \
    --cdp-url 'http://localhost:9222' \
    --user-data-dir "./browser_data/single_user_data_dir" \
    > backend/logs/mcp.log 2>&1 &

sleep 2

MCP_PID=$(lsof -ti :8080)
if [ -n "$MCP_PID" ]; then
    echo "   MCP PID: $MCP_PID"
else
    echo "   ⚠️  MCP 启动中..."
    MCP_PID=""
fi

PID_FILE="$PROJECT_ROOT/data/pids.txt"
if [ -f "$PID_FILE" ]; then
    sed -i '' '/^mcp=/d' "$PID_FILE" 2>/dev/null || sed -i '/^mcp=/d' "$PID_FILE"
fi
if [ -n "$MCP_PID" ]; then
    echo "mcp=$MCP_PID" >> "$PID_FILE"
fi

echo ""

echo "3️⃣  启动后端服务..."
cd "$PROJECT_ROOT"
python3 -m uvicorn backend.api.main:app --reload --port 8000 --host 0.0.0.0 > backend/logs/api.log 2>&1 &

sleep 3

BACKEND_PID=$(lsof -ti :8000 | head -1)
if [ -n "$BACKEND_PID" ]; then
    echo "   后端 PID: $BACKEND_PID"
else
    echo "   ⚠️  后端启动中..."
    BACKEND_PID=""
fi

PID_FILE="$PROJECT_ROOT/data/pids.txt"
if [ -f "$PID_FILE" ]; then
    sed -i '' '/^backend=/d' "$PID_FILE" 2>/dev/null || sed -i '/^backend=/d' "$PID_FILE"
fi
if [ -n "$BACKEND_PID" ]; then
    echo "backend=$BACKEND_PID" >> "$PID_FILE"
fi

echo ""

echo "4️⃣  启动前端服务..."
cd "$PROJECT_ROOT"
npm run dev -- --port 3000 --host 0.0.0.0 > logs/frontend.log 2>&1 &
FRONTEND_PID=$!
echo "   前端 PID: $FRONTEND_PID"

if [ -f "$PID_FILE" ]; then
    sed -i '' '/^frontend=/d' "$PID_FILE" 2>/dev/null || sed -i '/^frontend=/d' "$PID_FILE"
fi
echo "frontend=$FRONTEND_PID" >> "$PID_FILE"

sleep 3
echo ""

LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)

echo "✅ 所有服务已启动！"
echo ""
echo "📝 本地访问地址:"
echo "   前端:    http://localhost:3000"
echo "   后端:    http://localhost:8000"
echo "   MCP:     http://localhost:8080"
echo "   API文档: http://localhost:8000/docs"
echo ""
echo "🌐 网络访问地址:"
echo "   前端:    http://$LOCAL_IP:3000"
echo "   后端:    http://$LOCAL_IP:8000"
echo "   MCP:     http://$LOCAL_IP:8080"
echo "   API文档: http://$LOCAL_IP:8000/docs"
echo ""
echo "📋 进程信息:"
echo "   MCP PID:  $MCP_PID"
echo "   后端 PID: $BACKEND_PID"
echo "   前端 PID: $FRONTEND_PID"
echo "   PID 文件: $PID_FILE"
echo ""
echo "💡 管理服务:"
echo "   查看状态: bash scripts/manage.sh status"
echo "   查看日志: bash scripts/manage.sh logs"
echo "   交互菜单: bash scripts/manage.sh"
echo "   停止服务: bash scripts/stop_all.sh"
