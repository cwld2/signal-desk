const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const sources = require("../sources");
const { parseFeed } = require("../src/feed");

const ROOT = path.join(__dirname, "..");
const OUTPUT_FILE = path.join(ROOT, "public", "data", "feed.json");
const ARCHIVE_DIR = path.join(ROOT, "public", "data", "archive");
const ARCHIVE_INDEX_FILE = path.join(ARCHIVE_DIR, "index.json");
const LEGACY_CACHE_FILE = path.join(ROOT, "data", "cache.json");
const TIME_ZONE = "Asia/Shanghai";
const MAX_AI = 3;
const MAX_GAME = 2;
const MAX_ART = 1;
const MAX_BODY_CHARS = 18000;
const DEFAULT_SELECTION_MODEL = process.env.DASHSCOPE_SELECTION_MODEL || "qwen3.7-flash";
const DEFAULT_ANALYSIS_MODEL = process.env.DASHSCOPE_ANALYSIS_MODEL || "qwen3.7-flash";
const DASHSCOPE_BASE_URL = (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");

function hash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 20);
}

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
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function articleBody(html = "") {
  const withoutNoise = html
    .replace(/<(script|style|noscript|nav|footer|header|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const candidates = [
    withoutNoise.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1],
    withoutNoise.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1],
    withoutNoise.match(/<div[^>]+(?:class|id)=["'][^"']*(?:article|post|entry|content|body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1],
    withoutNoise
  ].filter(Boolean);
  const best = candidates.map(cleanText).sort((a, b) => b.length - a.length)[0] || "";
  return best.slice(0, MAX_BODY_CHARS);
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

async function fetchText(url, { accept = "*/*", timeout = 18000 } = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "SignalDesk/2.0 (+daily static learning digest)",
      accept
    },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function fetchSource(source) {
  const started = Date.now();
  try {
    const xml = await fetchText(source.url, { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.2" });
    const items = parseFeed(xml, source).map((item) => ({
      ...item,
      sourceUrl: source.url,
      contentHash: hash(`${item.url}|${item.title}|${item.summary}`)
    }));
    if (!items.length) throw new Error("No feed items parsed");
    return { source: { ...source, url: undefined }, items, ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { source: { ...source, url: undefined }, items: [], ok: false, latencyMs: Date.now() - started, error: error.message };
  }
}

function deduplicate(items) {
  const urls = new Set();
  const titles = new Set();
  return items.filter((item) => {
    const url = item.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    const title = item.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
    if (urls.has(url) || titles.has(title)) return false;
    urls.add(url); titles.add(title);
    return true;
  });
}

function localScore(item) {
  const ageHours = Math.max(0, (Date.now() - Date.parse(item.publishedAt || 0)) / 36e5);
  let score = Number(item.score || 0) + Math.max(0, 24 - Math.log2(ageHours + 2) * 4);
  if (/tutorial|guide|how to|documentation|implementation|code|workflow|technique|build/i.test(`${item.title} ${item.summary}`)) score += 12;
  if (/announcement|introducing|launch|now available|pricing|event/i.test(item.title)) score -= 8;
  if (/revolutionary|game.?changing|mind.?blowing|must.?see|ultimate/i.test(item.title)) score -= 15;
  return Math.round(Math.max(0, Math.min(100, score)));
}

function candidatesForLane(items, lane) {
  const maxAgeDays = lane === "ai" ? 7 : 60;
  const candidates = items.filter((item) => {
    if (item.lane !== lane) return false;
    if (!item.publishedAt) return true;
    const published = Date.parse(item.publishedAt || 0);
    return !Number.isFinite(published) || Date.now() - published <= maxAgeDays * 86400000;
  }).map((item) => ({ ...item, candidateScore: localScore(item) }));
  candidates.sort((a, b) => b.candidateScore - a.candidateScore || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  return candidates.slice(0, 12);
}

function localSelect(items, isSunday) {
  const pick = (lane, count) => {
    const pool = candidatesForLane(items, lane);
    const result = [];
    const sourcesUsed = new Set();
    for (const item of pool) {
      if (result.length >= count) break;
      if (!sourcesUsed.has(item.sourceId) || result.length >= count - 1) {
        result.push(item); sourcesUsed.add(item.sourceId);
      }
    }
    return result;
  };
  return {
    ai: pick("ai", MAX_AI),
    game: isSunday ? pick("game", MAX_GAME) : [],
    art: isSunday ? pick("art", MAX_ART) : []
  };
}

function selectionPrompt(items, isSunday) {
  const candidates = ["ai", ...(isSunday ? ["game", "art"] : [])]
    .flatMap((lane) => candidatesForLane(items, lane).map((item) => ({
      id: item.id,
      lane: item.lane,
      title: item.title,
      source: item.sourceName,
      publishedAt: item.publishedAt,
      summary: item.summary.slice(0, 700),
      score: item.candidateScore
    })));
  return `你是一个克制的学习资讯编辑。请从候选文章中选出真正有技术含量、可学习、不过度宣传的内容。优先选择有实现细节、教程、实验、工程经验或底层原理的文章；避免纯产品发布、营销、公关和重复报道。需要保证来源尽量多样。\n\n今天是否为周日：${isSunday ? "是" : "否"}\nAI 最多选 3 篇${isSunday ? "，游戏开发最多 2 篇，美术最多 1 篇" : ""}。只返回 JSON，不要 Markdown：\n{"aiIds":["..."],"gameIds":["..."],"artIds":["..."]}\n\n候选：${JSON.stringify(candidates)}`;
}

function analysisPrompt(item, body) {
  return `你是面向中文初学者和实践者的技术编辑。请基于文章资料生成严谨、克制的学习分析。不要编造文章未提到的事实；不确定时明确写“文章未说明”。只返回 JSON，不要 Markdown。\n\nJSON 格式：{"summary":"列表简介","keyPoints":["核心要点"],"technicalDetails":["技术细节"],"learningValue":["学习价值"]}\n要求：summary 为 80-140 字；keyPoints 2-5 条；technicalDetails 2-6 条，解释机制、流程、工具或限制；learningValue 2-4 条，说明读者可以学到什么以及如何验证。\n\n标题：${item.title}\n来源：${item.sourceName}\nRSS 摘要：${item.summary}\n正文（可能不完整）：${body || "正文抓取失败，请仅依据 RSS 摘要并明确说明限制。"}`;
}

function parseModelJson(raw) {
  const text = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Bailian did not return JSON");
  return JSON.parse(text.slice(start, end + 1));
}

async function callBailian(prompt, model) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return null;
  const endpoint = `${DASHSCOPE_BASE_URL}/chat/completions`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "你是严谨的中文技术编辑，只输出用户要求的 JSON。" },
            { role: "user", content: prompt }
          ],
          temperature: 0.2,
          stream: false
        }),
        signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`Bailian HTTP ${response.status}: ${detail}`);
      }
      const payload = await response.json();
      const raw = payload.choices?.[0]?.message?.content;
      return parseModelJson(raw);
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
  return null;
}

