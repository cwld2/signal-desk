const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.resolve(process.env.SIGNAL_DATA_DIR || path.join(__dirname, "..", "public", "data"));
const feedFile = path.join(dataDir, "feed.json");
const indexFile = path.join(dataDir, "archive", "index.json");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if (!fs.existsSync(feedFile)) {
  fail(`缺少 ${feedFile}`);
} else {
  const feed = JSON.parse(fs.readFileSync(feedFile, "utf8"));
  if (feed.schemaVersion !== 2) fail("feed.json 必须使用 schemaVersion 2");
  if (!Array.isArray(feed.items) || !feed.lanes || !feed.edition?.date) fail("feed.json 缺少必要字段");
  const automatic = feed.items.filter((item) => !item.manual && item.lane === "ai");
  if (automatic.filter((item) => item.slot === "practice").length > 2) fail("实践文章超过 2 篇");
  if (automatic.filter((item) => item.slot === "update").length > 1) fail("更新文章超过 1 篇");
  const sourceIds = automatic.map((item) => item.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) fail("自动内容违反一源一篇规则");
  if (feed.items.some((item) => item.body)) fail("发布数据不得保存抓取正文");
}

if (!fs.existsSync(indexFile)) fail(`缺少 ${indexFile}`);
if (process.exitCode) process.exit(process.exitCode);
console.log("feed.json 校验通过");
