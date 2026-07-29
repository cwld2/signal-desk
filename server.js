const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { getDigest } = require("./src/feed");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const REFRESH_INTERVAL_MINUTES = Math.max(5, Number(process.env.REFRESH_INTERVAL_MINUTES || 30));
const REFRESH_INTERVAL_MS = REFRESH_INTERVAL_MINUTES * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function json(response, status, value) {
  response.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function serveFile(requestPath, response) {
  const decoded = decodeURIComponent(requestPath.split("?")[0]);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR)) return json(response, 403, { error: "Forbidden" });
  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-cache" });
    response.end(data);
  } catch {
    json(response, 404, { error: "Not found" });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname === "/api/feed" && request.method === "GET") {
      const digest = await getDigest({ force: url.searchParams.get("refresh") === "1" });
      return json(response, 200, digest);
    }
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json(response, 200, { ok: true, now: new Date().toISOString(), refreshIntervalMinutes: REFRESH_INTERVAL_MINUTES });
    }
    if (request.method !== "GET") return json(response, 405, { error: "Method not allowed" });
    return serveFile(url.pathname, response);
  } catch (error) {
    console.error(error);
    json(response, 500, { error: "抓取失败，请稍后重试", detail: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`畅神妙妙屋正在运行：http://${HOST}:${PORT}`);
  getDigest().catch((error) => console.error("Initial feed refresh failed:", error.message));
});

const refreshTimer = setInterval(() => {
  getDigest({ force: true })
    .then((digest) => console.log(`Feed refreshed at ${digest.generatedAt}`))
    .catch((error) => console.error("Scheduled feed refresh failed:", error.message));
}, REFRESH_INTERVAL_MS);
refreshTimer.unref();
