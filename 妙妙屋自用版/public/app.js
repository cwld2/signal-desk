const state = {
  allItems: [],
  digest: null,
  sources: [],
  config: null,
  view: "today",
  saved: new Set(JSON.parse(localStorage.getItem("mmwSaved") || "[]")),
  read: new Set(JSON.parse(localStorage.getItem("mmwRead") || "[]")),
  analyses: JSON.parse(localStorage.getItem("mmwAnalyses") || "{}"),
  timerSeconds: 30 * 60,
  timerId: null,
  loading: false
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function escapeHtml(v = "") {
  return String(v).replace(/[&<>'"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}

function formatDate(v) {
  if (!v) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(v));
}

function formatAgo(v) {
  if (!v) return "尚未更新";
  const m = Math.max(0, Math.round((Date.now() - new Date(v).getTime()) / 60000));
  if (m < 1) return "刚刚更新";
  if (m < 60) return `${m} 分钟前`;
  return `${Math.round(m / 60)} 小时前`;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

function allItems() {
  return state.allItems;
}

function itemsByLane(lane) {
  return allItems().filter(i => i.lane === lane);
}

function meta(item) {
  return `<span class="source-pill" style="--source-accent:${escapeHtml(item.accent || "#64748b")}">${escapeHtml(item.sourceName || "未知来源")}</span><span>·</span><span>${formatDate(item.publishedAt)}</span><span>·</span><span>${item.readMinutes || 5} 分钟</span>`;
}

function actionButtons(item, includeRead = false) {
  const hasAnalysis = Boolean(state.analyses[item.id]);
  return `<div class="story-actions">
    <a class="action-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">读原文 →</a>
    <button class="analysis-button" data-analysis="${escapeHtml(item.id)}">${hasAnalysis ? "查看分析" : "全文分析"}</button>
    ${includeRead ? `<button class="save-button read-toggle ${state.read.has(item.id) ? "saved" : ""}" data-read="${escapeHtml(item.id)}">${state.read.has(item.id) ? "已读" : "标为已读"}</button>` : ""}
    <button class="save-button save-toggle ${state.saved.has(item.id) ? "saved" : ""}" data-save="${escapeHtml(item.id)}">${state.saved.has(item.id) ? "已收藏" : "收藏"}</button>
  </div>`;
}

function card(item) {
  const analysis = state.analyses[item.id];
  const summary = analysis?.summary || item.summary || "原始来源没有提供摘要。";
  return `<article class="story-card ${state.read.has(item.id) ? "read" : ""}">
    <div class="article-meta">${meta(item)}<span class="score">${item.score || 0}</span></div>
    <h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.zhTitle || item.title)}</a></h3>
    <p>${escapeHtml(summary.length > 200 ? summary.slice(0, 200) + "…" : summary)}</p>
    ${actionButtons(item, true)}
  </article>`;
}

function articleRow(item, index) {
  const analysis = state.analyses[item.id];
  const summary = analysis?.summary || item.summary || "";
  const learning = analysis?.learningValue?.join(" ") || "";
  return `<article class="article-row ${state.read.has(item.id) ? "read" : ""}">
    <div class="article-index">${String(index + 1).padStart(2, "0")}</div>
    <div class="article-body">
      <div class="article-meta-row">${meta(item)}</div>
      <h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.zhTitle || item.title)}</a></h3>
      <p>${escapeHtml(item.zhSummary || (summary.length > 180 ? summary.slice(0, 180) + "…" : summary))}</p>
      ${learning ? `<p class="learning-line"><strong>学习价值</strong> ${escapeHtml(learning.length > 160 ? learning.slice(0, 160) + "…" : learning)}</p>` : ""}
    </div>
    <div class="story-actions">${actionButtons(item, true)}</div>
  </article>`;
}

function renderToday() {
  const items = allItems().slice(0, 5);
  $("#todayCount").textContent = items.length;
  const list = $("#studyList");
  if (!items.length) {
    list.innerHTML = `<div class="empty-state"><strong>还没有文章</strong>点击右上角 ↻ 刷新订阅源。</div>`;
    return;
  }
  list.innerHTML = items.map((item, i) => articleRow(item, i)).join("");
}

function renderGrids() {
  const laneMap = { ai: "aiGrid", game: "gameGrid", art: "artGrid" };
  for (const [lane, id] of Object.entries(laneMap)) {
    const items = itemsByLane(lane);
    const grid = $(`#${id}`);
    if (!grid) continue;
    grid.innerHTML = items.length ? items.map(card).join("") : `<div class="empty-state">暂无${lane === "ai" ? "AI" : lane === "game" ? "游戏开发" : "像素美术"}文章</div>`;
  }
}

function renderSaved() {
  const items = allItems().filter(i => state.saved.has(i.id));
  $("#savedCount").textContent = items.length;
  const grid = $("#savedGrid");
  if (!grid) return;
  grid.innerHTML = items.length ? items.map(card).join("") : `<div class="empty-state">还没有收藏文章</div>`;
}
function switchView(view) {
  state.view = view;
  $$(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(s => s.classList.toggle("active", s.dataset.page === view));
  if (view === "sources") loadSources();
  if (view === "settings") loadConfig();
}

function persist() {
  localStorage.setItem("mmwSaved", JSON.stringify([...state.saved]));
  localStorage.setItem("mmwRead", JSON.stringify([...state.read]));
  localStorage.setItem("mmwAnalyses", JSON.stringify(state.analyses));
  const sc = $("#savedCount"); if (sc) sc.textContent = state.saved.size;
}

function bindDynamicActions() {
  $$(".analysis-button").forEach(btn => btn.addEventListener("click", () => openAnalysis(btn.dataset.analysis)));
  $$(".save-toggle").forEach(btn => btn.addEventListener("click", () => {
    const id = btn.dataset.save;
    if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
    persist(); renderToday(); renderGrids(); renderSaved(); bindDynamicActions();
  }));
  $$(".read-toggle").forEach(btn => btn.addEventListener("click", () => {
    const id = btn.dataset.read;
    if (state.read.has(id)) state.read.delete(id); else state.read.add(id);
    persist(); renderToday(); renderGrids(); bindDynamicActions();
  }));
}

function findItem(id) {
  return allItems().find(i => i.id === id);
}

async function openAnalysis(id) {
  const item = findItem(id);
  if (!item) return;
  const dialog = $("#analysisDialog");
  $("#analysisTitle").textContent = item.title;
  $("#analysisMeta").innerHTML = meta(item);
  $("#analysisSource").href = item.url;

  if (state.analyses[id]) {
    renderAnalysisContent(state.analyses[id]);
    dialog.showModal();
    return;
  }

  $("#analysisContent").innerHTML = `<p style="padding:2rem 1.35rem;color:var(--muted)">正在调用 AI 分析，请稍候…</p>`;
  dialog.showModal();
  try {
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: item.url, title: item.title })
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    state.analyses[id] = data.analysis;
    persist();
    renderAnalysisContent(data.analysis);
    renderToday(); renderGrids(); bindDynamicActions();
  } catch (e) {
    $("#analysisContent").innerHTML = `<p style="padding:2rem 1.35rem;color:var(--red)">分析失败：${escapeHtml(e.message)}</p>`;
  }
}

function renderAnalysisContent(analysis) {
  const c = $("#analysisContent");
  if (!analysis) { c.innerHTML = `<p style="padding:2rem;color:var(--muted)">无分析内容</p>`; return; }
  let html = "";
  html += section("列表简介", analysis.summary);
  html += section("核心要点", analysis.keyPoints);
  html += section("技术细节", analysis.technicalDetails);
  html += section("学习价值", analysis.learningValue);
  c.innerHTML = html;
}

function section(title, content) {
  if (!content) return "";
  if (typeof content === "string") return `<div class="analysis-section"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(content)}</p></div>`;
  if (Array.isArray(content)) return `<div class="analysis-section"><h3>${escapeHtml(title)}</h3><ul>${content.map(i => `<li>${escapeHtml(i)}</li>`).join("")}</ul></div>`;
  return "";
}

async function loadFeed() {
  if (state.loading) return;
  state.loading = true;
  $("#refreshButton").disabled = true;
  $("#freshnessText").textContent = "正在抓取订阅源…";
  try {
    const resp = await fetch("/api/refresh", { method: "POST" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    state.allItems = data.items || [];
    state.digest = data;
    renderToday(); renderGrids(); renderSaved(); bindDynamicActions();
    $("#freshnessText").textContent = `已更新 ${data.itemCount} 篇，来源 ${data.sourceCount} 个${data.failedCount ? `，${data.failedCount} 个失败` : ""}`;
    if (data.failedCount) console.log("失败来源：", data.failed);
  } catch (e) {
    $("#freshnessText").textContent = "刷新失败";
    toast(`刷新失败：${e.message}`);
  } finally {
    state.loading = false;
    $("#refreshButton").disabled = false;
  }
}

async function loadSources() {
  try {
    const resp = await fetch("/api/sources");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.sources = await resp.json();
    renderSources();
  } catch (e) {
    $("#sourceList").innerHTML = `<div class="empty-state">加载来源失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderSources() {
  const search = ($("#sourceSearch")?.value || "").toLowerCase();
  const filtered = state.sources.filter(s => !search || s.name.toLowerCase().includes(search) || s.url.toLowerCase().includes(search));
  const list = $("#sourceList");
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state">${search ? "没有匹配的来源" : "还没有来源，点击上方添加"}</div>`;
    return;
  }
  list.innerHTML = filtered.map(s => `
    <div class="source-row ${s.enabled ? "" : "disabled"}" data-source-id="${escapeHtml(s.id)}">
      <div><div class="source-name">${escapeHtml(s.name)}</div><div class="source-url">${escapeHtml(s.url)}</div></div>
      <span class="lane-tag ${escapeHtml(s.lane)}">${s.lane === "ai" ? "AI" : s.lane === "game" ? "GAME" : "ART"}</span>
      <div class="src-fetch-controls"><input type="number" class="src-count-input" data-src-count="${escapeHtml(s.id)}" value="5" min="1" max="30"><button class="src-fetch-btn" data-src-fetch="${escapeHtml(s.id)}">抓取</button></div>
      <button class="toggle-switch ${s.enabled ? "on" : ""}" data-toggle="${escapeHtml(s.id)}" aria-label="启用/禁用"></button>
      <button class="del-btn" data-delete="${escapeHtml(s.id)}" aria-label="删除">×</button>
    </div>
  `).join("");

  $$(".toggle-switch", list).forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.toggle;
    const src = state.sources.find(s => s.id === id);
    if (!src) return;
    await fetch(`/api/sources/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !src.enabled })
    });
    src.enabled = !src.enabled;
    renderSources();
  }));

  $$(".del-btn", list).forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.delete;
    const src = state.sources.find(s => s.id === id);
    if (!src || !confirm(`确认删除来源「${src.name}」？`)) return;
    await fetch(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.sources = state.sources.filter(s => s.id !== id);
    renderSources();
    toast("已删除来源");
  }));
  $$(".src-fetch-btn", list).forEach(btn => btn.addEventListener("click", async () => {
    const row = btn.closest(".source-row");
    const id = btn.dataset.srcFetch;
    const countInput = row.querySelector("[data-src-count]");
    const limit = Math.max(1, parseInt(countInput.value) || 5);
    const src = state.sources.find(s => s.id === id);
    if (!src) return;
    btn.textContent = "抓取中…";
    btn.disabled = true;
    try {
      const resp = await fetch(`/api/refresh/${encodeURIComponent(id)}?limit=${limit}`, { method: "POST" });
      if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error || "HTTP " + resp.status); }
      const data = await resp.json();
      data.items.forEach(item => { if (!state.allItems.find(i => i.url === item.url)) state.allItems.push(item); });
      state.allItems.sort((a, b) => b.score - a.score);
      renderToday(); renderGrids(); renderSaved(); bindDynamicActions();
      toast(`「${data.source}」获取 ${data.itemCount} 篇·已生成中文标题和简介`);
    } catch (e) { toast("抓取失败：" + e.message); }
    finally { btn.textContent = "抓取"; btn.disabled = false; }
  }));
}

async function loadConfig() {
  try {
    const resp = await fetch("/api/config");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.config = await resp.json();
    renderConfigForm();
  } catch (e) {
    $("#configForm").innerHTML = `<div class="empty-state">加载设置失败：${escapeHtml(e.message)}</div>`;
  }
}

function renderConfigForm() {
  const cfg = state.config;
  if (!cfg) return;
  const form = $("#configForm");
  form.innerHTML = `
    <div class="key-status ${cfg.hasKey ? "ok" : "miss"}">${cfg.hasKey ? "✓ API Key 已配置（.env）" : "✗ 未检测到 API Key，请在 .env 中设置 RELAY_API_KEY"}</div>
    <label>中转站 API 地址<input name="apiBaseUrl" value="${escapeHtml(cfg.apiBaseUrl || "")}" placeholder="https://your-relay.com/v1"></label>
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:8px"><button type="button" id="fetchModelsBtn" style="background:#e7ece7;color:var(--green);border:1px solid var(--green-soft);height:38px;padding:0 18px;border-radius:4px;cursor:pointer;font-weight:700;font-size:13px;white-space:nowrap">获取可用模型列表</button><span id="modelsStatus" style="font-size:12px;color:var(--muted)"></span></div>
    <label>筛选模型<select name="selectionModel" id="selectionModelSelect"><option value="${escapeHtml(cfg.selectionModel || "")}">${escapeHtml(cfg.selectionModel || "请先获取模型列表")}</option></select></label>
    <label>分析模型<select name="analysisModel" id="analysisModelSelect"><option value="${escapeHtml(cfg.analysisModel || "")}">${escapeHtml(cfg.analysisModel || "请先获取模型列表")}</option></select></label>
    <label>每次最多文章数<input name="maxArticles" type="number" value="${cfg.maxArticles || 5}" min="1" max="20"></label>
    <label>正文截取上限（字符）<input name="bodyCharLimit" type="number" value="${cfg.bodyCharLimit || 25000}" min="2000" max="60000" step="1000"></label>
    <label>温度<input name="temperature" type="number" value="${cfg.temperature ?? 0.1}" min="0" max="2" step="0.1"></label>
    <label>筛选提示词<textarea name="selectionPrompt">${escapeHtml(cfg.selectionPrompt || "")}</textarea></label>
    <label>分析提示词<textarea name="analysisPrompt">${escapeHtml(cfg.analysisPrompt || "")}</textarea></label>
    <div class="form-actions"><button type="submit">保存设置</button><span id="configSaved" style="color:var(--green);font-size:13px;font-weight:700"></span></div>
  `;
  if (form._handler) form.removeEventListener("submit", form._handler);
  form._handler = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const data = {};
    for (const [k, v] of fd) { if (k === "maxArticles" || k === "bodyCharLimit") data[k] = parseInt(v); else if (k === "temperature") data[k] = parseFloat(v); else data[k] = v; }
    try {
      const resp = await fetch("/api/config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      state.config = await resp.json();
      const sv = $("#configSaved"); if (sv) { sv.textContent = "已保存"; setTimeout(() => { if (sv) sv.textContent = ""; }, 2000); }
      toast("设置已保存");
    } catch (e2) { toast("保存失败：" + e2.message); }
  };
  form.addEventListener("submit", form._handler);
  form.querySelector("#fetchModelsBtn").addEventListener("click", async () => {
    const status = form.querySelector("#modelsStatus");
    const selModel = form.querySelector("#selectionModelSelect");
    const anaModel = form.querySelector("#analysisModelSelect");
    status.textContent = "正在获取模型列表…";
    try {
      const resp = await fetch("/api/models");
      if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(err.error || "HTTP " + resp.status); }
      const data = await resp.json();
      const models = data.models || [];
      if (!models.length) throw new Error("中转站返回了空模型列表");
      const curSel = state.config.selectionModel || "";
      const curAna = state.config.analysisModel || "";
      selModel.innerHTML = models.map(m => `<option value="${m}" ${m === curSel ? "selected" : ""}>${m}</option>`).join("");
      anaModel.innerHTML = models.map(m => `<option value="${m}" ${m === curAna ? "selected" : ""}>${m}</option>`).join("");
      status.textContent = "获取到 " + models.length + " 个模型";
    } catch (e3) { status.textContent = "获取失败：" + e3.message; }
  });
}


function setupUI() {
  const now = new Date();
  $("#weekday").textContent = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now);
  $("#dateText").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(now);
  $$(".nav-item").forEach(btn => btn.addEventListener("click", () => switchView(btn.dataset.view)));
  $("#menuButton").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
  $("#closeAnalysis").addEventListener("click", () => $("#analysisDialog").close());
  $("#sourceSearch").addEventListener("input", () => renderSources());
  $("#addSourceButton").addEventListener("click", () => $("#addDialog").showModal());
  $("#closeAdd").addEventListener("click", () => $("#addDialog").close());
  $("#addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const resp = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fd.get("name"), url: fd.get("url"), lane: fd.get("lane") })
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      await loadSources();
      e.target.reset();
      $("#addDialog").close();
      toast("来源已添加");
    } catch (e2) {
      toast(`添加失败：${e2.message}`);
    }
  });
  $("#refreshButton").addEventListener("click", () => loadFeed());
  $("#focusButton").addEventListener("click", () => { $("#focusOverlay").hidden = false; });
  $("#closeFocus").addEventListener("click", () => { $("#focusOverlay").hidden = true; });
  $("#timerToggle").addEventListener("click", () => {
    if (state.timerId) { clearInterval(state.timerId); state.timerId = null; $("#timerToggle").textContent = "开始"; }
    else if (state.timerSeconds > 0) { state.timerId = setInterval(() => { state.timerSeconds -= 1; updateTimer(); }, 1000); $("#timerToggle").textContent = "暂停"; }
  });
  $("#timerReset").addEventListener("click", () => { clearInterval(state.timerId); state.timerId = null; state.timerSeconds = 1800; $("#timerToggle").textContent = "开始"; updateTimer(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#focusOverlay").hidden) $("#focusOverlay").hidden = true; });
  persist();
}

function updateTimer() {
  const m = Math.floor(state.timerSeconds / 60);
  const s = state.timerSeconds % 60;
  $("#timer").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

setupUI();
loadFeed();