function normalizeList(value, fallback) {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 8);
    return normalized.length ? normalized : fallback;
  }
  return fallback;
}

function fallbackAnalysis(item, reason = "未调用阿里云百炼") {
  return {
    summary: item.summary || "原文未提供可用摘要，建议直接阅读原文。",
    keyPoints: ["本文未完成 AI 深度分析。", "请以原文内容和作者提供的证据为准。"],
    technicalDetails: [reason, "正文可能受访问限制或来源摘要长度影响。"],
    learningValue: ["先确认文章的适用场景，再尝试复现其中的关键步骤。", "将结论与自己的项目或学习目标对照。"]
  };
}

async function getBody(item) {
  try {
    const html = await fetchText(item.url, { accept: "text/html,application/xhtml+xml" });
    const body = articleBody(html);
    if (body.length < 240) throw new Error("正文过短或需要登录");
    return body;
  } catch (error) {
    return { error: error.message, text: "" };
  }
}

function currentDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function isSundayInShanghai(date = new Date()) {
  return currentDateParts(date).weekday === "Sun";
}

function previousItems(previous) {
  if (!previous) return [];
  return previous.items || Object.values(previous.lanes || {}).flat();
}

function reuseEditionSelection(previous, date) {
  if (previous?.edition?.date !== date) return null;
  return {
    ai: [...(previous.lanes?.ai || [])],
    game: [...(previous.lanes?.game || [])],
    art: [...(previous.lanes?.art || [])]
  };
}

