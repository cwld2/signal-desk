import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchFeed, extractArticleBody } from "./src/rss.js";
import { RelayClient } from "./src/ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4175;
const DATA_DIR = path.join(__dirname, "data");
const SOURCES_FILE = path.join(DATA_DIR, "sources.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");

let env = {};
async function loadEnv() {
  env = {};
  try {
    const raw = await fs.readFile(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}
if (Object.keys(env).length === 0) loadEnv();

async function loadJson(file, fallback) {
  try { return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch { return fallback; }
}

async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function getApiKey() { return process.env.RELAY_API_KEY || env.RELAY_API_KEY || ""; }

async function getConfig() {
  const cfg = await loadJson(CONFIG_FILE, {});
  return {
    apiBaseUrl: cfg.apiBaseUrl || env.RELAY_BASE_URL || "",
    selectionModel: cfg.selectionModel || "gpt-4o-mini",
    analysisModel: cfg.analysisModel || "gpt-4o",
    temperature: cfg.temperature ?? 0.1,
    maxArticles: cfg.maxArticles ?? 5,
    bodyCharLimit: cfg.bodyCharLimit ?? 25000,
    selectionPrompt: cfg.selectionPrompt || "",
    analysisPrompt: cfg.analysisPrompt || ""
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

async function serveStatic(res, urlPath) {
  let filePath = path.join(PUBLIC_DIR, urlPath);
  if (urlPath === "/" || urlPath === "") filePath = path.join(PUBLIC_DIR, "index.html");
  const ext = path.extname(filePath);
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  }
}


async function batchTranslate(items, config, limit) {
  const apiKey = getApiKey();
  if (!apiKey || !config.apiBaseUrl) return items;
  const client = new RelayClient({ ...config, apiKey });
  try {
    const toProcess = items.slice(0, limit || items.length);
    const results = await client.batchTranslateSummary(toProcess, config.selectionModel);
    const map = new Map(results.map(r => [r.id, r]));
    return items.map(item => {
      const t = map.get(item.id);
      if (t) return { ...item, zhTitle: t.zhTitle || "", zhSummary: t.zhSummary || "" };
      return item;
    });
  } catch (e) {
    console.error("batchTranslate error:", e.message);
    return items;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === "/api/sources" && req.method === "GET") {
      const sources = await loadJson(SOURCES_FILE, []);
      return json(res, 200, sources);
    }

    if (p === "/api/sources" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.name || !body.url) return json(res, 400, { error: "名称和 RSS 地址必填" });
      const sources = await loadJson(SOURCES_FILE, []);
      const id = (body.name || "src").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Date.now().toString(36);
      const source = {
        id, name: body.name, url: body.url, lane: body.lane || "ai",
        language: body.language || "en", enabled: true, accent: body.accent || "#64748b"
      };
      sources.push(source);
      await saveJson(SOURCES_FILE, sources);
      return json(res, 201, source);
    }

    if (p.startsWith("/api/sources/") && req.method === "PUT") {
      const id = decodeURIComponent(p.slice("/api/sources/".length));
      const body = await readBody(req);
      const sources = await loadJson(SOURCES_FILE, []);
      const idx = sources.findIndex((s) => s.id === id);
      if (idx < 0) return json(res, 404, { error: "来源不存在" });
      sources[idx] = { ...sources[idx], ...body, id };
      await saveJson(SOURCES_FILE, sources);
      return json(res, 200, sources[idx]);
    }

    if (p.startsWith("/api/sources/") && req.method === "DELETE") {
      const id = decodeURIComponent(p.slice("/api/sources/".length));
      let sources = await loadJson(SOURCES_FILE, []);
      sources = sources.filter((s) => s.id !== id);
      await saveJson(SOURCES_FILE, sources);
      return json(res, 200, { ok: true });
    }

    if (p === "/api/refresh" && req.method === "POST") {
      const sources = await loadJson(SOURCES_FILE, []);
      const enabled = sources.filter((s) => s.enabled);
      const results = await Promise.allSettled(enabled.map((s) => fetchFeed(s)));
      const allItems = [];
      const failed = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") for (const item of r.value) allItems.push(item);
        else failed.push({ source: enabled[i].name, error: r.reason?.message || String(r.reason) });
      });
      const seen = new Set();
      const deduped = [];
      for (const item of allItems.sort((a, b) => b.score - a.score)) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        deduped.push(item);
      }
      const config = await getConfig();
      const itemsWithZh = await batchTranslate(deduped.slice(0, 50), config, config.maxArticles || 15);
      return json(res, 200, {
        generatedAt: new Date().toISOString(),
        itemCount: deduped.length,
        sourceCount: enabled.length,
        failedCount: failed.length,
        failed,
        items: itemsWithZh
      });
    }

    if (p.startsWith("/api/refresh/") && req.method === "POST") {
      const sourceId = decodeURIComponent(p.slice("/api/refresh/".length));
      const sources = await loadJson(SOURCES_FILE, []);
      const src = sources.find((s) => s.id === sourceId);
      if (!src) return json(res, 404, { error: '来源不存在' });
      try {
        const items = await fetchFeed(src);
        const limit = Math.max(1, parseInt(url.searchParams.get("limit")) || 10);
        const config = await getConfig();
        const itemsWithZh = await batchTranslate(items.slice(0, limit), config, limit);
        return json(res, 200, { source: src.name, itemCount: items.length, items: itemsWithZh });
      } catch (e) {
        return json(res, 502, { error: '抓取失败：' + e.message });
      }
    }

    if (p === "/api/analyze" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.url) return json(res, 400, { error: "缺少文章 URL" });
      const config = await getConfig();
      config.apiKey = getApiKey();
      const client = new RelayClient(config);
      const article = await extractArticleBody(body.url);
      if (!article) return json(res, 422, { error: "无法提取正文，可能是登录墙或页面内容过短" });
      const analysis = await client.analyzeArticle(body.title || "", article.text, config);
      return json(res, 200, { analysis, bodyLength: article.length });
    }


    if (p === "/api/models" && req.method === "GET") {
      const config = await getConfig();
      const apiKey = getApiKey();
      if (!apiKey) return json(res, 400, { error: "未配置 API Key，无法获取模型列表" });
      if (!config.apiBaseUrl) return json(res, 400, { error: "未配置中转站 API 地址" });
      try {
        const resp = await fetch(config.apiBaseUrl.replace(/\/+$/, "") + "/models", {
          headers: { "Authorization": "Bearer " + apiKey },
          signal: AbortSignal.timeout(15000)
        });
        if (!resp.ok) {
          const detail = await resp.text().catch(() => "");
          return json(res, resp.status, { error: "中转站返回 " + resp.status + "：" + detail.slice(0, 200) });
        }
        const payload = await resp.json();
        const models = (Array.isArray(payload.data) ? payload.data : []).map(m => m.id).filter(Boolean).sort();
        return json(res, 200, { models });
      } catch (e) {
        return json(res, 502, { error: "获取模型列表失败：" + e.message });
      }
    }

    if (p === "/api/config" && req.method === "GET") {
      const config = await getConfig();
      config.hasKey = Boolean(getApiKey());
      return json(res, 200, config);
    }

    if (p === "/api/config" && req.method === "PUT") {
      const body = await readBody(req);
      const old = await getConfig();
      const updated = {
        ...old,
        apiBaseUrl: body.apiBaseUrl ?? old.apiBaseUrl,
        selectionModel: body.selectionModel || old.selectionModel,
        analysisModel: body.analysisModel || old.analysisModel,
        temperature: body.temperature ?? old.temperature,
        maxArticles: body.maxArticles ?? old.maxArticles,
        bodyCharLimit: body.bodyCharLimit ?? old.bodyCharLimit,
        selectionPrompt: body.selectionPrompt ?? old.selectionPrompt,
        analysisPrompt: body.analysisPrompt ?? old.analysisPrompt
      };
      await saveJson(CONFIG_FILE, updated);
      return json(res, 200, { ...updated, hasKey: Boolean(getApiKey()) });
    }

    if (p.startsWith("/api/")) return json(res, 404, { error: "Unknown API route" });
    await serveStatic(res, p);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const key = getApiKey();
  console.log(`畅神妙妙屋（自用版）正在运行：http://127.0.0.1:${PORT}`);
  if (!key) console.log("⚠ 未检测到 RELAY_API_KEY，AI 分析功能不可用。请在 .env 中配置。");
});
