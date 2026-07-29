const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.resolve(process.env.SIGNAL_DATA_DIR || path.join(__dirname, "..", "public", "data"));
const file = path.join(dataDir, "github.json");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if (!fs.existsSync(file)) {
  fail(`缺少 ${file}`);
} else {
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  if (payload.schemaVersion !== 1) fail("github.json 必须使用 schemaVersion 1");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.weekStart || "")) fail("github.json 缺少有效 weekStart");
  if (!Array.isArray(payload.items) || payload.items.length !== 2) fail("GitHub 热门必须恰好推荐 2 个仓库");
  const ids = new Set();
  for (const item of payload.items || []) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(item.fullName || "")) fail("GitHub 仓库名称无效");
    if (item.url !== `https://github.com/${item.fullName}`) fail(`GitHub 仓库 URL 无效：${item.fullName || "未知"}`);
    if (ids.has(item.id)) fail(`GitHub 推荐包含重复仓库：${item.id}`);
    ids.add(item.id);
    for (const field of ["summary", "whyRecommended", "firstLook"]) {
      if (!String(item[field] || "").trim()) fail(`${item.fullName || "未知仓库"} 缺少 ${field}`);
    }
    if (Object.hasOwn(item, "readmeExcerpt") || Object.hasOwn(item, "body")) fail("发布数据不得保存 README 或正文缓存");
  }
  const serialized = JSON.stringify(payload);
  if (/GITHUB_TOKEN|DASHSCOPE_API_KEY|Bearer\s+/i.test(serialized)) fail("GitHub 推荐数据疑似包含密钥");
}

if (process.exitCode) process.exit(process.exitCode);
console.log("github.json 校验通过");