async function chooseItems(items, isSunday) {
  const local = localSelect(items, isSunday);
  const selected = { ai: local.ai, game: local.game, art: local.art };
  if (!items.length || !process.env.DASHSCOPE_API_KEY) return selected;
  try {
    const choice = await callBailian(selectionPrompt(items, isSunday), DEFAULT_SELECTION_MODEL);
    const byId = new Map(items.map((item) => [item.id, item]));
    const take = (ids, lane, limit) => (Array.isArray(ids) ? ids : []).map((id) => byId.get(id)).filter((item) => item?.lane === lane).slice(0, limit);
    selected.ai = take(choice.aiIds, "ai", MAX_AI);
    selected.game = isSunday ? take(choice.gameIds, "game", MAX_GAME) : [];
    selected.art = isSunday ? take(choice.artIds, "art", MAX_ART) : [];
    if (!selected.ai.length) selected.ai = local.ai;
    if (isSunday && !selected.game.length) selected.game = local.game;
    if (isSunday && !selected.art.length) selected.art = local.art;
  } catch (error) {
    console.warn(`Bailian selection fallback: ${error.message}`);
  }
  return selected;
}

function canReuseAnalysis(previous, item) {
  return Boolean(previous?.analysis && previous.contentHash === item.contentHash && previous.analysisStatus === "complete");
}

async function enrichItem(item, previousById) {
  const previous = previousById.get(item.id);
  const bodyResult = await getBody(item);
  const body = typeof bodyResult === "string" ? bodyResult : "";
  const enrichedItem = { ...item, contentHash: hash(body || item.summary || `${item.url}|${item.title}`) };
  if (canReuseAnalysis(previous, enrichedItem)) {
    return { ...enrichedItem, analysis: previous.analysis, analysisStatus: previous.analysisStatus, analyzedAt: previous.analyzedAt, model: previous.model };
  }
  if (!body || !process.env.DASHSCOPE_API_KEY) {
    return { ...enrichedItem, analysis: fallbackAnalysis(item, bodyResult?.error || "DASHSCOPE_API_KEY 未配置"), analysisStatus: "rss-fallback", analyzedAt: new Date().toISOString(), model: null };
  }
  try {
    const result = await callBailian(analysisPrompt(item, body), DEFAULT_ANALYSIS_MODEL);
    const analysis = {
      summary: String(result?.summary || item.summary).trim(),
      keyPoints: normalizeList(result?.keyPoints, fallbackAnalysis(item).keyPoints),
      technicalDetails: normalizeList(result?.technicalDetails, fallbackAnalysis(item).technicalDetails),
      learningValue: normalizeList(result?.learningValue, fallbackAnalysis(item).learningValue)
    };
    return { ...enrichedItem, summary: analysis.summary, analysis, analysisStatus: "complete", analyzedAt: new Date().toISOString(), model: DEFAULT_ANALYSIS_MODEL };
  } catch (error) {
    console.warn(`Bailian analysis fallback for ${item.id}: ${error.message}`);
    return { ...enrichedItem, analysis: fallbackAnalysis(item, error.message), analysisStatus: "rss-fallback", analyzedAt: new Date().toISOString(), model: DEFAULT_ANALYSIS_MODEL };
  }
}

