const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFeed, retainFailedSourceItems } = require("../src/feed");

const source = {
  id: "fixture",
  name: "Fixture Source",
  site: "https://example.com/blog/",
  lane: "ai",
  authority: 5,
  accent: "#123456"
};

test("parses RSS items and cleans tracking parameters", () => {
  const xml = `<?xml version="1.0"?>
    <rss><channel><item>
      <title><![CDATA[Build an AI agent &amp; test it]]></title>
      <link>https://example.com/posts/agent?utm_source=rss&amp;keep=yes</link>
      <description><![CDATA[<p>A practical <strong>workflow</strong> with tools.</p>]]></description>
      <pubDate>Tue, 28 Jul 2026 02:00:00 GMT</pubDate>
    </item></channel></rss>`;
  const items = parseFeed(xml, source);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Build an AI agent & test it");
  assert.equal(items[0].url, "https://example.com/posts/agent?keep=yes");
  assert.equal(items[0].summary, "A practical workflow with tools.");
  assert.equal(items[0].topic, "Agent 与自动化");
  assert.ok(items[0].score > 0);
});

test("parses Atom entries with link attributes and relative URLs", () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Pixel animation timing guide</title>
      <link rel="alternate" href="/pixel/timing" />
      <summary>Four frames, a limited palette, and consistent silhouettes.</summary>
      <updated>2026-07-27T08:00:00Z</updated>
    </entry></feed>`;
  const items = parseFeed(xml, { ...source, lane: "art" });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://example.com/pixel/timing");
  assert.equal(items[0].topic, "像素美术");
  assert.equal(items[0].publishedAt, "2026-07-27T08:00:00.000Z");
});

test("skips malformed entries without a title", () => {
  const xml = `<rss><channel><item><link>https://example.com/no-title</link></item></channel></rss>`;
  assert.deepEqual(parseFeed(xml, source), []);
});

test("rejects non-web link protocols from a feed", () => {
  const xml = `<rss><channel><item><title>Unsafe link</title><link>javascript:alert(1)</link></item></channel></rss>`;
  const items = parseFeed(xml, source);
  assert.equal(items[0].url, source.site);
});

test("retains cached items when one source is temporarily unavailable", () => {
  const cachedItem = { id: "old", sourceId: "fixture", lane: "ai" };
  const results = [{ source, ok: false, items: [], error: "timeout" }];
  const hydrated = retainFailedSourceItems(results, { lanes: { ai: [cachedItem], game: [], art: [] } });
  assert.deepEqual(hydrated[0].items, [cachedItem]);
  assert.equal(hydrated[0].stale, true);
  assert.equal(hydrated[0].ok, false);
});
