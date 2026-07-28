const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const sources = require("../sources");

const CACHE_FILE = path.join(__dirname, "..", "data", "cache.json");
const CACHE_TTL = 30 * 60 * 1000;
const MAX_ITEMS_PER_SOURCE = 35;

let memoryCache = null;
let refreshPromise = null;

const TOPICS = [
  ["AI 辅助学习", /learn|education|student|tutor|study|teaching|course|reasoning/i],
  ["Agent 与自动化", /agent|tool use|workflow|automation|computer use|mcp/i],
  ["模型与研究", /model|llm|language model|reasoning|benchmark|research|paper|training/i],
  ["开发实践", /code|developer|api|programming|software|inference|deploy/i],
  ["游戏设计", /game design|level design|gameplay|player|mechanic/i],
  ["引擎技术", /godot|unity|engine|render|shader|physics|animation|2d|3d/i],
  ["像素美术", /\bpixel\b|\bsprite\b|\baseprite\b|\btileset\b|\bpalette\b|\bart\b|\banimation\b/i],
  ["安全与社会", /safety|security|privacy|copyright|policy|alignment|society/i]
];

const HYPE_WORDS = /revolutionary|game.?changing|mind.?blowing|insane|must.?see|secret|shocking|ultimate/i;
const PRACTICAL_WORDS = /tutorial|guide|how to|example|cookbook|code|documentation|technique|build|implementation/i;
const PRODUCT_WORDS = /\bintroducing\b|\bannounc(?:e|ing|ement)\b|\blaunch(?:ed|ing)?\b|\bnow available\b/i;
const CORPORATE_WORDS = /community investment|local jobs|energy affordability|economic opportunity|customer story|partnership agreement|nation of ai|productivity report/i;

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
  return decodeEntities(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  const rss = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  if (rss.length) return rss;
  return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
}

function parseDate(raw) {
  const time = Date.parse(cleanText(raw));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeUrl(raw, base) {
  const value = decodeEntities(cleanText(raw));
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return base;
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"].forEach((key) => url.searchParams.delete(key));
    url.hash = "";
    return url.toString();
  } catch {
    return base;
  }
}

function detectTopic(title, summary, lane) {
  const haystack = `${title} ${summary}`;
  if (lane === "art" && TOPICS[6][1].test(haystack)) return "像素美术";
  const found = TOPICS.find(([, pattern]) => pattern.test(haystack));
  if (found) return found[0];
  return lane === "game" ? "游戏开发" : lane === "art" ? "像素美术" : "AI 动态";
}

function scoreItem(item, source) {
  let score = source.authority * 12;
  const ageHours = Math.max(0, (Date.now() - Date.parse(item.publishedAt || 0)) / 36e5);
  score += Math.max(0, 24 - Math.log2(ageHours + 2) * 4);
  if (PRACTICAL_WORDS.test(`${item.title} ${item.summary}`)) score += 9;
  if (source.lane === "ai" && PRODUCT_WORDS.test(item.title)) score -= 10;
  if (source.lane === "ai" && CORPORATE_WORDS.test(`${item.title} ${item.summary}`)) score -= 18;
  if (item.summary.length > 180) score += 4;
  if (HYPE_WORDS.test(item.title)) score -= 18;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function learningNote(item) {
  const topic = item.topic;
  if (topic === "AI 辅助学习") return "关注它如何改变练习、反馈与知识迁移，而不只是生成答案。";
  if (topic === "Agent 与自动化") return "拆解任务、工具、状态与失败恢复四个环节，判断哪些部分真正可复用。";
  if (topic === "模型与研究") return "先找实验设置和评价指标，再看结论；不要只依据模型排名。";
  if (topic === "开发实践") return "尝试把核心方法缩成一个最小示例，并记录适用边界。";
  if (topic === "游戏设计") return "辨认玩家目标、决策、反馈和难度曲线，思考如何在原型中验证。";
  if (topic === "引擎技术") return "把引擎 API 映射到底层概念：状态、时间步、坐标、资源与渲染。";
  if (topic === "像素美术") return "重点检查轮廓、色板、光源和帧间一致性，不把生成结果直接当成最终资产。";
  return "区分可验证事实、作者判断与产品宣传，并回到原始资料核对。";
}

function parseFeed(xml, source) {
  return itemBlocks(xml).slice(0, MAX_ITEMS_PER_SOURCE).map((block) => {
    const title = cleanText(tag(block, ["title"]));
    const rawLink = tag(block, ["link", "guid"]) || attribute(block, "link", "href");
    const url = normalizeUrl(rawLink, source.site);
    const summary = cleanText(tag(block, ["description", "summary", "content", "content:encoded"])).slice(0, 900);
    const publishedAt = parseDate(tag(block, ["pubDate", "published", "updated", "dc:date"]));
    if (!title || !url) return null;
    const item = {
      id: crypto.createHash("sha1").update(`${source.id}|${url}|${title}`).digest("hex").slice(0, 16),
      title,
      url,
      summary,
      publishedAt,
      sourceId: source.id,
      sourceName: source.name,
      sourceSite: source.site,
      lane: source.lane,
      accent: source.accent,
      topic: detectTopic(title, summary, source.lane)
    };
    item.score = scoreItem(item, source);
    item.learningNote = learningNote(item);
    item.readMinutes = Math.max(3, Math.min(12, Math.round((summary.split(/\s+/).length + 600) / 210)));
    return item;
  }).filter(Boolean);
}

function deduplicate(items) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  return items.filter((item) => {
    const urlKey = item.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").toLowerCase();
    const titleKey = item.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
    if (seenUrls.has(urlKey) || seenTitles.has(titleKey)) return false;
    seenUrls.add(urlKey);
    seenTitles.add(titleKey);
    return true;
  });
}

