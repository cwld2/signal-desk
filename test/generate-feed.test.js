const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const editorial = require("../config/editorial.json");
const {
  analysisLengthTarget,
  canReuseAnalysis,
  candidateBodyPool,
  deduplicate,
  extractReadableArticle,
  isWeeklyEditionInShanghai,
  localSelect,
  normalizeAnalysis,
  normalizeSelection,
  parseHtmlListing,
  parseModelJson,
  prefilterCandidates,
  selectPendingManualEntries,
  shouldRebuildExistingEdition,
  shouldSkipEdition
} = require("../scripts/generate-feed");

function fixture(id, { lane = "ai", sourceId = id, slot = "practice", category = slot, publishedAt = "2026-07-28T00:00:00.000Z" } = {}) {
  return {
    id,
    lane,
    sourceId,
    sourceName: sourceId,
    sourceDailyLimit: 1,
    sourceWeight: 1.1,
    slot,
    category,
    title: `Implementation guide ${id}`,
    url: `https://example.com/${id}`,
    summary: "A practical implementation tutorial with code, API details and measured results.",
    publishedAt,
    score: 85,
    candidateScore: 85
  };
}

test("enforces 2 practice + 1 update and one article per source", () => {
  const candidates = [
    fixture("p1", { sourceId: "same" }),
    fixture("p2", { sourceId: "same" }),
    fixture("p3", { sourceId: "other" }),
    fixture("u1", { sourceId: "updates", slot: "update" }),
    fixture("u2", { sourceId: "updates-2", slot: "update" })
  ];
  const selected = localSelect(candidates, false, editorial);
  assert.deepEqual(selected.practice.map((item) => item.id), ["p1", "p3"]);
  assert.deepEqual(selected.update.map((item) => item.id), ["u1"]);
  assert.equal(new Set([...selected.practice, ...selected.update].map((item) => item.sourceId)).size, 3);
});

test("does not fill a quota when quality candidates are insufficient", () => {
  const selected = localSelect([fixture("only-one")], false, editorial);
  assert.equal(selected.practice.length, 1);
  assert.equal(selected.update.length, 0);
});

test("weekly edition adds at most two game and two art articles", () => {
  const candidates = [
    fixture("p1"), fixture("p2"), fixture("u1", { slot: "update" }),
    fixture("g1", { lane: "game" }), fixture("g2", { lane: "game" }), fixture("g3", { lane: "game" }),
    fixture("a1", { lane: "art" }), fixture("a2", { lane: "art" })
  ];
  const selected = localSelect(candidates, true, editorial);
  assert.equal(selected.game.length, 2);
  assert.equal(selected.art.length, 2);
});

test("parses configured HTML article listings", () => {
  const source = {
    id: "pixel-guides",
    name: "Pixel Guides",
    url: "https://example.com/articles",
    site: "https://example.com/",
    itemSelector: "article",
    titleSelector: "h2 a",
    summarySelector: "p",
    dateSelector: "time",
    lane: "art",
    authority: 5,
    accent: "#123456"
  };
  const html = `<main><article><h2><a href="/guide">Pixel animation guide</a></h2><time datetime="2026-07-20T08:00:00Z">July 20</time><p>Plan readable sprite motion with clear key poses and spacing.</p></article></main>`;
  const items = parseHtmlListing(html, source);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://example.com/guide");
  assert.equal(items[0].publishedAt, "2026-07-20T08:00:00.000Z");
  assert.equal(items[0].topic, "像素美术");
});

test("weekday body pool excludes weekly lanes and caps AI candidates", () => {
  const candidates = [
    ...Array.from({ length: 20 }, (_, index) => fixture(`p-${index}`)),
    ...Array.from({ length: 12 }, (_, index) => fixture(`u-${index}`, { slot: "update" })),
    fixture("game", { lane: "game" }),
    fixture("art", { lane: "art" })
  ];
  const weekday = candidateBodyPool(candidates, false);
  assert.equal(weekday.filter((item) => item.slot === "practice").length, 12);
  assert.equal(weekday.filter((item) => item.slot === "update").length, 8);
  assert.equal(weekday.some((item) => item.lane === "game" || item.lane === "art"), false);
  assert.equal(candidateBodyPool(candidates, true).some((item) => item.lane === "game"), true);
});

