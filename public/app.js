const state = {
  digest: null,
  archiveIndex: [],
  archiveDigest: null,
  view: "today",
  topic: "全部",
  saved: new Set(JSON.parse(localStorage.getItem("signalDeskSaved") || "[]")),
  read: new Set(JSON.parse(localStorage.getItem("signalDeskRead") || "[]")),
  timerSeconds: 30 * 60,
  timerId: null,
  feedLoading: false
};

const DATA_URL = "./data/feed.json";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function formatDate(value) {
  if (!value) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function formatAgo(value) {
  if (!value) return "尚未更新";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 1) return "刚刚更新";
  if (minutes < 60) return `${minutes} 分钟前更新`;
  return `${Math.round(minutes / 60)} 小时前更新`;
}

function compactSummary(value, length = 150) {
  const text = value || "原始来源没有提供摘要，建议直接阅读原文。";
  return text.length > length ? `${text.slice(0, length).trim()}…` : text;
}

function allItems() {
  if (!state.digest) return [];
  return state.digest.items || [...(state.digest.lanes?.ai || []), ...(state.digest.lanes?.game || []), ...(state.digest.lanes?.art || [])];
}

function findArticle(id) {
  return [...allItems(), ...(state.archiveDigest?.items || [])].find((item) => item.id === id);
}

function persist() {
  localStorage.setItem("signalDeskSaved", JSON.stringify([...state.saved]));
  localStorage.setItem("signalDeskRead", JSON.stringify([...state.read]));
  const savedCount = $("#savedCount");
  if (savedCount) savedCount.textContent = state.saved.size;
}

function meta(item) {
  return `<span class="source-pill" style="--source-accent:${escapeHtml(item.accent || "#64748b")}">${escapeHtml(item.sourceName || "未知来源")}</span><span>·</span><span>${formatDate(item.publishedAt)}</span><span>·</span><span>${item.readMinutes || 5} 分钟</span>`;
}

function analysisButton(item) {
  return item.analysis ? `<button class="analysis-button" data-analysis="${escapeHtml(item.id)}">全文分析</button>` : "";
}

function actionButtons(item, includeRead = false) {
  return `<div class="story-actions">
    <a class="action-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">读原文 →</a>
    ${analysisButton(item)}
    ${includeRead ? `<button class="save-button read-toggle ${state.read.has(item.id) ? "saved" : ""}" data-read="${escapeHtml(item.id)}">${state.read.has(item.id) ? "已读" : "标为已读"}</button>` : ""}
    <button class="save-button save-toggle ${state.saved.has(item.id) ? "saved" : ""}" data-save="${escapeHtml(item.id)}">${state.saved.has(item.id) ? "已收藏" : "收藏"}</button>
  </div>`;
}

function card(item) {
  const fallback = item.analysisStatus === "rss-fallback" ? " · 基于摘要" : "";
  return `<article class="story-card ${state.read.has(item.id) ? "read" : ""}">
    <div class="article-meta">${meta(item)}<span class="score">${item.score || 0}</span></div>
    <h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h3>
    <p>${escapeHtml(compactSummary(item.analysis?.summary || item.summary))}</p>
    <p><strong>学习价值：</strong>${escapeHtml(compactSummary((item.analysis?.learningValue || [item.learningNote || "阅读原文并尝试验证"]).join(" "), 180))}${fallback}</p>
    ${actionButtons(item, true)}
  </article>`;
}

function renderToday() {
  const study = state.digest.study || [];
  $("#todayCount").textContent = study.length;
  $("#studyMinutes").textContent = state.digest.stats?.studyMinutes || 30;
  if (!study.length) {
    $("#leadStory").innerHTML = `<div class="empty-state"><strong>今天暂时没有精选内容</strong>可以先复习之前的笔记。</div>`;
    $("#studyList").innerHTML = "";
    return;
  }
  const lead = study[0];
  $("#leadStory").innerHTML = `<div class="lead-copy">
    <div class="article-meta">${meta(lead)}</div>
    <h2>${escapeHtml(lead.title)}</h2>
    <p>${escapeHtml(compactSummary(lead.analysis?.summary || lead.summary, 260))}</p>
    ${actionButtons(lead, true)}
  </div><aside class="lead-side"><div><div class="score-ring">${lead.score || 0}</div><p><strong>学习价值</strong><br>${escapeHtml(compactSummary((lead.analysis?.learningValue || [lead.learningNote || ""]).join(" "), 150))}</p></div><div class="eyebrow">QUALITY SCORE · 100</div></aside>`;
  $("#studyList").innerHTML = study.slice(1).map((item, index) => `<article class="article-row ${state.read.has(item.id) ? "read" : ""}">
    <div class="article-number">0${index + 2}</div>
    <div class="article-body"><h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a></h3><div class="article-meta">${meta(item)}</div><div class="article-note">${escapeHtml(compactSummary(item.analysis?.summary || item.summary, 180))}</div></div>
    <div class="topic-label">${escapeHtml(item.topic || item.lane || "AI")}</div>
    <div class="row-actions"><button class="read-toggle ${state.read.has(item.id) ? "active" : ""}" data-read="${escapeHtml(item.id)}" title="标为已读">✓</button><button class="save-toggle ${state.saved.has(item.id) ? "active" : ""}" data-save="${escapeHtml(item.id)}" title="稍后阅读">☆</button></div>
  </article>`).join("");
  updateReadProgress();
}

