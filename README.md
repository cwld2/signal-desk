# 信号台 Signal Desk

面向 AI 学习、游戏开发和像素美术的静态学习简报。GitHub Actions 每天抓取、筛选并分析文章，GitHub Pages 只展示已经生成的 JSON。访客不需要 API Key，打开页面也不会产生新的百炼调用。

## 每日规则

- 每天北京时间 08:00 最多发布 2 篇实践文章和 1 篇重要更新；质量不足时允许少于 3 篇。
- 同一来源每天最多 1 篇。实践文章回看 180 天，重要更新只看近 14 天。
- 每周一北京时间 08:00 额外发布最多 2 篇游戏开发文章和 2 篇像素美术文章，其他日期继续展示最近一期周刊。
- 手动候选每天最多额外处理 2 篇，不占自动名额；失败项不会标记为已处理。
- 正文先由 Mozilla Readability 提取。短正文、登录墙或提取失败的文章直接淘汰，不使用 RSS 摘要凑数。
- `qwen3.7-flash` 负责筛选，`qwen3.7-plus` 负责分析，温度为 0.1，每次任务最多调用百炼 10 次。
- 鉴权、额度、模型或结构化输出持续失败时停止发布，线上继续显示上一次成功内容。

## 在 GitHub 网页管理内容

日常管理只需打开仓库文件，点击铅笔图标编辑并提交到 `main`：

- `config/sources.json`：来源开关、RSS 地址、栏目、类别、语言、权重和单来源上限。
- `config/editorial.json`：兴趣与排除主题、配额、时间范围、质量门槛、模型和输出长度。
- `config/manual-inbox.json`：额外候选文章。

修改 `config/**` 会自动触发一次重新筛选。手动候选格式：

```json
{
  "url": "https://example.com/a-practical-guide",
  "lane": "game",
  "category": "practice",
  "priority": 5,
  "note": "Godot 状态机长教程",
  "addedAt": "2026-07-28"
}
```

`lane` 使用 `ai`、`game` 或 `art`；`category` 通常使用 `practice`，版本公告使用 `update`。成功发布的 URL 会通过生成历史去重，因此不必立即从候选箱删除；正文失败的 URL 会留待下次处理。

## GitHub Actions 与内容分支

工作流 `Daily Signal Desk` 支持三种手动模式：

- `normal`：当天已有成功简报时不重复调用百炼。
- `force-rebuild-today`：保留当天已选文章，重新提取正文并重做分析。
- `force-weekly-now`：立即重新筛选当天内容，并额外生成 2 篇游戏开发和 2 篇像素美术周更。

生成数据由机器人维护在 `content` 分支：

```text
content
└─ data/
   ├─ feed.json
   └─ archive/
      ├─ index.json
      └─ YYYY-MM-DD.json
```

首次运行时，如果 `content` 分支不存在，工作流会从 `main` 当前保留的 `public/data` 迁移现有简报和历史归档。迁移完成后每日内容只提交到 `content`，不会再向 `main` 制造自动提交。Pages 发布时临时合并 `public` 页面代码和 `content/data`。

Actions Summary 会列出入选文章、正文长度、淘汰原因、失败来源、模型和调用次数。每次成功生成使用 `schemaVersion: 2`；旧归档仍由前端按 v1 格式显示。

## 百炼与 Pages 设置

在 `Settings > Secrets and variables > Actions` 配置 Repository secret：

```text
DASHSCOPE_API_KEY
```

可选 Variables：

```text
DASHSCOPE_BASE_URL
DASHSCOPE_SELECTION_MODEL
DASHSCOPE_ANALYSIS_MODEL
```

默认分别为北京公共兼容接口、`qwen3.7-flash` 和 `qwen3.7-plus`。在 `Settings > Pages` 将 Source 设为 `GitHub Actions`。建议在百炼控制台开启“免费额度用完即停”。Key 只注入 Actions，不会写入网页、归档或日志。

## 本地升级代码

本地更新固定流程：

```powershell
git pull --rebase
npm.cmd ci --cache .npm-cache
npm.cmd test
npm.cmd run check
git add .
git commit -m "描述本次改动"
git push
```

本地只预览页面时运行 `node server.js`，然后打开 <http://127.0.0.1:4173>。本地生成可设置 `SIGNAL_DATA_DIR` 指向单独的测试数据目录，避免覆盖仓库中的迁移快照。

## 主要目录

```text
config/                     GitHub 网页可编辑的内容策略
public/                     GitHub Pages 页面代码
scripts/generate-feed.js    抓取、Readability、筛选与百炼分析
scripts/validate-feed.js    发布数据和配额校验
.github/workflows/          定时生成、content 分支和 Pages 部署
test/                       规则、提取、失败保护和兼容性测试
```
