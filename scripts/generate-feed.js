const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Readability } = require("@mozilla/readability");
const { JSDOM, VirtualConsole } = require("jsdom");
const { parseFeed } = require("../src/feed");

const ROOT = path.join(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const DATA_DIR = path.resolve(process.env.SIGNAL_DATA_DIR || path.join(ROOT, "public", "data"));
const OUTPUT_FILE = path.join(DATA_DIR, "feed.json");
const ARCHIVE_DIR = path.join(DATA_DIR, "archive");
const ARCHIVE_INDEX_FILE = path.join(ARCHIVE_DIR, "index.json");
const TIME_ZONE = "Asia/Shanghai";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

const PRACTICE_WORDS = /tutorial|guide|how to|cookbook|code|implementation|workflow|benchmark|evaluation|api|rag|agent|tool use|local model|godot|unity|shader|animation|pixel|sprite|教程|实践|实现|评测|工作流|本地模型|像素|动画/i;
const UPDATE_WORDS = /release|version|update|available|launch|model|api|security|breaking change|发布|版本|更新|模型|接口|安全/i;
const PROMO_WORDS = /funding|investment|partnership|customer story|economic opportunity|revolutionary|game.?changing|must.?see|融资|投资|合作伙伴|客户故事|颠覆性|重磅来袭/i;

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function loadConfig() {
  const [sourceFile, editorial, inbox] = await Promise.all([
    readJson(path.join(CONFIG_DIR, "sources.json")),
    readJson(path.join(CONFIG_DIR, "editorial.json")),
    readJson(path.join(CONFIG_DIR, "manual-inbox.json"))
  ]);
  if (!Array.isArray(sourceFile?.sources) || !editorial || !Array.isArray(inbox?.entries)) {
    throw new Error("配置文件无效：请检查 config/sources.json、editorial.json 和 manual-inbox.json");
  }
  return {
    sources: sourceFile.sources.filter((source) => source.enabled),
    editorial,
    manualEntries: inbox.entries.filter((entry) => entry?.url)
  };
}

async function fetchText(url, { accept = "*/*", timeout = 20000 } = {}) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "SignalDesk/3.0 (+https://github.com/cwld2/signal-desk; daily learning digest)",
      accept
    },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { text: await response.text(), finalUrl: response.url, contentType: response.headers.get("content-type") || "" };
}

function extractReadableArticle(html, url, maximumCharacters = 30000) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  const dom = new JSDOM(html, { url, virtualConsole });
  try {
    const parsed = new Readability(dom.window.document, { charThreshold: 200 }).parse();
    const text = String(parsed?.textContent || "").replace(/\s+/g, " ").trim();
    return {
      title: String(parsed?.title || "").trim(),
      byline: String(parsed?.byline || "").trim(),
      text: text.slice(0, maximumCharacters),
      originalLength: text.length,
      length: Math.min(text.length, maximumCharacters),
      method: "readability",
      trusted: text.length >= 500
    };
  } finally {
    dom.window.close();
  }
}

async function fetchArticle(item, editorial) {
  try {
    const result = await fetchText(item.url, { accept: "text/html,application/xhtml+xml;q=0.9" });
    if (!/html/i.test(result.contentType) && !/<(?:html|article|main)\b/i.test(result.text)) {
      throw new Error("响应不是 HTML 正文");
    }
    const extraction = extractReadableArticle(result.text, result.finalUrl || item.url, editorial.quality.maximumBodyCharacters);
    if (extraction.length < editorial.quality.minimumBodyCharacters) {
      throw new Error(`正文过短（${extraction.length} 字符）`);
    }
    return { ok: true, extraction, finalUrl: result.finalUrl || item.url };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function parseHtmlListing(html, source, baseUrl = source.url) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});
  const dom = new JSDOM(html, { url: baseUrl, virtualConsole });
  try {
    const itemSelector = source.itemSelector || "article";
    const titleSelector = source.titleSelector || "h2 a, h3 a";
    const summarySelector = source.summarySelector || "p";
    const dateSelector = source.dateSelector || "time";
    return Array.from(dom.window.document.querySelectorAll(itemSelector)).slice(0, 35).map((element) => {
      const titleElement = element.querySelector(titleSelector);
      const title = String(titleElement?.textContent || "").replace(/\s+/g, " ").trim();
      let url;
      try {
        url = new URL(titleElement?.getAttribute("href") || "", baseUrl);
        if (!["http:", "https:"].includes(url.protocol)) return null;
      } catch {
        return null;
      }
      const summary = Array.from(element.querySelectorAll(summarySelector))
        .map((paragraph) => String(paragraph.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" ")
        .slice(0, 900);
      const dateElement = element.querySelector(dateSelector);
      const rawDate = dateElement?.getAttribute("datetime") || dateElement?.textContent || "";
      const parsedDate = Date.parse(rawDate);
      if (!title || !summary) return null;
      return {
        id: hash(`${source.id}|${url.toString()}|${title}`),
        title,
        url: url.toString(),
        summary,
        publishedAt: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null,
        sourceId: source.id,
        sourceName: source.name,
        sourceSite: source.site,
        lane: source.lane,
        accent: source.accent,
        topic: source.lane === "art" ? "像素美术" : source.lane === "game" ? "游戏开发" : "AI 动态",
        score: Math.min(100, Number(source.authority || 3) * 12 + 20),
        readMinutes: 5
      };
    }).filter(Boolean);
  } finally {
    dom.window.close();
  }
}

async function fetchSource(source) {
  const started = Date.now();
  try {
    const result = await fetchText(source.url, {
      accept: source.format === "html"
        ? "text/html,application/xhtml+xml;q=0.9"
        : "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.2"
    });
    const parsedItems = source.format === "html" ? parseHtmlListing(result.text, source, result.finalUrl) : parseFeed(result.text, source);
    const items = parsedItems.map((item) => ({
      ...item,
      category: source.category,
      slot: source.slot || source.category,
      language: source.language,
      sourceWeight: Number(source.weight || 1),
      sourceDailyLimit: Number(source.dailyLimit || 1)
    }));
    if (!items.length) throw new Error("订阅源没有可解析文章");
    return { source: publicSource(source), items, ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { source: publicSource(source), items: [], ok: false, latencyMs: Date.now() - started, error: error.message };
  }
}

function publicSource(source) {
  const { url, ...safe } = source;
  return safe;
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"].forEach((key) => url.searchParams.delete(key));
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(value || "").trim().toLowerCase();
  }
}

function normalizeTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

function deduplicate(items) {
  const urls = new Set();
  const titles = new Set();
  const hashes = new Set();
  return items.filter((item) => {
    const url = normalizeUrl(item.url);
    const title = normalizeTitle(item.title);
    const content = item.bodyHash || item.contentHash || hash(`${title}|${item.summary || ""}`);
    if (!url || !title || urls.has(url) || titles.has(title) || hashes.has(content)) return false;
    urls.add(url);
    titles.add(title);
    hashes.add(content);
    return true;
  });
}

function ageDays(item, now = new Date()) {
  const published = Date.parse(item.publishedAt || "");
  return Number.isFinite(published) ? Math.max(0, (now.getTime() - published) / 86400000) : Number.POSITIVE_INFINITY;
}

function dateWindowFor(item, editorial) {
  if (item.lane === "game") return editorial.dateWindowsDays.game;
  if (item.lane === "art") return editorial.dateWindowsDays.art;
  return editorial.dateWindowsDays[item.category] ?? editorial.dateWindowsDays[item.slot] ?? 14;
}

function candidateScore(item, editorial, now = new Date()) {
  const text = `${item.title} ${item.summary}`;
  const age = ageDays(item, now);
  let score = Number(item.score || 0) * 0.42 + Number(item.sourceWeight || 1) * 22;
  score += Math.max(0, 18 - Math.log2(age + 1) * 3);
  if (PRACTICE_WORDS.test(text)) score += item.slot === "practice" ? 16 : 6;
  if (UPDATE_WORDS.test(text)) score += item.slot === "update" ? 9 : 2;
  if (PROMO_WORDS.test(text)) score -= 30;
  for (const topic of editorial.interestTopics || []) {
    const terms = topic.split(/[、，与和]/).map((term) => term.trim()).filter((term) => term.length >= 2);
    if (terms.some((term) => text.toLowerCase().includes(term.toLowerCase()))) score += 4;
  }
  return Math.round(Math.max(0, Math.min(100, score)));
}

