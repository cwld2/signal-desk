# AGENTS.md — 畅神妙妙屋（自用版）

## 项目概述

个人版 AI 学习简报，与公开版并行但完全独立。来源管理全程在网页完成，AI 分析在本机调用中转站 API。不分发给外人，只在用户本机运行。

- 目录：D:\ai\ai新闻\妙妙屋自用版
- 端口：4175（http://127.0.0.1:4175）
- 品牌：畅神妙妙屋（自用版）

## 与公开版的区别

| 特性 | 公开版 | 自用版 |
|------|--------|--------|
| 来源管理 | 配置文件，GitHub 网页编辑 | 网页直接搜索/添加/删除/启用 |
| AI 分析 | GitHub Actions + 百炼 | 本机 Node + 中转站 API |
| 定时更新 | Actions cron 定时 | 手动点击或单来源抓取 |
| API Key | GitHub Secrets | 本机 .env 文件 |
| 数据存储 | content 分支 | 本机 data/ 目录 |
| 历史简报 | 日历式月历 | 暂无历史归档 |

## 技术架构

- `server.js`：Node.js HTTP 服务，提供静态页面 + API 路由
- `src/rss.js`：RSS/Atom 解析 + Mozilla Readability 正文提取
- `src/ai.js`：中转站 API 调用（OpenAI 兼容格式），含筛选、分析和批量翻译
- `public/`：前端页面（复用公开版视觉风格，增加来源管理和设置页面）
- `data/`：sources.json（来源列表）+ config.json（AI 配置）

## 中转站 API

- 使用 OpenAI 兼容格式
- API Key 存在 `.env` 文件中（RELAY_API_KEY），不暴露给浏览器
- API 地址在设置网页中配置（当前：https://yujianwudi.top/v1）
- 模型列表可通过「获取可用模型列表」按钮自动拉取
- 当前配置模型：glm-5.2（筛选和分析均使用）
- 可用模型包括：deepseek-v4-flash / deepseek-v4-pro / glm-5.2 / minimax-m3 / step-3.7-flash 等

## 来源管理

- 网页「来源管理」页面可搜索、添加、删除、启用/禁用来源
- 每个来源旁边有数量输入框（默认 5）和「抓取」按钮
- 点「抓取」后服务端并行抓取 RSS，自动调用 AI 批量翻译标题为中文并生成一句话简介
- 右上角 ↻ 按钮可全站并行刷新（所有启用的来源同时抓取）

## API 路由

```
GET  /api/sources          — 获取来源列表
POST /api/sources          — 添加来源
PUT  /api/sources/:id      — 更新来源（启用/禁用/改名）
DELETE /api/sources/:id    — 删除来源
POST /api/refresh          — 全站并行刷新 + AI 批量翻译摘要
POST /api/refresh/:id     — 单来源抓取（?limit=N 控制数量）+ AI 批量翻译
POST /api/analyze          — 单篇文章全文分析（Readability 提取正文 + AI 分析）
GET  /api/models           — 从中转站获取可用模型列表
GET  /api/config           — 获取当前配置
PUT  /api/config           — 更新配置（模型/地址/提示词/参数）
```

## 启动方式

```powershell
Set-Location -LiteralPath 'D:\ai\ai新闻\妙妙屋自用版'
# .env 文件需要包含 RELAY_API_KEY 和 RELAY_BASE_URL
npm install --cache .npm-cache
npm start
# 或用 node 直接启动
Start-Process -WindowStyle Hidden -FilePath 'node' -ArgumentList 'server.js'
```

## 前端页面结构

- 今日学习：文章列表，显示 AI 翻译的中文标题和简介，点「全文分析」手动触发分析
- AI 动态 / 游戏开发 / 像素美术：按栏目展示文章卡片
- 来源管理：搜索/添加/删除/启用来源，每来源可调数量并单独抓取
- 设置：配置 API 地址、模型（下拉选）、温度、文章数、提示词
- 稍后阅读：收藏文章

## 当前状态

截至 2026-07-31：
- 服务可正常启动（http://127.0.0.1:4175）
- API Key 已配置，模型列表可获取
- 来源管理、设置页面、单来源抓取、批量翻译摘要已实现
- 全文分析点按钮手动触发，不会自动分析
- 尚未初始化 Git 仓库

## 已知待改进项

- 历史归档功能（目前刷新后旧文章会被替换）
- 全文分析的正文提取偶尔遇到登录墙或页面过短导致失败
- 批量翻译在文章很多时可能需要调小 maxArticles
- 用户计划增加一个私人工具收录页面（汇集好用的网站和技巧），尚未实现
