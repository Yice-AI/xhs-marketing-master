#!/bin/bash

# 数据库备份脚本
# 版本: 1.0.0

set -e

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DATABASE_URL="${DATABASE_URL:-mysql+pymysql://root:password@127.0.0.1:3306/xhs_marketing}"
KEEP_DAYS="${KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)

if [[ $DATABASE_URL == sqlite* ]]; then
    DB_FILE=$(echo $DATABASE_URL | sed 's/sqlite:\/\/\///')
    BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.db"
    
    cp "$DB_FILE" "$BACKUP_FILE"
    echo "✅ SQLite 备份完成: $BACKUP_FILE"
    
elif [[ $DATABASE_URL == postgresql* ]]; then
    BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.sql"
    
    pg_dump "$DATABASE_URL" > "$BACKUP_FILE"
    echo "✅ PostgreSQL 备份完成: $BACKUP_FILE"
elif [[ $DATABASE_URL == mysql* ]]; then
    BACKUP_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.sql"

    MYSQL_URL_NO_DRIVER="${DATABASE_URL#mysql+pymysql://}"
    MYSQL_AUTH="${MYSQL_URL_NO_DRIVER%@*}"
    MYSQL_HOST_DB="${MYSQL_URL_NO_DRIVER#*@}"
    MYSQL_USER="${MYSQL_AUTH%%:*}"
    MYSQL_PASS="${MYSQL_AUTH#*:}"
    MYSQL_HOST_PORT="${MYSQL_HOST_DB%%/*}"
    MYSQL_DB="${MYSQL_HOST_DB#*/}"
    MYSQL_HOST="${MYSQL_HOST_PORT%%:*}"
    MYSQL_PORT="${MYSQL_HOST_PORT#*:}"

    MYSQL_PWD="$MYSQL_PASS" mysqldump -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" "$MYSQL_DB" > "$BACKUP_FILE"
    echo "✅ MySQL 备份完成: $BACKUP_FILE"
fi

find "$BACKUP_DIR" -name "backup_*.db" -o -name "backup_*.sql" -mtime +$KEEP_DAYS -delete
echo "✅ 已清理 $KEEP_DAYS 天前的备份"
