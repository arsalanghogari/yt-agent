// Shared rendering for the YouTube panel (content.js) and the library page (library.js): DOM helper, time
// formatting, icons, safe markdown, and mind maps. Exposed as globalThis.StudyPal.

(() => {
  if (globalThis.StudyPal) return;

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }

  function parseTime(str) {
    const p = str.split(":").map(Number);
    return p.reduce((a, b) => a * 60 + b, 0);
  }

  const toSeconds = (v) => (typeof v === "number" ? v : parseTime(String(v ?? "").replace(/[^\d:]/g, "") || "NaN"));
  const watchUrl = (videoId, t) => `https://www.youtube.com/watch?v=${videoId}${t != null ? `&t=${Math.floor(t)}s` : ""}`;

  // Inline SVG (24px grid, stroked, currentColor) so they follow the theme. Static strings only.
  const ICONS = {
    chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h5"/>',
    cards: '<rect x="3" y="7" width="14" height="12" rx="2"/><path d="M7 7V5h14v12h-4"/>',
    quiz: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    review: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/><path d="M12 8v4l3 2"/>',
    trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
    gear: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    map: '<circle cx="12" cy="12" r="2.5"/><circle cx="4.5" cy="5.5" r="2"/><circle cx="19.5" cy="5.5" r="2"/><circle cx="4.5" cy="18.5" r="2"/><circle cx="19.5" cy="18.5" r="2"/><path d="M6 7l4 3.5M18 7l-4 3.5M6 17l4-3.5M18 17l-4-3.5"/>',
    library: '<path d="M5 4h3v16H5zM10.5 4h3v16h-3z"/><path d="M16 5l3-.8 3.5 15.6-3 .7z"/>',
    share: '<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5"/><path d="M5 13v6h14v-6"/>',
    play: '<path d="M8 5l11 7-11 7z"/>'
  };
  function icon(name, size = 18) {
    const span = el("span", { class: "yta-ico", "aria-hidden": "true" });
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  }

  // Timestamps ([4:32] or bare 4:32) become a.yta-ts. With onTime they seek the player; with videoId they
  // link to that moment on YouTube (for the library, PDFs and shared study packs).
  function wireTimes(root, { onTime, videoId } = {}) {
    root.querySelectorAll("a.yta-ts").forEach((a) => {
      const t = parseTime(a.dataset.t);
      if (videoId) { a.href = watchUrl(videoId, t); a.target = "_blank"; a.rel = "noopener"; }
      if (onTime) a.addEventListener("click", (e) => { e.preventDefault(); onTime(t); });
    });
    return root;
  }

  // Minimal, safe markdown -> DOM. Escapes HTML first, then converts a small subset.
  function renderMarkdown(md, opts) {
    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const lines = md.split("\n");
    let html = "", inList = null, inCode = false;
    const closeList = () => { if (inList) { html += `</${inList}>`; inList = null; } };
    const inline = (s) =>
      esc(s)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, '<a class="yta-ts" data-t="$1" href="#">$1</a>')
        .replace(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b(?![^<]*<\/a>)/g, (m0, t) => `<a class="yta-ts" data-t="${t}" href="#">${t}</a>`);

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      if (line.startsWith("```")) { closeList(); inCode = !inCode; html += inCode ? "<pre>" : "</pre>"; continue; }
      if (inCode) { html += esc(line) + "\n"; continue; }
      let m;
      if ((m = line.match(/^(#{1,4})\s+(.*)/))) { closeList(); const lvl = Math.min(4, m[1].length + 2); html += `<h${lvl}>${inline(m[2])}</h${lvl}>`; continue; }
      if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (inList !== "ul") { closeList(); inList = "ul"; html += "<ul>"; } html += `<li>${inline(m[1])}</li>`; continue; }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (inList !== "ol") { closeList(); inList = "ol"; html += "<ol>"; } html += `<li>${inline(m[1])}</li>`; continue; }
      if (!line.trim()) { closeList(); continue; }
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
    closeList();
    if (inCode) html += "</pre>";
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    return wireTimes(wrap, opts);
  }

  // ---------- Mind maps ----------
  // {topic, branches: [{label, t?, points: [{label, t?}]}]} from the model's JSON, cleaned and capped.
  function parseMindMap(text, dur = Infinity) {
    let raw;
    try { raw = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0]); } catch { return null; }
    const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").replace(/\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?/g, "").trim().slice(0, max);
    const time = (v) => { const t = toSeconds(v); return Number.isFinite(t) && t >= 0 && t < dur ? { t } : {}; };
    const topic = clean(raw?.topic, 60);
    const branches = (Array.isArray(raw?.branches) ? raw.branches : []).map((b) => ({
      label: clean(b?.label, 50), ...time(b?.time),
      points: (Array.isArray(b?.points) ? b.points : []).map((p) => ({ label: clean(typeof p === "string" ? p : p?.label, 70), ...time(p?.time) }))
        .filter((p) => p.label).slice(0, 5)
    })).filter((b) => b.label).slice(0, 7);
    return topic && branches.length >= 2 ? { topic, branches } : null;
  }

  // Text version, for Copy and so follow-up questions can refer to the map.
  function mindMapMarkdown(map) {
    return [`**Mind map: ${map.topic}**`, "", ...map.branches.flatMap((b) => [
      `- **${b.label}**${b.t != null ? ` [${fmtTime(b.t)}]` : ""}`,
      ...b.points.map((p) => `  - ${p.label}${p.t != null ? ` [${fmtTime(p.t)}]` : ""}`)
    ])].join("\n");
  }

  // A left-to-right tree: topic, then branches, then points, joined by connector lines (CSS); each branch
  // gets its own colour. Points with a time are timestamp links (see wireTimes).
  function renderMindMap(map, opts) {
    const node = (label, t, cls) => {
      const n = el("div", { class: `yta-mm-node ${cls}` }, el("span", { text: label }));
      if (t != null) n.append(el("a", { class: "yta-ts", "data-t": fmtTime(t), href: "#", text: fmtTime(t) }));
      return n;
    };
    const root = el("div", { class: "yta-mm", role: "tree", "aria-label": `Mind map: ${map.topic}` },
      node(map.topic, null, "yta-mm-topic"),
      el("div", { class: "yta-mm-kids" }, ...map.branches.map((b, i) => el("div", { class: "yta-mm-branch", style: `--mm:var(--mm-${i % 6})`, role: "treeitem" },
        node(b.label, b.t, "yta-mm-main"),
        b.points.length ? el("div", { class: "yta-mm-kids" }, ...b.points.map((p) => el("div", { class: "yta-mm-branch", role: "treeitem" }, node(p.label, p.t, "yta-mm-leaf")))) : null))));
    return wireTimes(root, opts);
  }

  // One card per line, term and definition separated by a tab: the default format of Quizlet's import,
  // and of Anki's text import. Each answer ends with a link back to the moment it's explained.
  function cardsText(cards, videoId) {
    return cards.map((c) => {
      const link = c.t != null ? ` (video at ${fmtTime(c.t)}: youtu.be/${videoId}?t=${Math.floor(c.t)})` : "";
      return `${c.front}\t${c.back}${link}`;
    }).join("\n");
  }

  globalThis.StudyPal = { cardsText, el, fmtTime, parseTime, toSeconds, watchUrl, icon, renderMarkdown, parseMindMap, mindMapMarkdown, renderMindMap };
})();
