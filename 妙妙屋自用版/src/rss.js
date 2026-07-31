import fs from "node:fs/promises";

function decodeEntities(value = "") {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const radix = entity[1]?.toLowerCase() === "x" ? 16 : 10;
      const number = parseInt(entity.slice(radix === 16 ? 2 : 1), radix);
      return Number.isFinite(number) ? String.fromCodePoint(number) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function cleanText(value = "") {
  return decodeEntities(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function tag(block, names) {
  for (const name of names) {
    const escaped = name.replace(":", "\\:");
    const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
    if (match) return match[1];
  }
  return "";
}

function attribute(block, tagName, attributeName) {
  const match = block.match(new RegExp(`<${tagName}\\b[^>]*\\b${attributeName}=["']([^"']+)["'][^>]*>`, "i"));
  return match?.[1] || "";
}

function itemBlocks(xml) {
  const rss = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  if (rss.length) return rss;
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((m) => m[1]);
}

function parseDate(raw) {
  const time = Date.parse(cleanText(raw));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeUrl(raw, base) {
  const value = decodeEntities(cleanText(raw));
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"].forEach((key) => url.searchParams.delete(key));
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function detectLane(title, summary, sourceLane) {
  if (sourceLane !== "ai") return sourceLane;
  const text = `${title} ${summary}`.toLowerCase();
  if (/\bgame\b|\bunity\b|\bgodot\b/.test(text)) return "game";
  if (/pixel|sprite|aseprite|tileset|palette/.test(text)) return "art";
  return "ai";
}

function estimateReadMinutes(text) {
  return Math.max(1, Math.round(text.length / 800));
}

function scoreItem(item, source) {
  let score = 50;
  const ageHours = Math.max(0, (Date.now() - Date.parse(item.publishedAt || 0)) / 36e5);
  score += Math.max(0, 24 - Math.log2(ageHours + 2) * 4);
  if (/tutorial|guide|how to|example|build|implementation/i.test(`${item.title} ${item.summary}`)) score += 9;
  if (/introducing|announc|launch|now available/i.test(item.title)) score -= 6;
  if (item.summary.length > 180) score += 4;
  if (/revolutionary|game.?changing|mind.?blowing|must.?see/i.test(item.title)) score -= 18;
  return Math.round(Math.max(0, Math.min(100, score)));
}

export async function fetchFeed(source) {
  const response = await fetch(source.url, {
    headers: { "user-agent": "Miaomiaowu/1.0 (+local learning reader)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.2" },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const xml = await response.text();
  const blocks = itemBlocks(xml);
  const base = source.site || source.url;
  return blocks.map((block) => {
    const title = cleanText(tag(block, ["title"]));
    if (!title) return null;
    const link = normalizeUrl(tag(block, ["link"]), base) || attribute(block, "link", "href") || base;
    const summary = cleanText(tag(block, ["description", "summary", "content"])) || "";
    const pub = parseDate(tag(block, ["pubDate", "updated", "published"]));
    const id = `${source.id}:${link}`;
    const item = {
      id, title, url: link, summary,
      sourceName: source.name,
      sourceId: source.id,
      lane: detectLane(title, summary, source.lane),
      accent: source.accent || "#64748b",
      publishedAt: pub,
      readMinutes: estimateReadMinutes(summary)
    };
    item.score = scoreItem(item, source);
    return item;
  }).filter(Boolean);
}

export async function extractArticleBody(url) {
  const { Readability } = await import("@mozilla/readability");
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const response = await fetch(url, {
    headers: { "user-agent": "Miaomiaowu/1.0 (+local learning reader)" },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {});
  const dom = new JSDOM(html, { url, virtualConsole: vc });
  try {
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article || !article.textContent || article.textContent.length < 200) return null;
    return {
      text: article.textContent.slice(0, 30000),
      length: article.textContent.length,
      excerpt: article.textContent.slice(0, 500)
    };
  } finally {
    dom.window.close();
  }
}

export { decodeEntities, cleanText };
