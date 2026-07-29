const state = {
  digest: null,
  githubDigest: null,
  archiveIndex: [],
  archiveDigest: null,
  selectedArchiveDate: null,
  archiveMonth: null,
  view: "today",
  topic: "全部",
  saved: new Set(JSON.parse(localStorage.getItem("signalDeskSaved") || "[]")),
  read: new Set(JSON.parse(localStorage.getItem("signalDeskRead") || "[]")),
  timerSeconds: 30 * 60,
  timerId: null,
  feedLoading: false
};

const DATA_URL = "./data/feed.json";
const GITHUB_DATA_URL = "./data/github.json";
const RenderUtils = window.SignalDeskRenderUtils;
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

function articleTitle(item) {
  return item.displayTitle || item.title || "未命名文章";
}

function listSummary(item) {
  return item.analysis?.listSummary || item.analysis?.summary || item.summary;
}

function learningPreview(item) {
  if (Array.isArray(item.analysis?.engineeringPractice) && item.analysis.engineeringPractice[0]?.scenario) {
    return `可实践场景：${item.analysis.engineeringPractice[0].scenario}`;
  }
  if (Array.isArray(item.analysis?.learningValue)) return item.analysis.learningValue.join(" ");
  if (Array.isArray(item.analysis?.keyPoints)) return item.analysis.keyPoints[0] || item.learningNote || "阅读原文并验证关键结论";
  return item.learningNote || "阅读原文并验证关键结论";
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
    <h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(articleTitle(item))}</a></h3>
    <p>${escapeHtml(compactSummary(listSummary(item)))}</p>
    <p><strong>学习价值：</strong>${escapeHtml(compactSummary(learningPreview(item), 180))}${fallback}</p>
    ${actionButtons(item, true)}
  </article>`;
}

function renderToday() {
  const study = state.digest.study || [];
  $("#todayCount").textContent = study.length;
  $("#studyMinutes").textContent = state.digest.stats?.studyMinutes || 30;
  if (!study.length) {
    $("#studyList").innerHTML = `<div class="empty-state"><strong>今天暂时没有精选内容</strong>可以先复习之前的笔记。</div>`;
    updateReadProgress();
    return;
  }
  $("#studyList").innerHTML = study.map((item, index) => `<article class="article-row ${state.read.has(item.id) ? "read" : ""}">
    <div class="article-number">${String(index + 1).padStart(2, "0")}</div>
    <div class="article-body">
      <div class="article-meta">${meta(item)}</div>
      <h3><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(articleTitle(item))}</a></h3>
      <p class="article-note">${escapeHtml(compactSummary(listSummary(item), 260))}</p>
      <p class="learning-line"><strong>学习价值</strong>${escapeHtml(compactSummary(learningPreview(item), 180))}</p>
      <span class="topic-label">${escapeHtml(item.topic || item.lane || "AI")}</span>
    </div>
    ${actionButtons(item, true)}
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

function githubNumber(value) {
  const number = Math.max(0, Number(value) || 0);
  return number >= 1000 ? `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k` : String(number);
}

function githubCard(item, index) {
  const topics = (Array.isArray(item.topics) ? item.topics : []).slice(0, 4);
  return `<article class="github-card">
    <div class="github-card-head"><span class="github-rank">${String(index + 1).padStart(2, "0")}</span><span class="github-path">${escapeHtml(item.fullName || item.name)}</span></div>
    <h2><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name || item.fullName)}</a></h2>
    <p class="github-summary">${escapeHtml(item.summary || item.description || "暂无项目简介")}</p>
    <dl class="github-facts">
      <div><dt>语言</dt><dd>${escapeHtml(item.language || "未标注")}</dd></div>
      <div><dt>Stars</dt><dd>${githubNumber(item.stars)}</dd></div>
      <div><dt>本周</dt><dd>${item.weeklyStars ? `+${githubNumber(item.weeklyStars)}` : "趋势入选"}</dd></div>
    </dl>
    <section class="github-note"><strong>为什么推荐</strong><p>${escapeHtml(item.whyRecommended)}</p></section>
    <section class="github-note try"><strong>先看这里</strong><p>${escapeHtml(item.firstLook)}</p></section>
    ${topics.length ? `<div class="github-topics">${topics.map((topic) => `<span>${escapeHtml(topic)}</span>`).join("")}</div>` : ""}
    <a class="action-link github-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">查看仓库 →</a>
  </article>`;
}

