# xhs-marketing-master

一个插件优先的小红书营销工作台。Web 端负责采集编排、AI 创作、分析与历史记录，浏览器扩展负责真实页面采集、登录检测与发布执行。

> 这是从内部仓库导出的公开快照，已移除内部部署脚本、私有网关配置、内网 IP、生产环境变量、品牌素材和运行数据。

## 功能预览

### 封面与版式风格

这些图片放在仓库的 `public/style-previews/` 目录里，GitHub 会在 README 中直接渲染。

| Bold Cover | Clean Flow | Notebook Method |
| --- | --- | --- |
| ![Bold Cover](public/style-previews/bold-cover.webp) | ![Clean Flow](public/style-previews/clean-flow.webp) | ![Notebook Method](public/style-previews/notebook-method.webp) |

| SaaS Feature Cards | Handdrawn Operations |
| --- | --- |
| ![SaaS Feature Cards](public/style-previews/saas-feature-cards.webp) | ![Handdrawn Operations](public/style-previews/handdrawn-operations.webp) |

## 核心能力

- 插件优先：采集和发布动作在本地浏览器完成，降低账号风控和远程登录复杂度。
- AI 创作：支持产品信息访谈、内容策略、文案生成、封面/图片生成、改图任务和历史草稿。
- 样本分析：围绕小红书笔记 URL、样本池和创作策略做结构化分析。
- 扩展联动：Web 与浏览器扩展通过共享契约通信，适合真实页面采集和发布前检查。

## 本地开发

```bash
npm install
python3 -m venv venv
./venv/bin/pip install -r backend/requirements.txt
cp .env.example .env

PYTHONPATH=. ./venv/bin/alembic upgrade head
PYTHONPATH=. ./venv/bin/uvicorn backend.api.main:app --reload --port 8000 --host 127.0.0.1
npm run dev -- --host 127.0.0.1
```

打开 http://127.0.0.1:3000/。

## 浏览器扩展

```bash
cd extension
npm install
cd ..
npm run extension:build
```

## 配置说明

公开版只提供 `.env.example`，需要复制为 `.env` 后填入你自己的模型服务地址和 API Key。

```bash
cp .env.example .env
```

生产环境配置、内部模型网关、云服务器部署脚本和远程执行器不会出现在公开仓库里。

## 开源协议

本项目公开版采用 PolyForm Noncommercial License 1.0.0。

你可以用于个人学习、研究、评估和非商业用途。商业使用、SaaS 运营、代运营、转售、企业生产使用、包装成竞品或付费服务，都需要单独获得书面授权。

完整协议见 [LICENSE](LICENSE)。