test("uses 180-day practice and 14-day update windows", () => {
  const settings = JSON.parse(JSON.stringify(editorial));
  settings.quality.minimumCandidateScore = 0;
  const now = new Date("2026-07-28T00:00:00.000Z");
  const items = [
    fixture("practice-ok", { publishedAt: "2026-01-30T00:00:00.000Z" }),
    fixture("practice-old", { publishedAt: "2026-01-28T00:00:00.000Z" }),
    fixture("update-ok", { slot: "update", publishedAt: "2026-07-15T00:00:00.000Z" }),
    fixture("update-old", { slot: "update", publishedAt: "2026-07-13T00:00:00.000Z" })
  ];
  const result = prefilterCandidates(items, settings, now);
  assert.deepEqual(result.eligible.map((item) => item.id).sort(), ["practice-ok", "update-ok"]);
  assert.match(result.rejected.find((item) => item.id === "practice-old").reason, /180/);
  assert.match(result.rejected.find((item) => item.id === "update-old").reason, /14/);
});

test("Readability extracts article content and rejects page chrome", () => {
  const useful = Array.from({ length: 80 }, (_, index) => `<p>Step ${index}: useful implementation details and measured results.</p>`).join("");
  const html = `<html><head><title>Guide</title></head><body><nav>Navigation</nav><article><h1>Practical Guide</h1>${useful}<script>secret()</script></article><footer>Footer</footer></body></html>`;
  const result = extractReadableArticle(html, "https://example.com/guide", 30000);
  assert.ok(result.length > 500);
  assert.equal(result.method, "readability");
  assert.equal(result.trusted, true);
  assert.match(result.text, /useful implementation details/);
  assert.doesNotMatch(result.text, /Navigation|Footer|secret/);
});

test("Readability marks a login-wall sized page as untrusted", () => {
  const result = extractReadableArticle("<main><h1>Sign in</h1><p>Please sign in to continue.</p></main>", "https://example.com/private", 30000);
  assert.equal(result.trusted, false);
  assert.ok(result.length < editorial.quality.minimumBodyCharacters);
});

test("manual inbox takes at most two unprocessed URLs by priority", () => {
  const entries = [
    { url: "https://example.com/a", priority: 1, addedAt: "2026-07-20" },
    { url: "https://example.com/b", priority: 5, addedAt: "2026-07-21" },
    { url: "https://example.com/c", priority: 3, addedAt: "2026-07-22" },
    { url: "https://example.com/d", priority: 9, addedAt: "2026-07-23" }
  ];
  const selected = selectPendingManualEntries(entries, new Set(["https://example.com/d"]), 2);
  assert.deepEqual(selected.map((entry) => entry.url), ["https://example.com/b", "https://example.com/c"]);
});

test("analysis length target scales and never exceeds 3000 characters", () => {
  assert.deepEqual(analysisLengthTarget(3000, editorial), { tier: "short", min: 600, max: 1000 });
  assert.deepEqual(analysisLengthTarget(7000, editorial), { tier: "medium", min: 1200, max: 2000 });
  assert.deepEqual(analysisLengthTarget(18000, editorial), { tier: "long", min: 2200, max: 3000 });
});

test("v2 analysis requires source/inference labels and engineering verification", () => {
  const raw = {
    displayTitle: "一个准确的中文技术标题",
    listSummary: "这是一段用于验证列表简介长度和结构的中文文字。".repeat(6),
    fullAnalysis: [
      { heading: "背景与问题", paragraphs: ["背景"] },
      { heading: "方法与论证", paragraphs: ["方法"] },
      { heading: "证据、结论与边界", paragraphs: ["边界"] }
    ],
    keyPoints: ["一", "二", "三"],
    technicalDetails: [{ text: "原文给出的 API", basis: "source" }, { text: "建议增加缓存", basis: "inference" }],
    engineeringPractice: [{ scenario: "最小项目", steps: ["实现"], tools: ["Node.js"], verification: ["运行测试"] }]
  };
  const normalized = normalizeAnalysis(raw);
  assert.deepEqual(normalized.technicalDetails.map((detail) => detail.basis), ["source", "inference"]);
  assert.throws(() => normalizeAnalysis({ ...raw, technicalDetails: [{ text: "未标注", basis: "guess" }] }), /source 或 inference/);
  const repaired = normalizeAnalysis({ ...raw, engineeringPractice: [] });
  assert.equal(repaired.engineeringPractice.length, 1);
  assert.match(repaired.engineeringPractice[0].scenario, /一个准确的中文技术标题/);
  assert.ok(repaired.engineeringPractice[0].steps.length >= 3);
  assert.ok(repaired.engineeringPractice[0].verification.length >= 3);
});

