# xhs-marketing-master

插件优先的小红书营销工作台：Web 负责采集编排、AI 创作、分析与历史记录，浏览器扩展负责真实页面采集、登录检测与发布执行。

## License

This public snapshot is released under the PolyForm Noncommercial License 1.0.0.

You may use the source code for personal learning, research, evaluation, and other noncommercial purposes. Commercial use, SaaS operation, agency operation, resale, enterprise production use, or competing commercial products require separate written permission.

License text: https://polyformproject.org/licenses/noncommercial/1.0.0/

## Local Development

```bash
npm install
python3 -m venv venv
./venv/bin/pip install -r backend/requirements.txt
cp .env.example .env

PYTHONPATH=. ./venv/bin/alembic upgrade head
PYTHONPATH=. ./venv/bin/uvicorn backend.api.main:app --reload --port 8000 --host 127.0.0.1
npm run dev -- --host 127.0.0.1
```

Open http://127.0.0.1:3000/.

## Browser Extension

```bash
cd extension
npm install
cd ..
npm run extension:build
```

## Public Snapshot Notice

This repository is a sanitized public snapshot. Internal deployment scripts, private infrastructure documentation, private model gateway defaults, internal IPs, and brand assets are intentionally excluded.
