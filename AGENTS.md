# AGENTS.md — 畅神妙妙屋（公开版）

## 项目概述

畅神妙妙屋是一个静态 AI 学习简报网站。GitHub Actions 每天定时抓取、筛选并分析文章，GitHub Pages 只展示已生成的 JSON 数据。访客不需要 API Key，打开页面也不会产生新的百炼调用。

- 仓库地址：https://github.com/cwld2/signal-desk
- 线上地址：https://cwld2.github.io/signal-desk/
- 品牌：畅神妙妙屋（中文）/ AI 学习工坊（副标题）

## 定时规则

- 每天北京时间 05:38：最多发布 2 篇实践文章 + 1 篇重要更新，同一来源每天最多 1 篇。
- 每天北京时间 12:48：补充轮，只选当天 05:38 后新到的、还没发过的文章，按当天剩余配额补发；复用上午已发项的分析，不重复调用模型；当天配额已满就不会再调用。
- 每周日北京时间 05:38：额外发布 2 篇游戏开发 + 2 篇像素美术文章。
- 每周一、周四北京时间 04:25：从 GitHub 周趋势中各独立推荐 3 个仓库，同一周累积最多 6 个且互不重复（周四只补当周还没推荐过的），不占每日或游戏/美术名额。
- 手动候选每天最多额外处理 2 篇，不占自动名额。

## AI 模型

- 使用兼容 OpenAI 格式的 API；公开版与私有版均通过 GitHub Actions Secret `DASHSCOPE_API_KEY` + Variable `DASHSCOPE_BASE_URL` 配置，将 `DASHSCOPE_BASE_URL` 指向中转站地址即可切换为中转 API。
- 默认 base URL：`https://dashscope.aliyuncs.com/compatible-mode/v1`；中转站时填写中转站对应地址。
- 筛选模型：deepseek-v4-flash
- 分析模型：deepseek-v4-flash
- 模型名以 config/editorial.json 的 models 为准；可用 Variable `DASHSCOPE_SELECTION_MODEL` / `DASHSCOPE_ANALYSIS_MODEL` 覆盖
- 温度：0.5，每次任务最多调用 10 次
- 请求体加 `thinking: { type: "disabled" }` 与 max_tokens 16384；解析同时读 content 与 reasoning_content，用括号配平兜底提取 JSON，防止思考模式把推理渗进结构化输出导致解析失败。
- 失败时保留上一版网站，不覆盖

## 历史查找规则（分板块独立）

- 历史查找按板块拆分，各自调用各自的数据，不混用。
- GitHub 热门：在 GitHub 页面内用 `‹` / `›` 按周导航，读取 `public/data/github/index.json` 与 `public/data/github/archive/<weekStart>.json`。切到非本周时状态栏显示「历史 · <日期> 起」。
- 日常简报：在「历史简报」页面用月历按日期查找，读取 `public/data/archive/index.json` 与 `public/data/archive/<date>.json`；再用板块 tab（全部 / AI 动态 / 游戏开发 / 像素美术）按 `item.lane` 过滤当天内容。
- 两套索引与归档目录彼此独立，GitHub 周数据不会进入日常简报日历，反之亦然。

## 简报数据格式

- 当前 schemaVersion: 2，包含全文分析、核心要点、技术细节、学习价值和类似工程实践。
- 每篇文章有 annotations（重点加粗 + 必应搜索链接），在前端渲染。
- 旧版历史简报（v1）仍可正常显示。

## 目录结构

```
public/          — 静态前端（index.html / app.js / styles.css / render-utils.js）
  data/          — feed.json + archive/ + github.json（由机器人提交到 content 分支）
config/          — sources.json / editorial.json / manual-inbox.json（网页可直接编辑）
scripts/         — generate-feed.js / generate-github-trending.js / validate-*.js
src/feed.js      — RSS 抓取与正文提取（Readability）
test/            — 45 个测试，npm test 全部通过
.github/workflows/ — daily-feed.yml + weekly-github.yml
```

## GitHub 配置

- 仓库为公开仓库
- Secret：DASHSCOPE_API_KEY（中转站 API Key）
- Variable：DASHSCOPE_BASE_URL（中转站地址，未设置时回落到百炼官方兼容端点）
- Pages Source：GitHub Actions
- 内容数据由机器人在 `content` 分支维护，不提交到 `main`
- 首次运行时自动从 `public/data` 迁移现有简报到 `content` 分支

## 在 GitHub 网页管理内容