function prefilterCandidates(items, editorial, now = new Date()) {
  const rejected = [];
  const perSource = new Map();
  const eligible = [];
  for (const item of items) {
    const windowDays = dateWindowFor(item, editorial);
    const score = candidateScore(item, editorial, now);
    let reason = null;
    if (ageDays(item, now) > windowDays) reason = `超过 ${windowDays} 天时间窗口`;
    else if (PROMO_WORDS.test(`${item.title} ${item.summary}`) && item.slot === "practice") reason = "宣传性内容不能占实践名额";
    else if (score < editorial.quality.minimumCandidateScore) reason = `本地相关度 ${score} 低于门槛`;
    if (reason) {
      rejected.push(rejection(item, reason, score));
      continue;
    }
    const used = perSource.get(item.sourceId) || 0;
    if (used >= editorial.quality.candidateFetchPerSource) {
      rejected.push(rejection(item, "超过单来源正文候选抓取上限", score));
      continue;
    }
    perSource.set(item.sourceId, used + 1);
    eligible.push({ ...item, candidateScore: score });
  }
  eligible.sort((a, b) => b.candidateScore - a.candidateScore || Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  return { eligible, rejected };
}

function rejection(item, reason, score = item.candidateScore) {
  return { id: item.id, title: item.title, sourceName: item.sourceName, lane: item.lane, category: item.category, score, reason };
}

async function mapLimit(values, limit, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

async function hydrateBodies(items, editorial) {
  const rejected = [];
  const results = await mapLimit(items, 5, async (item) => {
    const bodyResult = await fetchArticle(item, editorial);
    if (!bodyResult.ok) {
      rejected.push(rejection(item, `正文提取失败：${bodyResult.error}`));
      return null;
    }
    const extraction = bodyResult.extraction;
    return {
      ...item,
      url: bodyResult.finalUrl,
      body: extraction.text,
      bodyHash: hash(extraction.text),
      extraction: {
        method: extraction.method,
        length: extraction.length,
        originalLength: extraction.originalLength,
        trusted: extraction.trusted
      },
      readMinutes: Math.max(3, Math.min(30, Math.round(extraction.length / 700)))
    };
  });
  return { candidates: results.filter(Boolean), rejected };
}

function selectionCandidates(candidates) {
  const groups = [
    ["ai-practice", (item) => item.lane === "ai" && item.slot === "practice", 12],
    ["ai-update", (item) => item.lane === "ai" && item.slot === "update", 8],
    ["game", (item) => item.lane === "game", 8],
    ["art", (item) => item.lane === "art", 5]
  ];
  return groups.flatMap(([, predicate, limit]) => candidates.filter(predicate).slice(0, limit));
}

function candidateBodyPool(candidates, weeklyEdition) {
  const practice = candidates.filter((item) => item.lane === "ai" && item.slot === "practice").slice(0, 12);
  const update = candidates.filter((item) => item.lane === "ai" && item.slot === "update").slice(0, 8);
  const game = weeklyEdition ? candidates.filter((item) => item.lane === "game").slice(0, 8) : [];
  const art = weeklyEdition ? candidates.filter((item) => item.lane === "art").slice(0, 8) : [];
  return deduplicate([...practice, ...update, ...game, ...art]);
}

function selectionPrompt(candidates, editorial, weeklyEdition, limitOverride) {
  const practiceLimit = Math.max(0, Number(limitOverride?.practice ?? editorial.automaticQuotas.practice));
  const updateLimit = Math.max(0, Number(limitOverride?.update ?? editorial.automaticQuotas.update));
  const gameLimit = weeklyEdition ? Math.max(0, Number(limitOverride?.game ?? editorial.weeklyQuotas.game)) : 0;
  const artLimit = weeklyEdition ? Math.max(0, Number(limitOverride?.art ?? editorial.weeklyQuotas.art)) : 0;
  const excerptLength = editorial.quality.selectionExcerptCharacters;
  const compact = selectionCandidates(candidates).map((item) => ({
    id: item.id,
    lane: item.lane,
    category: item.category,
    slot: item.slot,
    title: item.title,
    source: item.sourceName,
    publishedAt: item.publishedAt,
    localScore: item.candidateScore,
    rssSummary: item.summary.slice(0, 500),
    bodyExcerpt: item.body.slice(0, excerptLength)
  }));
  return `你是“畅神妙妙屋”的技术内容主编。请依据标题、摘要和已提取正文片段筛选真正可实践、可信、有明确技术信息的文章。

读者兴趣：${editorial.interestTopics.join("；")}
排除内容：${editorial.excludeTopics.join("；")}
硬规则：
1. AI 自动内容最多 ${practiceLimit} 篇 practice 和 ${updateLimit} 篇 update；宁缺毋滥。若某栏目配额为 0 表示今日已满，对应数组返回空。
2. 同一来源最多 1 篇。
3. practice 必须含机制、代码、实验、步骤、评测或可复现工作流，纯观点不能入选。
4. update 必须是会影响实际使用的重要模型、API、版本、安全或兼容性变化，普通公关稿不能入选。
5. 今天${weeklyEdition ? `生成每周内容，目标选满 ${gameLimit} 篇 game 和 ${artLimit} 篇 art；质量不达标时允许少选` : "不生成每周内容，不选 game/art"}。

只返回 JSON：
{"practiceIds":["id"],"updateIds":["id"],"gameIds":["id"],"artIds":["id"],"reasons":{"id":"简短入选或淘汰理由"}}

候选：${JSON.stringify(compact)}`;
}

const DEFAULT_SYSTEM_PROMPT = "你是严谨的中文技术编辑。只输出有效 JSON，不使用 Markdown，不编造原文没有提供的事实。";
const ANALYSIS_SYSTEM_PROMPT = `你是一名擅长向入门学习者解释复杂技术的中文技术编辑。
你的目标不是展示术语，而是帮助读者真正理解文章。
保持技术准确，只输出有效 JSON，不使用 Markdown，不编造原文没有提供的事实。`;

class BailianError extends Error {
  constructor(message, kind = "model") {
    super(message);
    this.name = "BailianError";
    this.kind = kind;
  }
}

class BailianClient {
  constructor(editorial) {
    this.apiKey = process.env.DASHSCOPE_API_KEY;
    this.baseUrl = (process.env.DASHSCOPE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.selectionModel = process.env.DASHSCOPE_SELECTION_MODEL || editorial.models.selection;
    this.analysisModel = process.env.DASHSCOPE_ANALYSIS_MODEL || editorial.models.analysis;
    this.temperature = Number(editorial.models.temperature ?? 0.1);
    this.maximumCalls = Number(editorial.models.maximumCalls || 10);
    this.selectionTimeoutMs = Number(editorial.models.selectionTimeoutMs || 150000);
    this.analysisTimeoutMs = Number(editorial.models.analysisTimeoutMs || 300000);
    this.calls = 0;
    if (!this.apiKey) throw new BailianError("缺少 DASHSCOPE_API_KEY，已停止发布", "auth");
  }

  async json(prompt, model, validator = (value) => value, { systemPrompt = DEFAULT_SYSTEM_PROMPT } = {}) {
    let lastError;
    let attemptPrompt = prompt;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.calls >= this.maximumCalls) throw new BailianError(`百炼调用达到每次任务上限 ${this.maximumCalls}`, "budget");
      this.calls += 1;
      const timeoutMs = model === this.analysisModel ? this.analysisTimeoutMs : this.selectionTimeoutMs;
      console.log(`百炼调用 ${this.calls}/${this.maximumCalls}：${model}，第 ${attempt + 1} 次尝试，超时 ${Math.round(timeoutMs / 1000)} 秒`);
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: attemptPrompt }
            ],
            temperature: this.temperature,
            thinking: { type: "disabled" },
            max_tokens: 16384,
            stream: false
          }),
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          const kind = response.status === 401 || response.status === 403 ? "auth" : response.status === 429 ? "quota" : response.status === 400 || response.status === 404 ? "model" : "network";
          throw new BailianError(`百炼 HTTP ${response.status}: ${detail}`, kind);
        }
        const payload = await response.json();
        const message = payload.choices?.[0]?.message || {};
        return validator(parseModelJson(message.content, message.reasoning_content));
      } catch (error) {
        const kind = error?.name === "TimeoutError" ? "network" : "format";
        lastError = error instanceof BailianError ? error : new BailianError(`${model} 调用失败：${error.message}`, kind);
        if (["auth", "quota", "model", "budget"].includes(lastError.kind)) throw lastError;
        if (attempt === 0 && lastError.kind === "format") {
          console.warn(`${model} 返回内容未通过校验：${lastError.message}；下一次调用将要求定向修正。`);
          attemptPrompt = `${prompt}\n\n上一次输出未通过校验，错误是：${lastError.message}。请重新生成完整 JSON，并重点修正该错误；所有必填数组都必须包含具体内容。`;
        }
      }
    }
    throw lastError || new BailianError("百炼未返回可用 JSON", "format");
  }
}

function extractJson(text) {
  const stripped = String(text || "").replace(/```(?:json)?/gi, "").replace(/```/g, "");
  for (let start = 0; start < stripped.length; start += 1) {
    if (stripped[start] !== "{") continue;
    let depth = 0, inStr = false, esc = false, cand = null;
    for (let i = start; i < stripped.length; i += 1) {
      const c = stripped[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) { cand = stripped.slice(start, i + 1); break; }
      }
    }
    if (cand != null) { try { return JSON.parse(cand); } catch (e) { /* 试下一个 { */ } }
  }
  return null;
}

function parseModelJson(content, reasoning) {
  const sources = [];
  if (content != null) sources.push(content);
  if (reasoning != null && String(reasoning).trim()) sources.push(reasoning);
  let sawBraces = false, lastParseErr = null;
  for (const raw of sources) {
    const stripped = String(raw || "").replace(/```(?:json)?/gi, "").replace(/```/g, "");
    const obj = extractJson(stripped);
    if (obj != null) return obj;
    const s = stripped.indexOf("{"), e = stripped.lastIndexOf("}");
    if (s >= 0) {
      sawBraces = true;
      try { JSON.parse(stripped.slice(s, e + 1)); } catch (err) { lastParseErr = err.message; }
    }
  }
  if (sawBraces) throw new BailianError(`百炼 JSON 格式错误：${lastParseErr}`, "format");
  throw new BailianError("百炼未返回 JSON", "format");
}

function enforceQuota(candidates, ids, predicate, limit, usedSources = new Set(), sourceLimit = 1) {
  if (limit <= 0) return [];
  const byId = new Map(candidates.map((item) => [item.id, item]));
  const sourceCounts = new Map([...usedSources].map((sourceId) => [sourceId, sourceLimit]));
  const selected = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const item = byId.get(id);
    if (!item || !predicate(item) || selected.some((entry) => entry.id === item.id)) continue;
    if ((sourceCounts.get(item.sourceId) || 0) >= Math.min(sourceLimit, item.sourceDailyLimit || sourceLimit)) continue;
    selected.push(item);
    sourceCounts.set(item.sourceId, (sourceCounts.get(item.sourceId) || 0) + 1);
    usedSources.add(item.sourceId);
    if (selected.length >= limit) break;
  }
  return selected;
}