function renderFilters() {
  const topics = ["全部", ...new Set((state.digest.lanes?.ai || []).map((item) => item.topic).filter(Boolean))];
  $("#aiFilters").innerHTML = topics.map((topic) => `<button class="filter-chip ${topic === state.topic ? "active" : ""}" data-topic="${escapeHtml(topic)}">${escapeHtml(topic)}</button>`).join("");
}

function renderGrids() {
  const ai = state.topic === "全部" ? (state.digest.lanes?.ai || []) : (state.digest.lanes?.ai || []).filter((item) => item.topic === state.topic);
  $("#aiGrid").innerHTML = ai.map(card).join("") || empty("没有匹配的 AI 文章");
  $("#gameGrid").innerHTML = (state.digest.lanes?.game || []).map(card).join("") || empty("本周暂无新的游戏开发文章");
  $("#artGrid").innerHTML = (state.digest.lanes?.art || []).map(card).join("") || empty("本周暂无新的美术文章");
  renderSaved();
}

function empty(message) {
  return `<div class="empty-state"><strong>${escapeHtml(message)}</strong>下一次定时更新后再来看看。</div>`;
}

function renderSaved() {
  const items = allItems().filter((item) => state.saved.has(item.id));
  $("#savedGrid").innerHTML = items.map(card).join("") || `<div class="empty-state"><strong>还没有稍后阅读</strong>遇到真正想实践的内容再收藏。</div>`;
}

function renderSources() {
  $("#sourceList").innerHTML = (state.digest.sources || []).map((source) => `<div class="source-row"><div><strong>${escapeHtml(source.name)}</strong><small>${escapeHtml(String(source.lane || "").toUpperCase())} · ${source.itemCount || 0} 篇 · ${source.latencyMs || 0}ms</small></div><div class="source-state ${source.ok ? "" : "bad"}">${source.ok ? "正常" : "抓取失败 · 使用旧数据"}</div></div>`).join("");
  $("#healthValue").textContent = `${(state.digest.sources || []).filter((source) => source.ok).length} / ${(state.digest.sources || []).length} 正常`;
}

function renderArchive() {
  const grid = $("#archiveGrid");
  if (!grid) return;
  if (!state.archiveIndex.length) {
    $("#archiveStatus").textContent = "还没有历史简报，首次定时任务完成后会自动生成。";
    grid.innerHTML = "";
    return;
  }
  if (!state.archiveDigest) {
    $("#archiveStatus").textContent = "正在读取历史简报…";
    grid.innerHTML = "";
    return;
  }
  const date = state.archiveDigest.edition?.date || $("#archiveSelect").value;
  const counts = state.archiveDigest.stats || {};
  $("#archiveStatus").textContent = `${date} · AI ${counts.ai || 0} 篇 · 游戏 ${counts.game || 0} 篇 · 美术 ${counts.art || 0} 篇`;
  grid.innerHTML = (state.archiveDigest.items || []).map(card).join("") || empty("这一天没有新的精选文章");
}

function updateReadProgress() {
  const study = state.digest?.study || [];
  const count = study.filter((item) => state.read.has(item.id)).length;
  $("#readProgress").textContent = `${count} / ${study.length}`;
}

function renderAll() {
  renderToday(); renderFilters(); renderGrids(); renderSources(); renderArchive(); persist(); bindDynamicActions();
  $("#freshnessText").textContent = state.digest.stale ? "显示上次成功更新的数据" : `最后更新 ${formatAgo(state.digest.generatedAt)}`;
}

