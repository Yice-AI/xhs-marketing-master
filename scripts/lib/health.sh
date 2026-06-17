#!/bin/bash

check_health() {
    local PROJECT_ROOT="$1"
    
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║                    健康检查                                   ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    
    echo "🔍 检查浏览器服务..."
    if lsof -Pi :9222 -sTCP:LISTEN -t >/dev/null 2>&1; then
        if curl -s http://localhost:9222/json/version >/dev/null 2>&1; then
            echo "   ✅ 浏览器服务正常 (端口 9222)"
        else
            echo "   ⚠️  端口监听但无法访问 CDP 接口"
        fi
    else
        echo "   ❌ 浏览器服务未运行"
    fi
    
    echo ""
    echo "🔍 检查 MCP 服务..."
    if lsof -Pi :8080 -sTCP:LISTEN -t >/dev/null 2>&1; then
        if curl -s http://localhost:8080/api/v1/login/status >/dev/null 2>&1; then
            echo "   ✅ MCP 服务正常 (端口 8080)"
        else
            echo "   ⚠️  端口监听但 API 无响应"
        fi
    else
        echo "   ❌ MCP 服务未运行"
    fi
    
    echo ""
    echo "🔍 检查后端服务..."
    if lsof -Pi :8000 -sTCP:LISTEN -t >/dev/null 2>&1; then
        if curl -s http://localhost:8000/health >/dev/null 2>&1; then
            echo "   ✅ 后端服务正常 (端口 8000)"
        else
            echo "   ⚠️  端口监听但健康检查失败"
        fi
    else
        echo "   ❌ 后端服务未运行"
    fi
    
    echo ""
    echo "🔍 检查前端服务..."
    if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
        if curl -s http://localhost:3000 >/dev/null 2>&1; then
            echo "   ✅ 前端服务正常 (端口 3000)"
        else
            echo "   ⚠️  端口监听但无法访问"
        fi
    else
        echo "   ❌ 前端服务未运行"
    fi
    
    echo ""
    echo "🔍 检查依赖..."
    
    if command -v python3 >/dev/null 2>&1; then
        echo "   ✅ Python3: $(python3 --version)"
    else
        echo "   ❌ Python3 未安装"
    fi
    
    if command -v node >/dev/null 2>&1; then
        echo "   ✅ Node.js: $(node --version)"
    else
        echo "   ❌ Node.js 未安装"
    fi
    
    if [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
        echo "   ✅ Google Chrome 已安装"
    else
        echo "   ❌ Google Chrome 未安装"
    fi
    
    echo ""
}