async function fetchSource(source) {
  const started = Date.now();
  try {
    const response = await fetch(source.url, {
      redirect: "follow",
      headers: { "user-agent": "SignalDesk/1.0 (+local learning reader)", accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.2" },
      signal: AbortSignal.timeout(18000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const items = parseFeed(xml, source);
    if (!items.length) throw new Error("未解析到文章");
    return { source: { ...source, url: undefined }, items, ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { source: { ...source, url: undefined }, items: [], ok: false, latencyMs: Date.now() - started, error: error.message };
  }
}

function buildDigest(results) {
  const items = deduplicate(results.flatMap((result) => result.items))
    .sort((a, b) => b.score - a.score || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  const lanes = {
    ai: items.filter((item) => item.lane === "ai"),
    game: items.filter((item) => item.lane === "game"),
    art: items.filter((item) => item.lane === "art")
  };
  const study = [];
  const usedTopics = new Set();
  const usedSources = new Set();
  const add = (item) => {
    if (!item || study.some((candidate) => candidate.id === item.id)) return false;
    study.push(item);
    usedTopics.add(item.topic);
    usedSources.add(item.sourceId);
    return true;
  };
  for (const item of lanes.ai) {
    if (study.length >= 5) break;
    if (!usedTopics.has(item.topic) && !usedSources.has(item.sourceId)) add(item);
  }
  for (const item of lanes.ai) {
    if (study.length >= 5) break;
    if (!usedSources.has(item.sourceId)) add(item);
  }
  for (const item of lanes.ai) {
    if (study.length >= 5) break;
    add(item);
  }
  return {
    generatedAt: new Date().toISOString(),
    stats: {
      articles: items.length,
      healthySources: results.filter((result) => result.ok).length,
      totalSources: results.length,
      studyMinutes: 30
    },
    study,
    lanes,
    sources: results.map(({ source, ok, latencyMs, error, stale, items: sourceItems }) => ({ ...source, ok, latencyMs, error, stale: Boolean(stale), itemCount: sourceItems.length }))
  };
}

function retainFailedSourceItems(results, cache) {
  if (!cache?.lanes) return results;
  const cachedItems = Object.values(cache.lanes).flat();
  return results.map((result) => {
    if (result.ok) return result;
    const fallbackItems = cachedItems.filter((item) => item.sourceId === result.source.id);
    return fallbackItems.length ? { ...result, items: fallbackItems, stale: true } : result;
  });
}

async function saveCache(cache) {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = Promise.all(sources.map(fetchSource))
    .then((results) => {
      const healthySources = results.filter((result) => result.ok).length;
      if (healthySources === 0) {
        if (memoryCache) return memoryCache;
        throw new Error("所有订阅源均不可用，且没有本地缓存");
      }
      return buildDigest(retainFailedSourceItems(results, memoryCache));
    })
    .then(async (digest) => {
      memoryCache = digest;
      await saveCache(digest);
      return digest;
    })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function getDigest({ force = false } = {}) {
  if (!memoryCache) memoryCache = await loadCache();
  const stale = !memoryCache || Date.now() - Date.parse(memoryCache.generatedAt || 0) > CACHE_TTL;
  if (force || stale) return refresh();
  return memoryCache;
}

module.exports = { getDigest, refresh, parseFeed, retainFailedSourceItems };