function buildOutput(allItems, selected, results, sourceResults, previous) {
  const selectedIds = new Set([...selected.ai, ...selected.game, ...selected.art].map((item) => item.id));
  const selectedResults = results.filter((item) => selectedIds.has(item.id));
  const byLane = (lane) => selectedResults.filter((item) => item.lane === lane);
  const date = currentDateParts();
  const seenIds = [...new Set([
    ...(previous?.history?.seenIds || []),
    ...previousItems(previous).map((item) => item.id),
    ...selectedResults.map((item) => item.id)
  ])].slice(-1000);
  return {
    generatedAt: new Date().toISOString(),
    timezone: TIME_ZONE,
    schedule: "Daily 08:00 Asia/Shanghai",
    edition: { date: `${date.year}-${date.month}-${date.day}`, isSunday: date.weekday === "Sun" },
    stats: { candidates: allItems.length, selected: selectedResults.length, ai: byLane("ai").length, game: byLane("game").length, art: byLane("art").length, studyMinutes: 30 },
    items: selectedResults,
    study: byLane("ai"),
    lanes: { ai: byLane("ai"), game: byLane("game"), art: byLane("art") },
    sources: sourceResults.map(({ source, ok, latencyMs, error, items }) => ({ ...source, ok, latencyMs, error, itemCount: items.length })),
    history: { seenIds },
    stale: false,
    previousGeneratedAt: previous?.generatedAt || null
  };
}

async function writeArchive(output) {
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const date = output.edition.date;
  const edition = {
    generatedAt: output.generatedAt,
    timezone: output.timezone,
    edition: output.edition,
    stats: output.stats,
    items: output.items,
    study: output.study,
    lanes: output.lanes
  };
  await fs.writeFile(path.join(ARCHIVE_DIR, `${date}.json`), JSON.stringify(edition, null, 2), "utf8");
  const currentIndex = await readJson(ARCHIVE_INDEX_FILE);
  const entries = Array.isArray(currentIndex?.entries) ? currentIndex.entries.filter((entry) => entry.date !== date) : [];
  entries.push({ date, generatedAt: output.generatedAt, counts: { ai: output.stats.ai, game: output.stats.game, art: output.stats.art } });
  entries.sort((a, b) => b.date.localeCompare(a.date));
  await fs.writeFile(ARCHIVE_INDEX_FILE, JSON.stringify({ updatedAt: output.generatedAt, entries }, null, 2), "utf8");
}

async function main() {
  const previous = await readJson(OUTPUT_FILE) || await readJson(LEGACY_CACHE_FILE);
  const sourceResults = await Promise.all(sources.map(fetchSource));
  const healthy = sourceResults.filter((result) => result.ok).length;
  if (!healthy) {
    if (!previous) throw new Error("All sources failed and no previous feed exists");
    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify({ ...previous, stale: true, generatedAt: previous.generatedAt }, null, 2), "utf8");
    console.warn("All sources failed; retained previous feed");
    return;
  }
  const allItems = deduplicate(sourceResults.flatMap((result) => result.items));
  const sunday = isSundayInShanghai();
  const date = currentDateParts();
  const editionDate = `${date.year}-${date.month}-${date.day}`;
  const seenIds = new Set([...(previous?.history?.seenIds || []), ...previousItems(previous).map((item) => item.id)]);
  const unseenItems = allItems.filter((item) => !seenIds.has(item.id));
  const selected = reuseEditionSelection(previous, editionDate) || await chooseItems(unseenItems, sunday);
  if (!sunday && previous?.edition?.date !== editionDate) {
    selected.game = (previous?.lanes?.game || []).slice(0, MAX_GAME);
    selected.art = (previous?.lanes?.art || []).slice(0, MAX_ART);
  }
  const previousById = new Map(previousItems(previous).map((item) => [item.id, item]));
  const results = [];
  for (const item of [...selected.ai, ...selected.game, ...selected.art]) results.push(await enrichItem(item, previousById));
  const output = buildOutput(allItems, selected, results, sourceResults, previous);
  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
  await writeArchive(output);
  console.log(`Generated ${OUTPUT_FILE}: ${output.stats.selected} selected (${output.stats.ai} AI, ${output.stats.game} game, ${output.stats.art} art)`);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });

module.exports = { articleBody, canReuseAnalysis, currentDateParts, deduplicate, fallbackAnalysis, isSundayInShanghai, localSelect, normalizeList, parseModelJson, reuseEditionSelection };