function renderGithub() {
  const items = state.githubDigest?.items || [];
  $("#githubCount").textContent = items.length;
  $("#githubGrid").innerHTML = items.map(githubCard).join("") || `<div class="empty-state"><strong>本周推荐尚未生成</strong>周二更新完成后会显示两个项目。</div>`;
  if (!state.githubDigest) return;
  const weekStart = state.githubDigest.weekStart || "";
  $("#githubWeekBadge").textContent = weekStart ? weekStart.slice(5).replace("-", "/") : "--";
  $("#githubStatus").textContent = `${weekStart || "本周"} 起 · ${items.length} 个项目 · ${formatAgo(state.githubDigest.generatedAt)}`;
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

function archiveCounts(digest) {
  if (Array.isArray(digest?.editionItems)) return digest.stats || {};
  const unique = new Map();
  for (const item of digest?.items || []) {
    const key = item.id || item.url || `${item.lane}|${articleTitle(item)}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const items = [...unique.values()];
  return {
    ai: Math.min(3, items.filter((item) => item.lane === "ai").length),
    game: Math.min(2, items.filter((item) => item.lane === "game").length),
    art: Math.min(2, items.filter((item) => item.lane === "art").length)
  };
}

function renderCalendar() {
  const grid = $("#calendarGrid");
  const month = state.archiveMonth;
  if (!grid || !month) return;
  const days = RenderUtils.buildCalendarDays(month.year, month.monthIndex, state.archiveIndex);
  const today = new Date();
  const todayKey = RenderUtils.dateKey(today.getFullYear(), today.getMonth(), today.getDate());
  $("#calendarMonth").textContent = `${month.year}年${month.monthIndex + 1}月`;
  grid.innerHTML = days.map((day) => {
    const classes = ["calendar-day"];
    if (!day.inMonth) classes.push("outside");
    if (day.date === todayKey) classes.push("today");
    if (day.date === state.selectedArchiveDate) classes.push("selected");
    const dots = ["ai", "game", "art"].filter((lane) => day.counts[lane] > 0)
      .map((lane) => `<i class="lane-dot ${lane}"></i>`).join("");
    const label = day.hasArchive ? `${day.date}，共 ${day.total} 篇简报` : `${day.date}，无简报`;
    return `<button class="${classes.join(" ")}" data-archive-date="${day.hasArchive ? day.date : ""}" ${day.hasArchive ? "" : "disabled"} aria-label="${label}" ${day.date === state.selectedArchiveDate ? "aria-pressed=\"true\"" : ""}>
      <span class="calendar-date">${day.day}</span>
      ${day.hasArchive ? `<span class="calendar-count">${day.total} 篇</span><span class="calendar-dots">${dots}</span>` : ""}
    </button>`;
  }).join("");

  const validDates = state.archiveIndex.map((entry) => RenderUtils.parseDateKey(entry.date)).filter(Boolean);
  const earliest = validDates.at(-1);
  const latest = validDates[0];
  $("#previousMonth").disabled = !earliest || RenderUtils.compareMonths(month, earliest) <= 0;
  $("#nextMonth").disabled = !latest || RenderUtils.compareMonths(month, latest) >= 0;
  $$('[data-archive-date]', grid).forEach((button) => button.addEventListener("click", () => loadArchive(button.dataset.archiveDate)));
}

function renderArchive() {
  const grid = $("#archiveGrid");
  if (!grid) return;
  renderCalendar();
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
  const date = state.archiveDigest.edition?.date || state.selectedArchiveDate;
  const counts = archiveCounts(state.archiveDigest);
  $("#archiveStatus").textContent = `${date} · AI ${counts.ai || 0} 篇 · 游戏 ${counts.game || 0} 篇 · 美术 ${counts.art || 0} 篇`;
  grid.innerHTML = (state.archiveDigest.items || []).map(card).join("") || empty("这一天没有新的精选文章");
}

function updateReadProgress() {
  const study = state.digest?.study || [];
  const count = study.filter((item) => state.read.has(item.id)).length;
  $("#readProgress").textContent = `${count} / ${study.length}`;
}

function renderAll() {
  renderToday(); renderFilters(); renderGrids(); renderGithub(); renderSources(); renderArchive(); persist(); bindDynamicActions();
  $("#freshnessText").textContent = state.digest.stale ? "显示上次成功更新的数据" : `最后更新 ${formatAgo(state.digest.generatedAt)}`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text || "");
  return node;
}

function appendAnnotatedText(parent, text, annotations, options = {}) {
  const segments = RenderUtils.buildAnnotationSegments(text, annotations, options);
  for (const segment of segments) {
    let content = document.createTextNode(segment.text);
    if (segment.emphasis) {
      const strong = document.createElement("strong");
      strong.append(content);
      content = strong;
    }
    if (segment.query) {
      const link = element("a", "term-link");
      link.href = RenderUtils.bingSearchUrl(segment.query);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = `搜索：${segment.query}`;
      link.append(content);
      content = link;
    }
    parent.append(content);
  }
}

function analysisSection(title) {
  const section = element("section", "analysis-section");
  section.append(element("h3", "", title));
  return section;
}

function openAnalysis(id) {
  const item = findArticle(id);
  if (!item?.analysis) return;
  const dialog = $("#analysisDialog");
  $("#analysisTitle").textContent = articleTitle(item);
  $("#analysisMeta").innerHTML = `${meta(item)}${item.analysisStatus === "rss-fallback" ? "<span class=\"analysis-warning\">基于 RSS 摘要</span>" : ""}`;
  if (item.schemaVersion === 2 || Array.isArray(item.analysis.fullAnalysis)) {
    const annotations = item.annotations || item.analysis.annotations || {};
    const content = $("#analysisContent");
    content.replaceChildren();

    const summary = analysisSection("列表简介");
    summary.append(element("p", "", item.analysis.listSummary || item.summary));
    content.append(summary);

    const full = analysisSection("全文分析");
    full.classList.add("full-analysis");
    for (const sourceSection of item.analysis.fullAnalysis || []) {
      const subsection = element("div", "analysis-subsection");
      subsection.append(element("h4", "", sourceSection.heading));
      for (const paragraph of sourceSection.paragraphs || []) {
        const node = document.createElement("p");
        appendAnnotatedText(node, paragraph, annotations, { emphasis: true, search: true });
        subsection.append(node);
      }
      full.append(subsection);
    }
    content.append(full);

    const points = analysisSection("核心要点");
    const pointsList = document.createElement("ul");
    for (const line of item.analysis.keyPoints || []) pointsList.append(element("li", "", line));
    points.append(pointsList);
    content.append(points);

    const details = analysisSection("技术细节");
    const detailList = element("ul", "detail-list");
    for (const detail of item.analysis.technicalDetails || []) {
      const structured = detail && typeof detail === "object";
      const inferred = structured && detail.basis === "inference";
      const row = document.createElement("li");
      row.append(element("span", `basis-tag ${inferred ? "inference" : "source"}`, inferred ? "AI 推断" : "原文事实"));
      appendAnnotatedText(row, structured ? detail.text : detail, annotations, { emphasis: false, search: true });
      detailList.append(row);
    }
    details.append(detailList);
    content.append(details);

    const practices = analysisSection("");
    practices.firstChild.remove();
    const practiceTitle = element("div", "section-title-row");
    practiceTitle.append(element("h3", "", "类似工程实践"), element("span", "", "AI 延伸建议"));
    practices.append(practiceTitle);
    for (const practice of item.analysis.engineeringPractice || []) {
      const block = element("article", "practice-block");
      block.append(element("h4", "", practice.scenario));
      const steps = element("div");
      steps.append(element("strong", "", "步骤"));
      const ordered = document.createElement("ol");
      for (const step of practice.steps || []) ordered.append(element("li", "", step));
      steps.append(ordered);
      const tools = element("div");
      tools.append(element("strong", "", "工具"), element("p", "", (practice.tools || []).join("、")));
      const verification = element("div");
      verification.append(element("strong", "", "验证"));
      const checks = document.createElement("ul");
      for (const step of practice.verification || []) checks.append(element("li", "", step));
      verification.append(checks);
      block.append(steps, tools, verification);
      practices.append(block);
    }
    content.append(practices);
  } else {
    $("#analysisContent").innerHTML = [
      ["列表简介", item.analysis.summary],
      ["核心要点", item.analysis.keyPoints],
      ["技术细节", item.analysis.technicalDetails],
      ["学习价值", item.analysis.learningValue]
    ].map(([title, value]) => `<section class="analysis-section"><h3>${title}</h3>${Array.isArray(value) ? `<ul>${value.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : `<p>${escapeHtml(value)}</p>`}</section>`).join("");
  }
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
    else $("#studyList").innerHTML = `<div class="empty-state"><strong>无法加载简报</strong>${escapeHtml(error.message)}</div>`;
  } finally { state.feedLoading = false; $("#refreshButton").disabled = false; }
}