function localSelect(candidates, weeklyEdition, editorial = require("../config/editorial.json")) {
  const used = new Set();
  const take = (predicate, limit) => enforceQuota(candidates, candidates.filter(predicate).map((item) => item.id), predicate, limit, used, editorial.sourceDailyLimit);
  const practice = take((item) => item.lane === "ai" && item.slot === "practice", editorial.automaticQuotas.practice);
  const update = take((item) => item.lane === "ai" && item.slot === "update", editorial.automaticQuotas.update);
  const game = weeklyEdition ? take((item) => item.lane === "game", editorial.weeklyQuotas.game) : [];
  const art = weeklyEdition ? take((item) => item.lane === "art", editorial.weeklyQuotas.art) : [];
  return { practice, update, game, art };
}

async function chooseItems(candidates, weeklyEdition, editorial, client, runReport, limitOverride) {
  const choice = await client.json(selectionPrompt(candidates, editorial, weeklyEdition, limitOverride), client.selectionModel, normalizeSelection);
  const used = new Set();
  const sourceLimit = editorial.sourceDailyLimit;
  const practice = enforceQuota(candidates, choice.practiceIds, (item) => item.lane === "ai" && item.slot === "practice", Math.max(0, Number(limitOverride?.practice ?? editorial.automaticQuotas.practice)), used, sourceLimit);
  const update = enforceQuota(candidates, choice.updateIds, (item) => item.lane === "ai" && item.slot === "update", Math.max(0, Number(limitOverride?.update ?? editorial.automaticQuotas.update)), used, sourceLimit);
  const game = weeklyEdition ? enforceQuota(candidates, choice.gameIds, (item) => item.lane === "game", Math.max(0, Number(limitOverride?.game ?? editorial.weeklyQuotas.game)), used, sourceLimit) : [];
  const art = weeklyEdition ? enforceQuota(candidates, choice.artIds, (item) => item.lane === "art", Math.max(0, Number(limitOverride?.art ?? editorial.weeklyQuotas.art)), used, sourceLimit) : [];
  runReport.selectionReasons = choice.reasons && typeof choice.reasons === "object" ? choice.reasons : {};
  const selectedIds = new Set([...practice, ...update, ...game, ...art].map((item) => item.id));
  for (const item of selectionCandidates(candidates)) {
    if (!selectedIds.has(item.id)) runReport.rejected.push(rejection(item, runReport.selectionReasons[item.id] || "百炼未入选"));
  }
  return { practice, update, game, art };
}

function normalizeSelection(value) {
  if (!value || typeof value !== "object") throw new BailianError("筛选 JSON 不是对象", "format");
  const normalized = {};
  for (const key of ["practiceIds", "updateIds", "gameIds", "artIds"]) {
    if (!Array.isArray(value[key])) throw new BailianError(`筛选 JSON 缺少 ${key}`, "format");
    normalized[key] = value[key].map((id) => String(id)).filter(Boolean);
  }
  normalized.reasons = value.reasons && typeof value.reasons === "object" ? value.reasons : {};
  return normalized;
}

function analysisLengthTarget(bodyLength, editorial) {
  const settings = editorial.analysis;
  if (bodyLength <= settings.shortBodyCharacters) return { tier: "short", min: settings.shortTargetCharacters[0], max: settings.shortTargetCharacters[1] };
  if (bodyLength <= settings.mediumBodyCharacters) return { tier: "medium", min: settings.mediumTargetCharacters[0], max: settings.mediumTargetCharacters[1] };
  return { tier: "long", min: settings.longTargetCharacters[0], max: settings.longTargetCharacters[1] };
}

function analysisPrompt(item, editorial) {
  const target = analysisLengthTarget(item.extraction.length, editorial);
  const readerProfile = editorial.analysis.readerProfile || "懂基本电脑与编程概念，但可能第一次接触本文主题的入门学习者";
  return `请基于下面的原文生成中文结构化学习分析。

目标读者：${readerProfile}。

写作要求：
1. 先解释“这是什么、解决什么问题、为什么值得关心”，再讲实现细节。
2. 使用自然、简洁的中文短句，一句话只表达一个主要意思。
3. 专业术语首次出现时立即用一句白话解释，例如：“向量数据库（简单说，就是专门按语义相似度查找内容的数据库）”。
4. 抽象机制应配一个与 AI 学习、编程、Unity、Godot 或内容制作相关的具体场景。
5. 类比只在准确且有帮助时使用，并明确它只是帮助理解，不能代替原文事实。
6. 避免“赋能、范式、底座、抓手、闭环、生态位”等报告腔；原文必须使用时要解释。
7. 保留 API、模型、版本、数据和参数的准确名称，不为了通俗而省略关键条件。
8. 明确区分原文事实、作者判断和 AI 延伸建议。不得把常识或你的建议写成作者结论；原文没有说明的内容必须标为 AI 推断。
9. 不假设读者已经知道缩写；首次出现时写出全称或解释用途。
10. 不重复同一结论，不用空泛总结凑字数。

输出 JSON 结构：
{
  "displayTitle":"准确自然的中文标题",
  "listSummary":"120-180 字，回答文章讲什么、对读者有什么用、是否值得读",
  "fullAnalysis":[{"heading":"背景与问题","paragraphs":["每个区块先给一句白话结论，再解释原因、过程和边界"]},{"heading":"方法与论证","paragraphs":["段落"]},{"heading":"证据、结论与边界","paragraphs":["段落"]}],
  "keyPoints":["3-6 条，每条都能独立理解，不照抄或复述全文分析"],
  "technicalDetails":[{"text":"按‘它是什么 → 怎么工作 → 为什么重要’解释明确的机制、API、版本、数据或步骤","basis":"source 或 inference"}],
  "engineeringPractice":[{"scenario":"适用场景","steps":["可直接执行的动作"],"tools":["工具"],"verification":["可观察的验证结果"]}],
  "annotations":{"emphasis":["全文分析中值得加粗的重点短语，3-8 个"],"searchTerms":[{"term":"全文分析或技术细节中的专业术语，3-10 个","query":"适合必应搜索的关键词，不要 URL"}]}
}

字段目标：
- listSummary：让读者快速知道“讲什么、对我有什么用、是否值得读”。
- fullAnalysis：每个区块先给一句白话结论，再解释原因、过程和边界。
- keyPoints：每条都能独立理解，不照抄全文。
- technicalDetails：采用“它是什么 → 怎么工作 → 为什么重要”的表达。
- engineeringPractice：步骤使用可直接执行的动作，并给出可观察的验证结果。

全文分析总长度目标约 ${target.min}-${target.max} 个中文字符，覆盖问题背景、文章方法、论证过程、原文证据、结论与适用边界。技术细节必须逐条标注 source（原文事实）或 inference（AI 推断）。engineeringPractice 是 AI 延伸建议，不得冒充作者观点。annotations 只列出逐字出现在对应正文中的短语；query 只写搜索词，不得写 URL。

原标题：${item.title}
来源：${item.sourceName}
发布日期：${item.publishedAt || "未知"}
RSS 摘要：${item.summary}
正文（Readability 提取，${item.extraction.length} 字符）：
${item.body}`;
}

