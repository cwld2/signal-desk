(function initSignalDeskRenderUtils(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SignalDeskRenderUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createSignalDeskRenderUtils() {
  const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function dateKey(year, monthIndex, day) {
    return `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
  }

  function monthKey(year, monthIndex) {
    return `${year}-${pad(monthIndex + 1)}`;
  }

  function parseDateKey(value) {
    const match = DATE_PATTERN.exec(String(value || ""));
    if (!match) return null;
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(year, monthIndex, day);
    if (date.getFullYear() !== year || date.getMonth() !== monthIndex || date.getDate() !== day) return null;
    return { year, monthIndex, day, date: dateKey(year, monthIndex, day) };
  }

  function compareMonths(left, right) {
    return (left.year * 12 + left.monthIndex) - (right.year * 12 + right.monthIndex);
  }

  function shiftMonth(month, offset) {
    const date = new Date(month.year, month.monthIndex + offset, 1);
    return { year: date.getFullYear(), monthIndex: date.getMonth() };
  }

  function normalizeCounts(counts) {
    return {
      ai: Math.max(0, Number(counts?.ai) || 0),
      game: Math.max(0, Number(counts?.game) || 0),
      art: Math.max(0, Number(counts?.art) || 0)
    };
  }

  function buildCalendarDays(year, monthIndex, archiveEntries = []) {
    const entries = new Map();
    for (const entry of archiveEntries) {
      const parsed = parseDateKey(entry?.date);
      if (parsed) entries.set(parsed.date, { ...entry, counts: normalizeCounts(entry.counts) });
    }

    const first = new Date(year, monthIndex, 1);
    const mondayOffset = (first.getDay() + 6) % 7;
    const gridStart = new Date(year, monthIndex, 1 - mondayOffset);
    return Array.from({ length: 42 }, (_, index) => {
      const value = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
      const key = dateKey(value.getFullYear(), value.getMonth(), value.getDate());
      const entry = entries.get(key) || null;
      const counts = entry?.counts || normalizeCounts();
      return {
        date: key,
        day: value.getDate(),
        inMonth: value.getFullYear() === year && value.getMonth() === monthIndex,
        hasArchive: Boolean(entry),
        counts,
        total: counts.ai + counts.game + counts.art,
        entry
      };
    });
  }

  function cleanAnnotations(text, annotations = {}) {
    const source = String(text || "");
    const sourceLower = source.toLocaleLowerCase();
    const phrases = new Map();
    const add = (term, values) => {
      const value = String(term || "").trim();
      if (value.length < 2 || value.length > 80 || !sourceLower.includes(value.toLocaleLowerCase())) return;
      const key = value.toLocaleLowerCase();
      const current = phrases.get(key) || { term: value, emphasis: false, query: null };
      phrases.set(key, { ...current, ...values, term: current.term.length >= value.length ? current.term : value });
    };

    const emphasis = Array.isArray(annotations?.emphasis) ? annotations.emphasis : [];
    for (const term of emphasis.slice(0, 32)) add(term, { emphasis: true });

    const searchTerms = Array.isArray(annotations?.searchTerms) ? annotations.searchTerms : [];
    for (const entry of searchTerms.slice(0, 32)) {
      if (!entry || typeof entry !== "object") continue;
      const query = String(entry.query || "").trim();
      if (!query || query.length > 200) continue;
      add(entry.term, { query });
    }
    return [...phrases.values()].sort((a, b) => b.term.length - a.term.length);
  }

  function buildAnnotationSegments(text, annotations = {}, options = {}) {
    const source = String(text || "");
    const terms = cleanAnnotations(source, annotations).map((entry) => ({
      ...entry,
      emphasis: options.emphasis === false ? false : entry.emphasis,
      query: options.search === false ? null : entry.query
    })).filter((entry) => entry.emphasis || entry.query);
    if (!terms.length || !source) return [{ text: source, emphasis: false, query: null }];

    const lower = source.toLocaleLowerCase();
    const segments = [];
    let cursor = 0;
    while (cursor < source.length) {
      let selected = null;
      let selectedIndex = source.length;
      for (const entry of terms) {
        const index = lower.indexOf(entry.term.toLocaleLowerCase(), cursor);
        if (index < 0) continue;
        if (index < selectedIndex || (index === selectedIndex && entry.term.length > selected.term.length)) {
          selected = entry;
          selectedIndex = index;
        }
      }
      if (!selected) {
        segments.push({ text: source.slice(cursor), emphasis: false, query: null });
        break;
      }
      if (selectedIndex > cursor) segments.push({ text: source.slice(cursor, selectedIndex), emphasis: false, query: null });
      const end = selectedIndex + selected.term.length;
      segments.push({ text: source.slice(selectedIndex, end), emphasis: selected.emphasis, query: selected.query });
      cursor = end;
    }
    return segments;
  }

  function bingSearchUrl(query) {
    return `https://www.bing.com/search?q=${encodeURIComponent(String(query || ""))}`;
  }

  return { bingSearchUrl, buildAnnotationSegments, buildCalendarDays, compareMonths, dateKey, monthKey, parseDateKey, shiftMonth };
});
