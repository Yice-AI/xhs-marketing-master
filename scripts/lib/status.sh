#!/bin/bash

get_service_status() {
    local service_name=$1
    local pid=$2
    local port=$3
    
    if [ -z "$pid" ]; then
        echo "❌ 未运行"
        return 1
    fi
    
    if kill -0 "$pid" 2>/dev/null; then
        if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo "✅ 运行中"
            return 0
        else
            echo "⚠️  进程存在但端口未监听"
            return 2
        fi
    else
        echo "❌ 未运行"
        return 1
    fi
}

get_memory_usage() {
    local pid=$1
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        echo "-"
        return
    fi
    
    local mem=$(ps -o rss= -p "$pid" 2>/dev/null)
    if [ -n "$mem" ]; then
        echo "$((mem / 1024))MB"
    else
        echo "-"
    fi
}

show_status() {
    local PROJECT_ROOT="$1"
    local PID_FILE="$PROJECT_ROOT/data/pids.txt"
    
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                    服务运行状态                               ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    
    printf "%-15s %-12s %-10s %-8s %-12s\n" "服务名称" "状态" "PID" "端口" "内存使用"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    BROWSER_PID=""
    MCP_PID=""
    BACKEND_PID=""
    FRONTEND_PID=""
    
    if [ -f "$PID_FILE" ]; then
        while IFS='=' read -r key value; do
            case "$key" in
                browser) BROWSER_PID="$value" ;;
                mcp) MCP_PID="$value" ;;
                backend) BACKEND_PID="$value" ;;
                frontend) FRONTEND_PID="$value" ;;
            esac
        done < "$PID_FILE"
    fi
    
    browser_status=$(get_service_status "browser" "$BROWSER_PID" "9222")
    browser_mem=$(get_memory_usage "$BROWSER_PID")
    printf "%-15s %-12s %-10s %-8s %-12s\n" "浏览器服务" "$browser_status" "${BROWSER_PID:--}" "9222" "$browser_mem"
    
    mcp_status=$(get_service_status "mcp" "$MCP_PID" "8080")
    mcp_mem=$(get_memory_usage "$MCP_PID")
    printf "%-15s %-12s %-10s %-8s %-12s\n" "MCP服务" "$mcp_status" "${MCP_PID:--}" "8080" "$mcp_mem"
    
    backend_status=$(get_service_status "backend" "$BACKEND_PID" "8000")
    backend_mem=$(get_memory_usage "$BACKEND_PID")
    printf "%-15s %-12s %-10s %-8s %-12s\n" "后端服务" "$backend_status" "${BACKEND_PID:--}" "8000" "$backend_mem"
    
    frontend_status=$(get_service_status "frontend" "$FRONTEND_PID" "3000")
    frontend_mem=$(get_memory_usage "$FRONTEND_PID")
    printf "%-15s %-12s %-10s %-8s %-12s\n" "前端服务" "$frontend_status" "${FRONTEND_PID:--}" "3000" "$frontend_mem"
    
    echo ""
}