function stringList(value, minimum = 1, maximum = 8) {
  const list = Array.isArray(value) ? value.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, maximum) : [];
  if (list.length < minimum) throw new BailianError("分析 JSON 缺少必要列表项", "format");
  return list;
}

function engineeringPracticeFallback(displayTitle) {
  return [{
    scenario: `围绕“${displayTitle}”建立最小可验证练习`,
    steps: [
      "从原文技术细节中选择一个可独立复现的机制或步骤，明确输入、输出和约束。",
      "在隔离的小项目或副本中实现该步骤，记录关键配置与中间结果。",
      "改变一个关键变量并重复实验，对比结果、失败条件和适用边界。"
    ],
    tools: ["原文涉及的工具或等价本地开发环境", "版本控制与实验记录"],
    verification: [
      "按相同步骤可以重复得到结果。",
      "关键变量变化与结果差异有明确记录。",
      "原文事实与个人推断已分别标注。"
    ]
  }];
}

function normalizeAnnotations(value, fullAnalysis, technicalDetails) {
  if (!value || typeof value !== "object") return undefined;
  const fullText = fullAnalysis.flatMap((section) => section.paragraphs).join("\n");
  const searchableText = `${fullText}\n${technicalDetails.map((detail) => detail.text).join("\n")}`;
  const includes = (haystack, needle) => haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
  const emphasis = [];
  const emphasisSeen = new Set();
  for (const entry of Array.isArray(value.emphasis) ? value.emphasis : []) {
    const term = String(entry || "").trim();
    const key = term.toLocaleLowerCase();
    if (term.length < 2 || term.length > 80 || emphasisSeen.has(key) || !includes(fullText, term)) continue;
    emphasisSeen.add(key);
    emphasis.push(term);
    if (emphasis.length === 8) break;
  }
  const searchTerms = [];
  const searchSeen = new Set();
  for (const entry of Array.isArray(value.searchTerms) ? value.searchTerms : []) {
    if (!entry || typeof entry !== "object") continue;
    const term = String(entry.term || "").trim();
    const query = String(entry.query || "").trim();
    const key = term.toLocaleLowerCase();
    if (term.length < 2 || term.length > 80 || !query || query.length > 200 || /https?:\/\//i.test(query) || searchSeen.has(key) || !includes(searchableText, term)) continue;
    searchSeen.add(key);
    searchTerms.push({ term, query });
    if (searchTerms.length === 10) break;
  }
  return emphasis.length || searchTerms.length ? { emphasis, searchTerms } : undefined;
}

function normalizeAnalysis(raw) {
  const listSummary = String(raw?.listSummary || "").trim();
  const displayTitle = String(raw?.displayTitle || "").trim();
  if (!displayTitle || listSummary.length < 40 || listSummary.length > 400) throw new BailianError("中文标题或列表简介长度不合要求", "format");
  const fullAnalysis = (Array.isArray(raw.fullAnalysis) ? raw.fullAnalysis : []).map((section) => ({
    heading: String(section?.heading || "").trim(),
    paragraphs: stringList(section?.paragraphs, 1, 8)
  })).filter((section) => section.heading);
  if (fullAnalysis.length < 3) throw new BailianError("全文分析区块不足", "format");
  const technicalDetails = (Array.isArray(raw.technicalDetails) ? raw.technicalDetails : []).map((detail) => {
    if (!detail || !["source", "inference"].includes(detail.basis)) throw new BailianError("技术细节必须标注 source 或 inference", "format");
    return { text: String(detail.text || "").trim(), basis: detail.basis };
  }).filter((detail) => detail.text).slice(0, 10);
  if (!technicalDetails.length) throw new BailianError("技术细节为空", "format");
  const engineeringPractice = (Array.isArray(raw.engineeringPractice) ? raw.engineeringPractice : []).map((practice) => {
    const scenario = String(practice?.scenario || "").trim();
    const steps = Array.isArray(practice?.steps) ? practice.steps.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 8) : [];
    const tools = Array.isArray(practice?.tools) ? practice.tools.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 8) : [];
    const verification = Array.isArray(practice?.verification) ? practice.verification.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 8) : [];
    return scenario && steps.length && tools.length && verification.length ? { scenario, steps, tools, verification } : null;
  }).filter(Boolean).slice(0, 4);
  const normalized = {
    listSummary,
    fullAnalysis,
    keyPoints: stringList(raw.keyPoints, 3, 6),
    technicalDetails,
    engineeringPractice: engineeringPractice.length ? engineeringPractice : engineeringPracticeFallback(displayTitle)
  };
  const annotations = normalizeAnnotations(raw.annotations, fullAnalysis, technicalDetails);
  return annotations ? { ...normalized, annotations } : normalized;
}

function previousItems(previous) {
  if (!previous) return [];
  return Array.isArray(previous.items) ? previous.items : Object.values(previous.lanes || {}).flat();
}

function canReuseAnalysis(previous, item, force = false) {
  return Boolean(!force && previous?.analysisStatus === "complete" && previous?.analysis && previous.bodyHash === item.bodyHash);
}

