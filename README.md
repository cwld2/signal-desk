# 信号台 Signal Desk

一个面向 AI 学习、游戏开发和像素美术的静态学习简报。GitHub Actions 每天生成内容，GitHub Pages 只负责展示已经筛选和分析好的 JSON，因此访客不需要 API Key，打开网页也不会产生新的 AI 调用。

## 更新规则

- 每天北京时间 08:00 抓取 RSS/Atom 来源并生成最多 3 篇 AI 科技精选。
- 每周日额外生成 2 篇游戏开发精选和 1 篇像素/AI 美术精选，并保留到下一周。
- Gemini 先从本地规则筛出的候选中做最终选择，再为精选文章生成列表简介、核心要点、技术细节和学习价值。
- 已发布文章会记录在 `history.seenIds` 中，正文摘要没有变化的完成分析会复用。
- 每次成功生成都会保存为 `public/data/archive/YYYY-MM-DD.json`；同一天重跑覆盖当天文件，历史日期不会被清空。
- 正文抓取或 Gemini 调用失败时退回 RSS 摘要；全部来源失败时保留上一次成功结果。

## GitHub Pages 部署

1. 在 GitHub 创建一个公开仓库，将本目录推送到仓库。
2. 打开仓库 `Settings > Secrets and variables > Actions`。
3. 新建 Repository secret：`GEMINI_API_KEY`。
4. 可选：在 Variables 中设置 `GEMINI_SELECTION_MODEL` 和 `GEMINI_ANALYSIS_MODEL`；未设置时使用 `gemini-3.1-flash-lite`。
5. 打开 `Settings > Pages`，将 Source 设为 `GitHub Actions`。
6. 打开 `Actions > Daily Signal Desk`，手动运行一次 `workflow_dispatch`。

之后工作流会在每天 UTC 00:00，也就是北京时间 08:00 左右运行。GitHub 的定时任务可能延迟几分钟。

API Key 只通过 GitHub Secret 注入生成任务，不会进入网页发布产物。不要把 Key 写入 `public`、源码、日志或 `.env` 后提交。

## 本地运行

需要 Node.js 20 或更高版本。

```powershell
$env:GEMINI_API_KEY="你的 Gemini API Key"
npm run generate
npm test
npm run check
node server.js
```

浏览器打开 <http://127.0.0.1:4173>。未设置 `GEMINI_API_KEY` 时，生成器仍可用于本地检查，但文章会标记为基于 RSS 摘要。

## 主要目录

```text
public/                     GitHub Pages 静态网站
public/data/feed.json       定时生成的公开数据
public/data/archive/        按日期永久保存的历史简报和索引
scripts/generate-feed.js    抓取、筛选、正文提取和 Gemini 分析
.github/workflows/          每日生成与 Pages 部署
sources.js                  RSS/Atom 来源配置
test/                       解析、筛选、时区和静态产物测试
```

`server.js` 和 Windows 便携打包脚本暂时保留，仅用于旧版和本地预览；公开网站不依赖 `/api/feed`。