test("selection JSON requires all quota arrays", () => {
  assert.deepEqual(normalizeSelection({ practiceIds: [], updateIds: [], gameIds: [], artIds: [], reasons: {} }).practiceIds, []);
  assert.throws(() => normalizeSelection({ practiceIds: [] }), /updateIds/);
});

test("parses fenced Bailian JSON and rejects malformed output", () => {
  assert.deepEqual(parseModelJson("```json\n{\"practiceIds\":[\"a\"]}\n```"), { practiceIds: ["a"] });
  assert.throws(() => parseModelJson("not json"), /未返回 JSON/);
});

test("deduplicates URL, title and body hashes", () => {
  const first = { ...fixture("one"), bodyHash: "same-body" };
  const urlDuplicate = { ...fixture("two"), url: `${first.url}/` };
  const bodyDuplicate = { ...fixture("three"), bodyHash: "same-body" };
  assert.equal(deduplicate([first, urlDuplicate, bodyDuplicate]).length, 1);
});

test("reuses analysis only for unchanged v2 body and respects force mode", () => {
  const item = { ...fixture("reuse"), bodyHash: "same-body" };
  const previous = { ...item, schemaVersion: 2, analysis: { listSummary: "done" }, analysisStatus: "complete" };
  assert.equal(canReuseAnalysis(previous, item), true);
  assert.equal(canReuseAnalysis(previous, item, true), false);
  assert.equal(canReuseAnalysis(previous, { ...item, bodyHash: "changed" }), false);
});

test("same-day normal mode skips calls while force mode rebuilds", () => {
  const previous = { edition: { date: "2026-07-28" } };
  assert.equal(shouldSkipEdition(previous, "2026-07-28", false), true);
  assert.equal(shouldSkipEdition(previous, "2026-07-28", true), false);
  assert.equal(shouldRebuildExistingEdition(previous, "2026-07-28", true, false), false);
  assert.equal(shouldRebuildExistingEdition({ ...previous, schemaVersion: 2 }, "2026-07-28", true, false), true);
  assert.equal(shouldRebuildExistingEdition({ ...previous, schemaVersion: 2 }, "2026-07-28", true, true), false);
});

test("detects Monday weekly edition using Asia/Shanghai instead of UTC", () => {
  assert.equal(isWeeklyEditionInShanghai(new Date("2026-08-02T16:30:00.000Z"), editorial.weeklyQuotas.weekday), true);
  assert.equal(isWeeklyEditionInShanghai(new Date("2026-08-03T16:30:00.000Z"), editorial.weeklyQuotas.weekday), false);
});

test("missing Bailian key exits before overwriting previous data", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "signal-desk-test-"));
  const original = JSON.stringify({ edition: { date: "2000-01-01" }, marker: "keep-me" }, null, 2);
  fs.writeFileSync(path.join(temp, "feed.json"), original);
  const env = { ...process.env, SIGNAL_DATA_DIR: temp };
  delete env.DASHSCOPE_API_KEY;
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "generate-feed.js")], { env, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(temp, "feed.json"), "utf8"), original);
});

test("workflow persists only content branch and supports config/force triggers", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "daily-feed.yml"), "utf8");
  assert.match(workflow, /paths:\s*\n\s*- "config\/\*\*"/);
  assert.match(workflow, /"scripts\/\*\*"/);
  assert.match(workflow, /"public\/\*\*"/);
  assert.match(workflow, /\.github\/workflows\/daily-feed\.yml/);
  assert.match(workflow, /force-rebuild-today/);
  assert.match(workflow, /force-weekly-now/);
  assert.match(workflow, /SIGNAL_FORCE_WEEKLY/);
  assert.match(workflow, /\[weekly-now\]/);
  assert.match(workflow, /Checkout existing content branch/);
  assert.match(workflow, /path: content-store/);
  assert.match(workflow, /git rm -rf --ignore-unmatch \./);
  assert.doesNotMatch(workflow, /git worktree/);
  assert.match(workflow, /git push origin HEAD:content/);
  assert.doesNotMatch(workflow, /git add public\/data/);
});

test("static UI contains v2 renderer and v1 fallback without an API key", () => {
  const root = path.join(__dirname, "..", "public");
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(app, /analysis\.fullAnalysis/);
  assert.match(app, /item\.analysis\.learningValue/);
  assert.match(app, /AI 延伸建议/);
  assert.match(app, /\.\/data\/feed\.json/);
  assert.doesNotMatch(app, /DASHSCOPE_API_KEY|\/api\/feed/);
});
