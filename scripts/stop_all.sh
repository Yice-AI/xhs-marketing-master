#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_ROOT/data/pids.txt"

echo "🛑 停止所有服务..."
echo ""

stop_service() {
    local service_name=$1
    local pid_key=$2
    local fallback_pattern=$3
    
    local pid=""
    if [ -f "$PID_FILE" ]; then
        pid=$(grep "^$pid_key=" "$PID_FILE" 2>/dev/null | cut -d'=' -f2)
    fi
    
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null && echo "   ✅ $service_name 已停止 (PID: $pid)" || echo "   ⚠️  无法停止 $service_name"
    elif [ -n "$fallback_pattern" ]; then
        if pkill -f "$fallback_pattern" 2>/dev/null; then
            echo "   ✅ $service_name 已停止 (使用进程名匹配)"
        else
            echo "   ⚠️  $service_name 未运行"
        fi
    else
        echo "   ⚠️  $service_name 未运行"
    fi
}

echo "1️⃣  停止前端服务..."
stop_service "前端服务" "frontend" "vite.*--port 3000"

echo "2️⃣  停止后端服务..."
stop_service "后端服务" "backend" "uvicorn backend.api.main"

echo "3️⃣  停止 MCP 服务..."
stop_service "MCP服务" "mcp" "xiaohongshu-mcp"

echo "4️⃣  停止浏览器服务..."
stop_service "浏览器服务" "browser" "remote-debugging-port=9222"

if [ -f "$PID_FILE" ]; then
    rm "$PID_FILE"
    echo ""
    echo "🗑️  已清理 PID 文件"
fi

echo ""
echo "✅ 所有服务已停止！"
