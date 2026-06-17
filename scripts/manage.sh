#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$SCRIPT_DIR/lib/status.sh"
source "$SCRIPT_DIR/lib/logs.sh"
source "$SCRIPT_DIR/lib/health.sh"

show_addresses() {
    LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)
    
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                    访问地址                                   ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
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
}

start_services() {
    echo ""
    echo "🚀 启动所有服务..."
    bash "$SCRIPT_DIR/start_all.sh"
}

stop_services() {
    echo ""
    echo "🛑 停止所有服务..."
    bash "$SCRIPT_DIR/stop_all.sh"
}

restart_services() {
    stop_services
    sleep 2
    start_services
}

show_main_menu() {
    while true; do
        echo ""
        echo "╔══════════════════════════════════════════════════════════════╗"
        echo "║              小红书营销工具 - 服务管理                        ║"
        echo "╚══════════════════════════════════════════════════════════════╝"
        echo ""
        echo "请选择操作:"
        echo ""
        echo "  1) 📊 查看服务状态"
        echo "  2) 📝 查看日志"
        echo "  3) 🚀 启动所有服务"
        echo "  4) 🛑 停止所有服务"
        echo "  5) 🔄 重启所有服务"
        echo "  6) 🌐 显示访问地址"
        echo "  7) 🔍 健康检查"
        echo "  0) 退出"
        echo ""
        read -p "请输入选项 [0-7]: " choice
        
        case $choice in
            1)
                show_status "$PROJECT_ROOT"
                read -p "按任意键继续..."
                ;;
            2)
                show_logs_menu "$PROJECT_ROOT"
                ;;
            3)
                start_services
                read -p "按任意键继续..."
                ;;
            4)
                stop_services
                read -p "按任意键继续..."
                ;;
            5)
                restart_services
                read -p "按任意键继续..."
                ;;
            6)
                show_addresses
                read -p "按任意键继续..."
                ;;
            7)
                check_health "$PROJECT_ROOT"
                read -p "按任意键继续..."
                ;;
            0)
                echo ""
                echo "👋 再见！"
                echo ""
                exit 0
                ;;
            *)
                echo "❌ 无效选项，请重新选择"
                sleep 1
                ;;
        esac
    done
}

if [ $# -eq 0 ]; then
    show_main_menu
else
    case $1 in
        status)
            show_status "$PROJECT_ROOT"
            ;;
        logs)
            if [ -n "$2" ]; then
                view_log_direct "$2" "$PROJECT_ROOT"
            else
                view_log_direct "all" "$PROJECT_ROOT"
            fi
            ;;
        start)
            start_services
            ;;
        stop)
            stop_services
            ;;
        restart)
            restart_services
            ;;
        health)
            check_health "$PROJECT_ROOT"
            ;;
        addresses|addr)
            show_addresses
            ;;
        *)
            echo "❌ 未知命令: $1"
            echo ""
            echo "可用命令:"
            echo "  status    - 查看服务状态"
            echo "  logs      - 查看日志 (可选: frontend, backend, browser, mcp, all)"
            echo "  start     - 启动所有服务"
            echo "  stop      - 停止所有服务"
            echo "  restart   - 重启所有服务"
            echo "  health    - 健康检查"
            echo "  addresses - 显示访问地址"
            echo ""
            echo "或直接运行 'bash scripts/manage.sh' 进入交互式菜单"
            exit 1
            ;;
    esac
fi