function openAnalysis(id) {
  const item = findArticle(id);
  if (!item?.analysis) return;
  const dialog = $("#analysisDialog");
  $("#analysisTitle").textContent = item.title;
  $("#analysisMeta").innerHTML = `${meta(item)}${item.analysisStatus === "rss-fallback" ? "<span class=\"analysis-warning\">基于 RSS 摘要</span>" : ""}`;
  $("#analysisContent").innerHTML = [
    ["列表简介", item.analysis.summary],
    ["核心要点", item.analysis.keyPoints],
    ["技术细节", item.analysis.technicalDetails],
    ["学习价值", item.analysis.learningValue]
  ].map(([title, value]) => `<section class="analysis-section"><h3>${title}</h3>${Array.isArray(value) ? `<ul>${value.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : `<p>${escapeHtml(value)}</p>`}</section>`).join("");
  $("#analysisSource").href = item.url;
  dialog.showModal();
}

function bindDynamicActions() {
  $$('[data-save]').forEach((button) => button.addEventListener("click", () => toggleSaved(button.dataset.save)));
  $$('[data-read]').forEach((button) => button.addEventListener("click", () => toggleRead(button.dataset.read)));
  $$('[data-analysis]').forEach((button) => button.addEventListener("click", () => openAnalysis(button.dataset.analysis)));
  $$('[data-topic]').forEach((button) => button.addEventListener("click", () => { state.topic = button.dataset.topic; renderFilters(); renderGrids(); bindDynamicActions(); }));
}

function toggleSaved(id) { state.saved.has(id) ? state.saved.delete(id) : state.saved.add(id); renderAll(); }
function toggleRead(id) { state.read.has(id) ? state.read.delete(id) : state.read.add(id); renderAll(); }

function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle("active", section.dataset.page === view));
  $(".sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message; element.classList.add("show");
  clearTimeout(element.hideTimer); element.hideTimer = setTimeout(() => element.classList.remove("show"), 1800);
}

function updateTimer() {
  const minutes = String(Math.floor(state.timerSeconds / 60)).padStart(2, "0");
  const seconds = String(state.timerSeconds % 60).padStart(2, "0");
  $("#timer").textContent = `${minutes}:${seconds}`;
  if (state.timerSeconds <= 0) { clearInterval(state.timerId); state.timerId = null; $("#timerToggle").textContent = "完成"; }
}

function toggleTimer() {
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; $("#timerToggle").textContent = "继续"; }
  else if (state.timerSeconds > 0) { state.timerId = setInterval(() => { state.timerSeconds -= 1; updateTimer(); }, 1000); $("#timerToggle").textContent = "暂停"; }
}

async function loadFeed(force = false) {
  if (state.feedLoading) return;
  state.feedLoading = true; $("#refreshButton").disabled = true;
  $("#freshnessText").textContent = "正在读取每日简报";
  try {
    const response = await fetch(`${DATA_URL}?v=${force ? Date.now() : "latest"}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.digest = await response.json(); renderAll(); if (force) toast("已重新读取最新简报");
  } catch (error) {
    $("#freshnessText").textContent = "简报读取失败";
    if (state.digest) toast("暂时无法读取更新，已保留当前内容");
    else $("#leadStory").innerHTML = `<div class="empty-state"><strong>无法加载简报</strong>${escapeHtml(error.message)}</div>`;
  } finally { state.feedLoading = false; $("#refreshButton").disabled = false; }
}

async function loadArchive(date) {
  if (!date) return;
  state.archiveDigest = null;
  renderArchive();
  try {
    const response = await fetch(`./data/archive/${encodeURIComponent(date)}.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.archiveDigest = await response.json();
    renderArchive(); bindDynamicActions();
  } catch (error) {
    $("#archiveStatus").textContent = `历史简报读取失败：${error.message}`;
  }
}

async function loadArchiveIndex() {
  try {
    const response = await fetch(`./data/archive/index.json?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.archiveIndex = Array.isArray(payload.entries) ? payload.entries : [];
    $("#archiveCount").textContent = state.archiveIndex.length;
    const select = $("#archiveSelect");
    select.innerHTML = state.archiveIndex.map((entry) => `<option value="${escapeHtml(entry.date)}">${escapeHtml(entry.date)}</option>`).join("");
    if (state.archiveIndex.length) await loadArchive(state.archiveIndex[0].date);
    else renderArchive();
  } catch (error) {
    $("#archiveStatus").textContent = `历史索引读取失败：${error.message}`;
  }
}

function setupStaticUI() {
  const now = new Date();
  $("#weekday").textContent = new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(now);
  $("#dateText").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(now);
  $$('.nav-item').forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $("#menuButton").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
  $("#refreshButton").addEventListener("click", () => loadFeed(true));
  $("#showSources").addEventListener("click", () => $("#sourceDialog").showModal());
  $("#closeSources").addEventListener("click", () => $("#sourceDialog").close());
  $("#closeAnalysis").addEventListener("click", () => $("#analysisDialog").close());
  $("#archiveSelect").addEventListener("change", (event) => loadArchive(event.target.value));
  $("#focusButton").addEventListener("click", () => { $("#focusOverlay").hidden = false; });
  $("#closeFocus").addEventListener("click", () => { $("#focusOverlay").hidden = true; });
  $("#timerToggle").addEventListener("click", toggleTimer);
  $("#timerReset").addEventListener("click", () => { clearInterval(state.timerId); state.timerId = null; state.timerSeconds = 1800; $("#timerToggle").textContent = "开始"; updateTimer(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#focusOverlay").hidden) $("#focusOverlay").hidden = true; });
  persist(); updateTimer();
}

setupStaticUI();
loadFeed();
loadArchiveIndex();