- `config/sources.json`：来源开关、RSS 地址、栏目、类别、语言、权重、单来源上限
- `config/editorial.json`：兴趣主题、配额、时间范围、质量门槛、模型、提示词；`githubWeekly.limit` 控制每周仓库数（当前 5），`readmeLimit` 控制抓取 README 的候选数（当前 16）
- `config/manual-inbox.json`：额外候选文章 URL
- 修改 config/** 会自动触发一次重新筛选

## 工作流手动模式

- `normal`：当天已有成功简报时不重复调用百炼
- `force-rebuild-today`：保留文章，重做分析
- `force-weekly-now`：立即重新筛选并生成游戏/美术周更
- Weekly GitHub Radar 也支持 `force` 参数强制刷新本周推荐

## 本地开发

```powershell
Set-Location -LiteralPath 'D:\ai\ai新闻'
npm ci --cache .npm-cache
npm test
npm run check
# 推送时使用代理
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push
```

## 当前 OpenAI Codex 会话历史

本项目经历了多次迭代：
1. 从信号台（Signal Desk）硬盘版改造为 GitHub Actions + Pages 静态架构
2. 改名畅神妙妙屋
3. 增加 GitHub 热门栏目（每周二更新）
4. 增加日历式历史简报
5. 增加全文分析标注（重点加粗 + 必应搜索链接）
6. 通俗化分析提示词改造
7. 周一改为每周日游戏/美术更新
8. 定时改为每天 05:38

截至 2026-07-31，所有测试通过，线上正常运行。

最近更新（2026-07-31）：
9. 公开版改为中转站 API（Secret `DASHSCOPE_API_KEY` + Variable `DASHSCOPE_BASE_URL` 指向中转站），模型改为 glm-5.2
10. GitHub 热门每周配额从 2 个增至 5 个
11. 历史查找分板块：GitHub 页面内独立周导航；日常简报历史页增加板块 tab 过滤

最近更新（2026-08-01）：
12. 公开版模型从 glm-5.2 切换为 deepseek-v4-flash（筛选与分析均用），workflow 与 editorial.json 已同步。
13. 修复 deepseek-v4-flash 默认思考模式污染 JSON：请求加 `thinking: { type: "disabled" }` + max_tokens 16384；新增健壮解析器读 content 与 reasoning_content、括号配平兜底提取 JSON。日报与周二 GitHub 周报共用同一客户端，一次修复两处受益。实测 7 次调用全过、无重试。
14. 新增每天北京时间 12:48（UTC 04:48）补充轮：保留上午已发项，只按当天剩余配额从「从没发过的新文章」补发，复用上午分析不重复调用模型；当天配额已满则不再调用。需改 `shouldSkipEdition`、`selectionPrompt`、`chooseItems`、`buildOutput`、`main` 与 `daily-feed.yml`（第二条 cron + `supplement` 模式 + `SIGNAL_SUPPLEMENT` 环境变量）。
15. 修复 `enforceQuota` 在 limit=0 时 off-by-one（先 push 后才 break，导致补充轮把已满的槽位多塞 1 条、被 validate 拦下）；加 `if (limit <= 0) return []` 守卫 + 回归测试。
16. 修复 `generate-github-trending.js` 的 `shouldSkipGithub` 硬编码 `items.length === 2` 残留，改为跟随 `settings.limit`（=5），手动重跑 GitHub 雷达现在能正确跳过、不再白白重算。
17. 日常简报筛选放宽：`minimumCandidateScore` 58 → 45、`candidateFetchPerSource` 4 → 12、`candidateBodyPool` 上限 practice 12 → 20 / update 8 → 14，解决「入选 0 篇、淘汰 368 条」里大量「超过单来源正文候选抓取上限」与「相关度 53-57 低于门槛」的误杀。
18. GitHub 热门改为每周一、周四各 3 个、当周累积最多 6 个（`githubWeekly.limit=3` + 新增 `weeklyLimit=6`）；`weekly-github.yml` 改为两条 cron（`25 20 * * 0` 周一、`25 20 * * 3` 周四）；`shouldSkipGithub` 改按 `weeklyLimit` 判断，周四不再被当周已有数据误跳过；`buildGithubOutput` 支持累积并按 id 去重。
19. 修复 `validate-github-feed.js` 硬编码 `items.length !== 2`（「必须恰好推荐 2 个仓库」）——这是此前把 `githubWeekly.limit` 改成 5 却始终没生效的真正原因（生成 5 个会被校验拦下、回滚保留旧的 2 个）。现改为校验 1..weeklyLimit。
