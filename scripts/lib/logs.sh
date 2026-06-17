#!/bin/bash

show_logs_menu() {
    local PROJECT_ROOT="$1"
    
    while true; do
        echo ""
        echo "╔══════════════════════════════════════════════════════════════╗"
        echo "║                      查看日志                                 ║"
        echo "╚══════════════════════════════════════════════════════════════╝"
        echo ""
        echo "请选择要查看的日志:"
        echo ""
        echo "  1) 📱 前端日志 (实时)"
        echo "  2) 🔧 后端日志 (实时)"
        echo "  3) 🌐 浏览器日志 (实时)"
        echo "  4) 🚀 MCP日志 (实时)"
        echo "  5) 📊 所有日志 (实时)"
        echo "  6) 📄 前端日志 (最近100行)"
        echo "  7) 📄 后端日志 (最近100行)"
        echo "  8) 📄 浏览器日志 (最近100行)"
        echo "  9) 📄 MCP日志 (最近100行)"
        echo "  0) 返回主菜单"
        echo ""
        read -p "请输入选项 [0-9]: " choice
        
        case $choice in
            1) view_log "frontend" "tail" "$PROJECT_ROOT" ;;
            2) view_log "backend" "tail" "$PROJECT_ROOT" ;;
            3) view_log "browser" "tail" "$PROJECT_ROOT" ;;
            4) view_all_logs "$PROJECT_ROOT" ;;
            5) view_log "frontend" "cat" "$PROJECT_ROOT" ;;
            6) view_log "backend" "cat" "$PROJECT_ROOT" ;;
            7) view_log "browser" "cat" "$PROJECT_ROOT" ;;
            0) return ;;
            *) echo "❌ 无效选项，请重新选择" ;;
        esac
    done
}

view_log() {
    local service=$1
    local mode=$2
    local PROJECT_ROOT="$3"
    
    local log_file=""
    case $service in
        frontend)
            log_file="$PROJECT_ROOT/frontend.log"
            ;;
        backend)
            log_file="$PROJECT_ROOT/backend/logs/api.log"
            ;;
        browser)
            log_file="$PROJECT_ROOT/browser_data/browser.log"
            ;;
    esac
    
    if [ ! -f "$log_file" ]; then
        echo "❌ 日志文件不存在: $log_file"
        read -p "按任意键继续..."
        return
    fi
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📝 $service 日志"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    if [ "$mode" = "tail" ]; then
        echo "💡 按 Ctrl+C 返回菜单"
        echo ""
        
        trap 'echo ""; echo ""; echo "📋 返回菜单..."; return' INT
        tail -f "$log_file"
        trap - INT
    else
        tail -100 "$log_file"
        echo ""
        read -p "按任意键继续..."
    fi
}

view_all_logs() {
    local PROJECT_ROOT="$1"
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📊 所有服务日志 (实时)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "💡 按 Ctrl+C 返回菜单"
    echo ""
    
    trap 'echo ""; echo ""; echo "📋 返回菜单..."; return' INT
    tail -f \
        "$PROJECT_ROOT/frontend.log" \
        "$PROJECT_ROOT/backend/logs/api.log" \
        "$PROJECT_ROOT/browser_data/browser.log" \
        2>/dev/null
    trap - INT
}

view_log_direct() {
    local service=$1
    local PROJECT_ROOT=$2
    
    local log_file=""
    case $service in
        frontend)
            log_file="$PROJECT_ROOT/frontend.log"
            ;;
        backend)
            log_file="$PROJECT_ROOT/backend/logs/api.log"
            ;;
        browser)
            log_file="$PROJECT_ROOT/browser_data/browser.log"
            ;;
        mcp)
            log_file="$PROJECT_ROOT/backend/logs/mcp.log"
            ;;
        all)
            echo "💡 按 Ctrl+C 退出"
            echo ""
            tail -f \
                "$PROJECT_ROOT/frontend.log" \
                "$PROJECT_ROOT/backend/logs/api.log" \
                "$PROJECT_ROOT/browser_data/browser.log" \
                "$PROJECT_ROOT/backend/logs/mcp.log" \
                2>/dev/null
            return
            ;;
        *)
            echo "❌ 未知服务: $service"
            echo "可用选项: frontend, backend, browser, mcp, all"
            return 1
            ;;
    esac
    
    if [ ! -f "$log_file" ]; then
        echo "❌ 日志文件不存在: $log_file"
        return 1
    fi
    
    echo "💡 按 Ctrl+C 退出"
    echo ""
    tail -f "$log_file"
}