async function analyzeItem(item, previousById, client, editorial, force = false) {
  const previous = previousById.get(item.id);
  if (canReuseAnalysis(previous, item, force) && previous.schemaVersion === 2) {
    return { ...publicItem(item), displayTitle: previous.displayTitle, analysis: previous.analysis, ...(previous.annotations ? { annotations: previous.annotations } : {}), analysisStatus: "complete", analyzedAt: previous.analyzedAt, model: previous.model };
  }
  const result = await client.json(
    analysisPrompt(item, editorial),
    client.analysisModel,
    (raw) => ({ raw, analysis: normalizeAnalysis(raw) }),
    { systemPrompt: ANALYSIS_SYSTEM_PROMPT }
  );
  const { annotations, ...analysis } = result.analysis;
  return {
    ...publicItem(item),
    displayTitle: String(result.raw.displayTitle).trim(),
    analysis,
    ...(annotations ? { annotations } : {}),
    analysisStatus: "complete",
    analyzedAt: new Date().toISOString(),
    model: client.analysisModel
  };
}

function publicItem(item) {
  const { body, sourceWeight, sourceDailyLimit, ...safe } = item;
  return { ...safe, schemaVersion: 2 };
}

function currentDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function isWeeklyEditionInShanghai(date = new Date(), weekday = "Sun") {
  return currentDateParts(date).weekday === weekday;
}

function editionDate(date = new Date()) {
  const parts = currentDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shouldSkipEdition(previous, date, force = false, supplement = false) {
  return Boolean(previous?.edition?.date === date && !force && !supplement);
}

function shouldRebuildExistingEdition(previous, date, force, reselect) {
  return Boolean(previous?.schemaVersion === 2 && previous?.edition?.date === date && force && !reselect);
}

function selectPendingManualEntries(entries, processedUrls, limit) {
  return entries
    .filter((entry) => !processedUrls.has(normalizeUrl(entry.url)))
    .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || String(a.addedAt || "").localeCompare(String(b.addedAt || "")))
    .slice(0, limit);
}

async function manualCandidates(entries, processedUrls, editorial, runReport, sources = []) {
  const pending = selectPendingManualEntries(entries, processedUrls, editorial.manualDailyLimit);
  const candidates = [];
  for (const entry of pending) {
    const lane = ["ai", "game", "art"].includes(entry.lane) ? entry.lane : "ai";
    let parsedUrl;
    try {
      parsedUrl = new URL(entry.url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("只支持 HTTP(S)");
    } catch (error) {
      runReport.rejected.push({ title: entry.note || entry.url, sourceName: "手动候选", lane, reason: `URL 无效，保留等待修正：${error.message}` });
      continue;
    }
    const hostname = parsedUrl.hostname.replace(/^www\./, "");
    const configuredSource = sources.find((source) => {
      try {
        return [source.site, source.url].filter(Boolean).some((value) => new URL(value).hostname.replace(/^www\./, "") === hostname);
      } catch {
        return false;
      }
    });
    const base = {
      id: hash(`manual|${normalizeUrl(entry.url)}`),
      title: entry.note || entry.url,
      url: entry.url,
      summary: entry.note || "手动候选",
      publishedAt: entry.addedAt || null,
      sourceId: configuredSource?.id || `manual-${hostname}`,
      sourceName: configuredSource?.name || hostname,
      sourceSite: parsedUrl.origin,
      lane,
      category: entry.category || "practice",
      slot: entry.category === "update" ? "update" : "practice",
      language: entry.language || "unknown",
      accent: configuredSource?.accent || "#2f6f62",
      candidateScore: 100,
      manual: true,
      manualNote: entry.note || ""
    };
    const bodyResult = await fetchArticle(base, editorial);
    if (!bodyResult.ok) {
      runReport.rejected.push(rejection(base, `手动候选正文失败，保留等待下次：${bodyResult.error}`));
      continue;
    }
    const extraction = bodyResult.extraction;
    candidates.push({
      ...base,
      title: extraction.title || base.title,
      url: bodyResult.finalUrl,
      body: extraction.text,
      bodyHash: hash(extraction.text),
      extraction: { method: extraction.method, length: extraction.length, originalLength: extraction.originalLength, trusted: extraction.trusted },
      readMinutes: Math.max(3, Math.min(30, Math.round(extraction.length / 700)))
    });
  }
  return candidates;
}

function buildOutput({ candidates, selected, analyzed, previous, sourceResults, runReport, date, weeklyEdition, weeklyReason, rebuildExisting = false, client, priorTodayItems = [], prevDayTotals = {} }) {
  const priorWeekly = weeklyEdition || rebuildExisting ? { game: [], art: [] } : {
    game: deduplicate((previous?.lanes?.game || []).filter((item) => !item.manual)),
    art: deduplicate((previous?.lanes?.art || []).filter((item) => !item.manual))
  };
  const priorTodayAi = deduplicate((priorTodayItems || []).filter((item) => item.lane === "ai"));
  const priorTodayGame = deduplicate((priorTodayItems || []).filter((item) => item.lane === "game"));
  const priorTodayArt = deduplicate((priorTodayItems || []).filter((item) => item.lane === "art"));
  const automaticAiIds = new Set([...selected.practice, ...selected.update].map((item) => item.id));
  const weeklyIds = new Set([...selected.game, ...selected.art].map((item) => item.id));
  const manualIds = new Set(selected.manual.map((item) => item.id));
  const ai = deduplicate([...priorTodayAi, ...analyzed.filter((item) => automaticAiIds.has(item.id) || (manualIds.has(item.id) && item.lane === "ai"))]);
  const analyzedGame = deduplicate([...priorTodayGame, ...analyzed.filter((item) => (weeklyIds.has(item.id) || manualIds.has(item.id)) && item.lane === "game")]);
  const analyzedArt = deduplicate([...priorTodayArt, ...analyzed.filter((item) => (weeklyIds.has(item.id) || manualIds.has(item.id)) && item.lane === "art")]);
  const game = deduplicate([...priorWeekly.game, ...analyzedGame]);
  const art = deduplicate([...priorWeekly.art, ...analyzedArt]);
  const items = deduplicate([...ai, ...game, ...art]);
  const previousEditionIds = new Set((previous?.editionItems || []).map((item) => item.id));
  const belongsToRebuiltEdition = (item) => previousEditionIds.size
    ? previousEditionIds.has(item.id)
    : Boolean(previous?.edition?.isWeeklyEdition || item.manual);
  const editionGame = rebuildExisting ? analyzedGame.filter(belongsToRebuiltEdition) : analyzedGame;
  const editionArt = rebuildExisting ? analyzedArt.filter(belongsToRebuiltEdition) : analyzedArt;
  const editionItems = deduplicate([...ai, ...editionGame, ...editionArt]);
  const editionLanes = { ai, game: editionGame, art: editionArt };
  const oldSeen = previous?.history?.seenIds || [];
  const oldManual = previous?.history?.processedManualUrls || [];
  const publishedManualUrls = selected.manual.filter((entry) => items.some((item) => item.id === entry.id)).map((entry) => normalizeUrl(entry.url));
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    timezone: TIME_ZONE,
    schedule: "Daily 05:38 Asia/Shanghai",
    edition: { date, isWeeklyEdition: weeklyEdition, weeklyReason },
    stats: {
      candidates: candidates.length,
      selected: editionItems.length,
      ai: ai.length,
      practice: (Number(prevDayTotals?.practice) || 0) + selected.practice.length,
      update: (Number(prevDayTotals?.update) || 0) + selected.update.length,
      manual: selected.manual.length,
      game: editionGame.length,
      art: editionArt.length,
      currentGame: game.length,
      currentArt: art.length,
      studyMinutes: 30,
      bailianCalls: client.calls
    },
    items,
    editionItems,
    study: ai,
    lanes: { ai, game, art },
    editionLanes,
    sources: sourceResults.map(({ source, ok, latencyMs, error, items: sourceItems }) => ({ ...source, ok, latencyMs, error, itemCount: sourceItems.length })),
    history: {
      seenIds: [...new Set([...oldSeen, ...previousItems(previous).map((item) => item.id), ...items.map((item) => item.id)])].slice(-5000),
      processedManualUrls: [...new Set([...oldManual, ...publishedManualUrls])].slice(-2000)
    },
    run: {
      models: { selection: client.selectionModel, analysis: client.analysisModel },
      calls: client.calls,
      rejectedCount: runReport.rejected.length,
      sourceFailureCount: sourceResults.filter((result) => !result.ok).length
    },
    stale: false,
    previousGeneratedAt: previous?.generatedAt || null
  };
}

