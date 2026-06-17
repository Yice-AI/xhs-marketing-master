#!/bin/bash

CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
USER_DATA_DIR="$PROJECT_ROOT/browser_data/single_user_data_dir"
CDP_PORT=9222

if [ ! -f "$CHROME_PATH" ]; then
    echo "❌ 未找到 Chrome，请确保已安装 Google Chrome"
    exit 1
fi

if lsof -Pi :$CDP_PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "⚠️  浏览器服务已在运行（端口 $CDP_PORT）"
    exit 0
fi

echo "🚀 启动浏览器服务..."
echo "   CDP 端口: $CDP_PORT"
echo "   数据目录: $USER_DATA_DIR"

BROWSER_LOG="$PROJECT_ROOT/browser_data/browser.log"

"$CHROME_PATH" \
    --remote-debugging-port=$CDP_PORT \
    --user-data-dir="$USER_DATA_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --disable-blink-features=AutomationControlled \
    "https://www.xiaohongshu.com" \
    > "$BROWSER_LOG" 2>&1 &

BROWSER_PID=$!

sleep 2

if lsof -Pi :$CDP_PORT -sTCP:LISTEN -t >/dev/null ; then
    echo "✅ 浏览器服务已启动"
    echo "   PID: $BROWSER_PID"
    echo "   访问: http://localhost:$CDP_PORT/json/version"
    
    PID_FILE="$PROJECT_ROOT/data/pids.txt"
    mkdir -p "$(dirname "$PID_FILE")"
    
    if [ -f "$PID_FILE" ]; then
        sed -i '' '/^browser=/d' "$PID_FILE" 2>/dev/null || sed -i '/^browser=/d' "$PID_FILE"
    fi
    echo "browser=$BROWSER_PID" >> "$PID_FILE"
else
    echo "❌ 浏览器服务启动失败"
    exit 1
fi
