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
  for (const lane of ["game", "art"]) {
    const laneItems = Array.isArray(feed.lanes?.[lane]) ? feed.lanes[lane] : [];
    const keys = laneItems.map((item) => item.id || item.url);
    if (new Set(keys).size !== keys.length) fail(`${lane} 栏目包含重复文章`);
  }
  if (Array.isArray(feed.editionItems)) {
    const counts = {
      ai: feed.editionItems.filter((item) => item.lane === "ai").length,
      game: feed.editionItems.filter((item) => item.lane === "game").length,
      art: feed.editionItems.filter((item) => item.lane === "art").length
    };
    if (feed.stats?.selected !== feed.editionItems.length) fail("当天入选篇数与 editionItems 不一致");
    if (feed.stats?.ai !== counts.ai || feed.stats?.game !== counts.game || feed.stats?.art !== counts.art) fail("当天栏目统计与 editionItems 不一致");
    if (counts.ai > 3 || counts.game > 2 || counts.art > 2) fail("当天栏目篇数超过配额");
    if (!feed.edition?.isWeeklyEdition && !feed.editionItems.some((item) => item.manual) && (counts.game || counts.art)) fail("普通日归档不得挪用周刊内容");
  }
}

if (!fs.existsSync(indexFile)) fail(`缺少 ${indexFile}`);
else {
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  for (const entry of Array.isArray(index.entries) ? index.entries : []) {
    if (Number(entry.counts?.ai || 0) > 3 || Number(entry.counts?.game || 0) > 2 || Number(entry.counts?.art || 0) > 2) {
      fail(`历史索引 ${entry.date || "未知日期"} 的篇数超过配额`);
    }
  }
}
if (process.exitCode) process.exit(process.exitCode);
console.log("feed.json 校验通过");