async function loadGithubFeed() {
  try {
    const response = await fetch(`${GITHUB_DATA_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.githubDigest = await response.json();
    renderGithub();
  } catch (error) {
    $("#githubStatus").textContent = "本周推荐暂时无法读取";
    renderGithub();
  }
}

async function loadArchive(date) {
  if (!date) return;
  const parsed = RenderUtils.parseDateKey(date);
  if (!parsed) return;
  state.selectedArchiveDate = parsed.date;
  state.archiveMonth = { year: parsed.year, monthIndex: parsed.monthIndex };
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
    state.archiveIndex = (Array.isArray(payload.entries) ? payload.entries : [])
      .filter((entry) => RenderUtils.parseDateKey(entry?.date))
      .sort((left, right) => right.date.localeCompare(left.date));
    $("#archiveCount").textContent = state.archiveIndex.length;
    if (state.archiveIndex.length) {
      const latest = RenderUtils.parseDateKey(state.archiveIndex[0].date);
      state.archiveMonth = { year: latest.year, monthIndex: latest.monthIndex };
      state.selectedArchiveDate = latest.date;
      renderCalendar();
      await loadArchive(latest.date);
    }
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
  $("#previousMonth").addEventListener("click", () => { state.archiveMonth = RenderUtils.shiftMonth(state.archiveMonth, -1); renderCalendar(); });
  $("#nextMonth").addEventListener("click", () => { state.archiveMonth = RenderUtils.shiftMonth(state.archiveMonth, 1); renderCalendar(); });
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
loadGithubFeed();
