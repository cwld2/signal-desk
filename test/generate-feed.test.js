const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  articleBody,
  canReuseAnalysis,
  deduplicate,
  isSundayInShanghai,
  localSelect,
  parseModelJson
} = require("../scripts/generate-feed");

function fixture(id, lane, sourceId, score = 80) {
  return {
    id,
    lane,
    sourceId,
    sourceName: sourceId,
    title: `Technical guide ${id}`,
    url: `https://example.com/${id}`,
    summary: "A practical implementation guide with code and measured results.",
    publishedAt: new Date().toISOString(),
    score
  };
}

test("selects at most three AI articles and Sunday extras", () => {
  const items = [
    ...Array.from({ length: 7 }, (_, index) => fixture(`ai-${index}`, "ai", `ai-source-${index}`)),
    ...Array.from({ length: 5 }, (_, index) => fixture(`game-${index}`, "game", `game-source-${index}`)),
    ...Array.from({ length: 3 }, (_, index) => fixture(`art-${index}`, "art", `art-source-${index}`))
  ];
  const weekday = localSelect(items, false);
  assert.equal(weekday.ai.length, 3);
  assert.equal(weekday.game.length, 0);
  assert.equal(weekday.art.length, 0);
  const sunday = localSelect(items, true);
  assert.equal(sunday.ai.length, 3);
  assert.equal(sunday.game.length, 2);
  assert.equal(sunday.art.length, 1);
});

test("detects Sunday using Asia/Shanghai instead of UTC", () => {
  assert.equal(isSundayInShanghai(new Date("2026-08-01T16:30:00.000Z")), true);
  assert.equal(isSundayInShanghai(new Date("2026-08-02T16:30:00.000Z")), false);
});

test("extracts readable article text and removes page chrome", () => {
  const html = `<html><body><nav>Navigation</nav><article><h1>Title</h1><p>Useful implementation details.</p><script>secret()</script></article><footer>Footer</footer></body></html>`;
  const body = articleBody(html);
  assert.match(body, /Useful implementation details/);
  assert.doesNotMatch(body, /Navigation|Footer|secret/);
});

test("parses fenced Bailian JSON and rejects malformed output", () => {
  assert.deepEqual(parseModelJson("```json\n{\"aiIds\":[\"a\"]}\n```"), { aiIds: ["a"] });
  assert.throws(() => parseModelJson("not json"), /did not return JSON/);
});

test("deduplicates normalized URLs and titles", () => {
  const first = fixture("one", "ai", "source-a");
  const duplicate = { ...fixture("two", "ai", "source-b"), url: `${first.url}/`, title: first.title.toUpperCase() };
  assert.equal(deduplicate([first, duplicate]).length, 1);
});

test("reuses a completed analysis only when the article content hash is unchanged", () => {
  const item = { ...fixture("reuse", "ai", "source"), contentHash: "same-body" };
  const previous = { ...item, analysis: { summary: "done" }, analysisStatus: "complete" };
  assert.equal(canReuseAnalysis(previous, item), true);
  assert.equal(canReuseAnalysis(previous, { ...item, contentHash: "changed-body" }), false);
});

test("static site reads generated JSON and contains no embedded Bailian key", () => {
  const root = path.join(__dirname, "..", "public");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const feed = JSON.parse(fs.readFileSync(path.join(root, "data", "feed.json"), "utf8"));
  const archiveIndex = JSON.parse(fs.readFileSync(path.join(root, "data", "archive", "index.json"), "utf8"));
  assert.match(app, /\.\/data\/feed\.json/);
  assert.doesNotMatch(app, /\/api\/feed/);
  assert.equal(feed.timezone, "Asia/Shanghai");
  assert.ok(Array.isArray(archiveIndex.entries));
  const artifact = fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(entry.parentPath || entry.path, entry.name), "utf8"))
    .join("\n");
  assert.doesNotMatch(artifact, /DASHSCOPE_API_KEY\s*=/);
});