async function writeOutput(output) {
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const archiveFile = path.join(ARCHIVE_DIR, `${output.edition.date}.json`);
  const archive = {
    schemaVersion: 2,
    generatedAt: output.generatedAt,
    timezone: output.timezone,
    edition: output.edition,
    stats: output.stats,
    items: output.editionItems,
    editionItems: output.editionItems,
    study: output.study,
    lanes: output.editionLanes
  };
  const currentIndex = await readJson(ARCHIVE_INDEX_FILE, { entries: [] });
  const entries = (Array.isArray(currentIndex?.entries) ? currentIndex.entries : [])
    .filter((entry) => entry.date !== output.edition.date)
    .map((entry) => ({
      ...entry,
      counts: {
        ...entry.counts,
        ai: Math.min(3, Math.max(0, Number(entry.counts?.ai) || 0)),
        game: Math.min(2, Math.max(0, Number(entry.counts?.game) || 0)),
        art: Math.min(2, Math.max(0, Number(entry.counts?.art) || 0))
      }
    }));
  entries.push({
    date: output.edition.date,
    generatedAt: output.generatedAt,
    schemaVersion: 2,
    counts: { ai: output.stats.ai, game: output.stats.game, art: output.stats.art, manual: output.stats.manual }
  });
  entries.sort((a, b) => b.date.localeCompare(a.date));
  const temporary = `${OUTPUT_FILE}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(output, null, 2), "utf8");
  await fs.writeFile(`${archiveFile}.tmp`, JSON.stringify(archive, null, 2), "utf8");
  await fs.writeFile(`${ARCHIVE_INDEX_FILE}.tmp`, JSON.stringify({ updatedAt: output.generatedAt, entries }, null, 2), "utf8");
  await fs.rename(`${archiveFile}.tmp`, archiveFile);
  await fs.rename(`${ARCHIVE_INDEX_FILE}.tmp`, ARCHIVE_INDEX_FILE);
  await fs.rename(temporary, OUTPUT_FILE);
}

async function writeRunSummary(report, client, sourceResults, selected = null) {
  const file = process.env.GITHUB_STEP_SUMMARY || process.env.SIGNAL_RUN_SUMMARY_FILE;
  if (!file) return;
  const selectedItems = selected ? [...selected.practice, ...selected.update, ...selected.game, ...selected.art, ...selected.manual] : [];
  const lines = [
    "## 畅神妙妙屋生成摘要",
    "",
    `- 模型：筛选 \`${client.selectionModel}\`，分析 \`${client.analysisModel}\``,
    `- 百炼调用：${client.calls} / ${client.maximumCalls}`,
    `- 入选：${selectedItems.length} 篇；淘汰记录：${report.rejected.length} 条`,
    `- 来源失败：${sourceResults.filter((result) => !result.ok).length} / ${sourceResults.length}`,
    "",
    "### 入选文章",
    "",
    ...(selectedItems.length ? selectedItems.map((item) => `- [${item.title}](${item.url}) · ${item.sourceName} · ${item.manual ? "手动" : item.slot || item.lane} · 正文 ${item.extraction?.length || 0} 字`) : ["- 本次没有达到门槛的文章"]),
    "",
    "### 淘汰与失败（最多 30 条）",
    "",
    ...report.rejected.slice(0, 30).map((item) => `- ${item.sourceName || "未知来源"} / ${item.title}: ${item.reason}`),
    "",
    "### 来源失败",
    "",
    ...sourceResults.filter((result) => !result.ok).map((result) => `- ${result.source.name}: ${result.error}`)
  ];
  await fs.appendFile(file, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const { sources, editorial, manualEntries } = await loadConfig();
  const previous = await readJson(OUTPUT_FILE);
  const today = editionDate();
  const force = process.env.SIGNAL_FORCE_REBUILD === "1";
  const reselect = process.env.SIGNAL_RESELECT === "1";
  const supplement = process.env.SIGNAL_SUPPLEMENT === "1";
  if (shouldSkipEdition(previous, today, force, supplement)) {
    console.log(`今日 ${today} 已成功生成；正常模式不重复调用百炼。`);
    return;
  }

  const client = new BailianClient(editorial);
  const runReport = { rejected: [], selectionReasons: {} };
  const sourceResults = await Promise.all(sources.map(fetchSource));
  if (!sourceResults.some((result) => result.ok)) throw new Error("所有订阅源抓取失败，保留上次网站");

  const forceWeekly = process.env.SIGNAL_FORCE_WEEKLY === "1";
  const scheduledWeekly = isWeeklyEditionInShanghai(new Date(), editorial.weeklyQuotas.weekday);
  const weeklyEdition = scheduledWeekly || forceWeekly;
  const weeklyReason = forceWeekly && !scheduledWeekly ? "manual" : scheduledWeekly ? String(editorial.weeklyQuotas.weekday || "weekly").toLowerCase() : null;
  const rebuildExisting = shouldRebuildExistingEdition(previous, today, force, reselect);
  let candidates;
  let selected;
  let priorTodayItems = [];
  let prevDayTotals = {};
  let limitOverride;
  if (rebuildExisting) {
    const currentItems = previousItems(previous);
    const hydrated = await hydrateBodies(currentItems, editorial);
    runReport.rejected.push(...hydrated.rejected);
    if (hydrated.candidates.length !== currentItems.length) {
      throw new Error("强制重做时有已发布文章无法重新提取正文，已保留上次网站");
    }
    candidates = deduplicate(hydrated.candidates);
    selected = {
      practice: candidates.filter((item) => !item.manual && item.lane === "ai" && item.slot === "practice"),
      update: candidates.filter((item) => !item.manual && item.lane === "ai" && item.slot === "update"),
      game: candidates.filter((item) => !item.manual && item.lane === "game"),
      art: candidates.filter((item) => !item.manual && item.lane === "art"),
      manual: candidates.filter((item) => item.manual)
    };
    runReport.selectionReasons = Object.fromEntries(candidates.map((item) => [item.id, "强制重做当天既有文章"]));
  } else {
    const seenIds = new Set([...(previous?.history?.seenIds || []), ...previousItems(previous).map((item) => item.id)]);
    const feedItems = deduplicate(sourceResults.flatMap((result) => result.items)).filter((item) => force || !seenIds.has(item.id));
    const filtered = prefilterCandidates(feedItems, editorial);
    runReport.rejected.push(...filtered.rejected);
    const bodyPool = candidateBodyPool(filtered.eligible, weeklyEdition);
    const hydrated = await hydrateBodies(bodyPool, editorial);
    runReport.rejected.push(...hydrated.rejected);
    candidates = deduplicate(hydrated.candidates);
    const hasPriorToday = Boolean(previous?.edition?.date === today);
    if (supplement && hasPriorToday) {
      prevDayTotals = {
        practice: Number(previous?.stats?.practice || 0),
        update: Number(previous?.stats?.update || 0),
        game: weeklyEdition ? Number(previous?.stats?.game || 0) : 0,
        art: weeklyEdition ? Number(previous?.stats?.art || 0) : 0
      };
      limitOverride = {
        practice: Math.max(0, editorial.automaticQuotas.practice - prevDayTotals.practice),
        update: Math.max(0, editorial.automaticQuotas.update - prevDayTotals.update),
        game: weeklyEdition ? Math.max(0, editorial.weeklyQuotas.game - prevDayTotals.game) : 0,
        art: weeklyEdition ? Math.max(0, editorial.weeklyQuotas.art - prevDayTotals.art) : 0
      };
      priorTodayItems = deduplicate(previous?.editionItems || previousItems(previous));
      if (limitOverride.practice === 0 && limitOverride.update === 0 && limitOverride.game === 0 && limitOverride.art === 0) {
        selected = { practice: [], update: [], game: [], art: [], manual: [] };
        console.log(`今日 ${today} 配额已满，补充轮不再调用百炼。`);
      } else {
        selected = await chooseItems(candidates, weeklyEdition, editorial, client, runReport, limitOverride);
      }
    } else {
      selected = await chooseItems(candidates, weeklyEdition, editorial, client, runReport);
    }

    const processedManual = new Set(previous?.history?.processedManualUrls || []);
    selected.manual = await manualCandidates(manualEntries, processedManual, editorial, runReport, sources);
    const usedSources = new Set([...selected.practice, ...selected.update, ...selected.game, ...selected.art].map((item) => item.sourceId));
    selected.manual = selected.manual.filter((item) => {
      if (usedSources.has(item.sourceId)) {
        runReport.rejected.push(rejection(item, "同一来源每天最多一篇，手动候选保留等待下次"));
        return false;
      }
      usedSources.add(item.sourceId);
      return true;
    });
  }

  const previousById = new Map(previousItems(previous).map((item) => [item.id, item]));
  const toAnalyze = [...selected.practice, ...selected.update, ...selected.game, ...selected.art, ...selected.manual];
  const analyzed = [];
  for (const item of toAnalyze) analyzed.push(await analyzeItem(item, previousById, client, editorial, force));

  const output = buildOutput({ candidates, selected, analyzed, previous, sourceResults, runReport, date: today, weeklyEdition, weeklyReason, rebuildExisting, client, priorTodayItems, prevDayTotals });
  await writeOutput(output);
  await writeRunSummary(runReport, client, sourceResults, selected);
  console.log(`生成 ${today}${supplement ? "（补充轮）" : ""} 简报：自动 AI ${output.stats.practice}+${output.stats.update}，手动 ${output.stats.manual}，游戏 ${output.stats.game}，美术 ${output.stats.art}，百炼调用 ${client.calls} 次。`);
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`生成失败，未覆盖上次网站：${error.message}`);
    const summaryFile = process.env.GITHUB_STEP_SUMMARY || process.env.SIGNAL_RUN_SUMMARY_FILE;
    if (summaryFile) {
      await fs.appendFile(summaryFile, `## 畅神妙妙屋生成失败\n\n- 原因：${String(error.message).replace(/\r?\n/g, " ")}\n- 发布结果：已停止，content 分支和线上网站保持上一版。\n`, "utf8").catch(() => {});
    }
    process.exitCode = 1;
  });
}

module.exports = {
  ANALYSIS_SYSTEM_PROMPT,
  BailianClient,
  BailianError,
  DEFAULT_SYSTEM_PROMPT,
  ageDays,
  analysisLengthTarget,
  analysisPrompt,
  buildOutput,
  canReuseAnalysis,
  candidateBodyPool,
  candidateScore,
  currentDateParts,
  deduplicate,
  enforceQuota,
  extractReadableArticle,
  isWeeklyEditionInShanghai,
  localSelect,
  normalizeAnalysis,
  normalizeAnnotations,
  normalizeSelection,
  normalizeUrl,
  parseModelJson,
  parseHtmlListing,
  prefilterCandidates,
  selectPendingManualEntries,
  shouldRebuildExistingEdition,
  shouldSkipEdition
};
