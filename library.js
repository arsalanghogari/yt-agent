// Study Pal library: every video studied (from the panel's saved history in chrome.storage), with its notes,
// mind map, flashcards, quiz and chat; search; Save as PDF, Anki/Quizlet export, and shareable study packs.

(() => {
  const { el, icon, fmtTime, watchUrl, renderMarkdown, renderMindMap, cardsText } = globalThis.StudyPal;
  const $ = (id) => document.getElementById(id);
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const syncDark = () => document.documentElement.classList.toggle("sp-dark", dark.matches); // for mindmap.css
  syncDark();
  dark.addEventListener("change", syncDark);

  $("logo").append(icon("library", 18));
  $("settings").append(icon("gear", 20));
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

  let videos = [], selected = null, tab = null;

  const toast = (text) => {
    const t = $("toast");
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
  };

  // ---------- Data ----------

  const lastWith = (list, key) => [...(list || [])].reverse().find((m) => m[key]);

  function toVideo(id, saved, meta, deck) {
    const threads = Array.isArray(saved) ? { chat: saved } : saved || {}; // pre-2.0 saved one combined list
    const notes = lastWith(threads.notes, "notes");
    const map = lastWith(threads.notes, "map")?.map;
    const seen = new Set();
    const cards = (threads.cards || []).flatMap((m) => m.cards || [])
      .filter((c) => !seen.has(c.front.toLowerCase()) && seen.add(c.front.toLowerCase()));
    const quiz = lastWith(threads.quiz, "quiz")?.quiz;
    const chat = threads.chat || [];
    const fallbackTitle = deck.find((c) => c.videoId === id)?.videoTitle;
    return {
      id, threads, notes, map, cards, quiz, chat,
      title: meta?.title || fallbackTitle || "Untitled video", author: meta?.author || "", updated: meta?.updated || 0,
      search: JSON.stringify([meta?.title, meta?.author, threads]).toLowerCase()
    };
  }

  async function load() {
    const all = await chrome.storage.local.get(null);
    const deck = all.studyDeck || [];
    videos = Object.keys(all).filter((k) => k.startsWith("chat:"))
      .map((k) => toVideo(k.slice(5), all[k], all[`video:${k.slice(5)}`], deck))
      .filter((v) => v.notes || v.map || v.cards.length || v.quiz || v.chat.length)
      .sort((a, b) => b.updated - a.updated);
    const due = deck.filter((c) => c.due <= Date.now()).length;
    $("due").replaceChildren(...(due ? [el("strong", { text: `${due} card${due === 1 ? "" : "s"} due` }), " · review them from the panel on any video"] : []));
    const wanted = location.hash.slice(1);
    selected = videos.find((v) => v.id === wanted) || videos.find((v) => v.id === selected?.id) || videos[0] || null;
    render();
  }

  // ---------- List ----------

  function render() {
    const q = $("search").value.trim().toLowerCase();
    const shown = videos.filter((v) => !q || v.search.includes(q));
    $("empty").hidden = videos.length > 0;
    $("layout").hidden = videos.length === 0;
    $("list").replaceChildren(
      el("p", { class: "list-head", text: q ? `${shown.length} of ${videos.length} videos` : `${videos.length} video${videos.length === 1 ? "" : "s"} studied` }),
      ...shown.map((v) => {
        const tags = [v.notes && "Notes", v.map && "Mind map", v.cards.length && `${v.cards.length} cards`, v.quiz && "Quiz", v.chat.length && "Chat"].filter(Boolean);
        return el("button", { class: "video", "aria-current": String(v === selected), onclick: () => select(v) },
          el("span", { class: "thumb", style: `background-image:url("https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg")` }),
          el("span", {},
            el("p", { class: "video-title", text: v.title }),
            el("p", { class: "video-meta", text: [v.author, v.updated && new Date(v.updated).toLocaleDateString(undefined, { month: "short", day: "numeric" })].filter(Boolean).join(" · ") }),
            el("span", { class: "tags" }, ...tags.map((t) => el("span", { class: "tag", text: t })))));
      }));
    renderDetail();
  }

  function select(v) {
    selected = v;
    tab = null;
    history.replaceState(null, "", `#${v.id}`);
    render();
    $("detail").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ---------- Detail ----------

  function renderDetail() {
    const v = selected;
    const d = $("detail");
    if (!v) { d.replaceChildren(); return; }
    const tabs = [
      ["notes", "Notes", "notes", v.notes], ["map", "Mind map", "map", v.map], ["cards", "Flashcards", "cards", v.cards.length],
      ["quiz", "Quiz", "quiz", v.quiz], ["chat", "Chat", "chat", v.chat.length]
    ].filter((t) => t[3]);
    if (!tabs.some((t) => t[0] === tab)) tab = tabs[0]?.[0];

    d.replaceChildren(
      el("h1", { text: v.title }),
      el("p", { class: "sub", text: [v.author, v.updated && `Last studied ${new Date(v.updated).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}`].filter(Boolean).join(" · ") }),
      el("div", { class: "actions" },
        el("a", { class: "btn primary", href: watchUrl(v.id), target: "_blank", rel: "noopener" }, icon("play", 15), "Open video"),
        el("button", { class: "btn", onclick: () => sharePack(v), title: "Download one file with the notes, mind map, flashcards and quiz. Anyone can open it in a browser." }, icon("share", 16), "Share study pack"),
        el("button", { class: "btn danger", onclick: () => remove(v) }, icon("trash", 16), "Delete")),
      el("div", { class: "tabs", role: "tablist" }, ...tabs.map(([id, label, ico]) =>
        el("button", { class: "tab", role: "tab", "aria-selected": String(id === tab), onclick: () => { tab = id; renderDetail(); } }, icon(ico, 16), label))),
      pane(v, tab));
  }

  function pane(v, which) {
    const opts = { videoId: v.id };
    if (which === "notes") {
      return el("div", { class: "pane" }, renderMarkdown(v.notes.content, opts),
        el("div", { class: "pane-actions" }, el("button", { class: "btn", onclick: () => notesPdf(v) }, icon("notes", 16), "Save as PDF")));
    }
    if (which === "map") return el("div", { class: "pane wide" }, renderMindMap(v.map, opts));
    if (which === "cards") {
      return el("div", { class: "pane wide" }, el("div", { class: "cards" }, ...v.cards.map(cardEl)),
        el("div", { class: "pane-actions" },
          el("button", { class: "btn", onclick: () => copy(cardsText(v.cards, v.id), "Copied. In Quizlet: Create a set, click Import, paste.") }, "Copy for Quizlet"),
          el("button", { class: "btn", onclick: () => download(`${safeName(v.title)} flashcards.txt`, `#separator:tab\n#html:false\n${cardsText(v.cards, v.id)}\n`, "text/plain") }, "Download for Anki")));
    }
    if (which === "quiz") return el("div", { class: "pane" }, quizEl(v.quiz));
    if (which === "chat") {
      return el("div", { class: "pane chat" }, ...v.chat.map((m) => m.role === "user"
        ? el("div", { class: "msg user" }, el("p", { text: m.label || m.content }))
        : el("div", { class: "msg ai" }, renderMarkdown(m.content, opts))));
    }
    return el("div");
  }

  // Shared by the detail view and study packs (which have no scripts): reveal with <details>.
  function cardEl(c) {
    return el("details", { class: "card" }, el("summary", { text: c.front }),
      el("div", {}, el("p", { text: c.back }), c.t != null ? el("a", { class: "yta-ts", href: watchUrl(selected?.id, c.t), target: "_blank", rel: "noopener", text: fmtTime(c.t) }) : null));
  }

  function quizEl(quiz) {
    return el("ol", { class: "quiz" }, ...quiz.map((q) => el("li", {},
      el("p", { text: q.question }),
      el("ol", { type: "A" }, ...q.choices.map((c) => el("li", { text: c }))),
      el("details", {}, el("summary", { text: "Show answer" }),
        el("p", { text: `${String.fromCharCode(65 + q.answer)}. ${q.choices[q.answer]}. ${q.explanation || ""}`.trim() })))));
  }

  // ---------- Actions ----------

  const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Study Pal";

  function download(name, text, type) {
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function copy(text, done) {
    try { await navigator.clipboard.writeText(text); toast(done); } catch { toast("Couldn't copy to the clipboard."); }
  }

  async function notesPdf(v) {
    await chrome.storage.local.set({ notesPdf: {
      title: v.title, channel: v.author, url: watchUrl(v.id), at: Date.now(),
      html: renderMarkdown(v.notes.content, { videoId: v.id }).innerHTML
    } });
    chrome.tabs.create({ url: chrome.runtime.getURL("notes.html") });
  }

  async function remove(v) {
    const { studyDeck = [] } = await chrome.storage.local.get("studyDeck");
    const cards = studyDeck.filter((c) => c.videoId === v.id).length;
    if (!confirm(`Delete "${v.title}" from your library?${cards ? ` Its ${cards} flashcard${cards === 1 ? "" : "s"} will also leave your daily review.` : ""}`)) return;
    await chrome.storage.local.remove([`chat:${v.id}`, `video:${v.id}`]);
    if (cards) await chrome.storage.local.set({ studyDeck: studyDeck.filter((c) => c.videoId !== v.id) });
    selected = null;
    history.replaceState(null, "", location.pathname);
    toast("Deleted.");
    load();
  }

  // A study pack: one self-contained HTML file (no scripts) with everything for this video. Anyone can open
  // it in a browser without the extension, so it can be shared by email, chat or a drive.
  async function sharePack(v) {
    const mindmapCss = await (await fetch("mindmap.css")).text();
    const opts = { videoId: v.id };
    const section = (title, ...body) => el("section", {}, el("h2", { text: title }), ...body);
    const doc = el("main", {},
      el("header", {},
        el("p", { class: "kind", text: "Study pack" }),
        el("h1", { text: v.title }),
        el("p", { class: "meta" }, v.author ? `${v.author} · ` : "", el("a", { href: watchUrl(v.id), text: "Watch the video" }))),
      v.notes ? section("Notes", renderMarkdown(v.notes.content, opts)) : null,
      v.map ? section("Mind map", el("div", { class: "map" }, renderMindMap(v.map, opts))) : null,
      v.cards.length ? section(`Flashcards (${v.cards.length})`, el("p", { class: "hint", text: "Click a card to see the answer." }), el("div", { class: "cards" }, ...v.cards.map(cardEl))) : null,
      v.quiz ? section(`Quiz (${v.quiz.length} questions)`, quizEl(v.quiz)) : null,
      el("footer", { text: "Made with Study Pal for YouTube" }));
    doc.querySelectorAll("a.yta-ts").forEach((a) => a.removeAttribute("data-t"));
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(v.title)} - study pack</title>
<style>
body{margin:0;background:#f6f6f8;color:#111114;font:16px/1.6 Roboto,"Helvetica Neue",Arial,sans-serif}
main{max-width:860px;margin:32px auto;padding:48px 56px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
@media(max-width:700px){main{margin:0;padding:28px 20px;border-radius:0}}
header{padding-bottom:18px;margin-bottom:8px;border-bottom:2px solid #111114}
.kind{margin:0 0 6px;color:#e62117;font-weight:700;font-size:13px}
h1{margin:0 0 6px;font-size:28px;line-height:1.25;letter-spacing:-.015em}
.meta{margin:0;color:#5d5d64;font-size:14px}.meta a{color:#065fd4}
h2{margin:36px 0 12px;font-size:20px}h3,h4{margin:22px 0 8px;font-size:17px}
p,li{color:#3a3a40}strong{color:#111114}ul,ol{padding-left:22px}
a.yta-ts{display:inline-flex;padding:0 7px;border-radius:10px;background:rgba(6,95,212,.09);color:#065fd4;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap}
.map{overflow-x:auto;padding-bottom:8px}
.hint{color:#5d5d64;font-size:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
details.card{border:1px solid #e2e2e7;border-radius:12px;background:#f6f6f8}
details.card summary{padding:14px 16px;font-weight:650;cursor:pointer;list-style:none}
details.card summary::-webkit-details-marker{display:none}
details.card[open]{background:rgba(230,33,23,.08);border-color:transparent}
details.card>div{padding:0 16px 14px;font-size:15px}
.quiz>li{margin-bottom:18px}.quiz>li>p{margin:0 0 6px;color:#111114;font-weight:650}
.quiz details summary{color:#065fd4;font-weight:600;cursor:pointer}
footer{margin-top:40px;padding-top:14px;border-top:1px solid #e2e2e7;color:#5d5d64;font-size:13px}
${mindmapCss}
</style></head><body>${doc.outerHTML}</body></html>`;
    download(`${safeName(v.title)} - study pack.html`, html, "text/html");
    toast("Study pack downloaded. Send the file to anyone; it opens in any browser.");
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ---------- Start ----------

  $("search").addEventListener("input", render);
  addEventListener("hashchange", load);
  chrome.storage.onChanged.addListener(() => { clearTimeout(load.timer); load.timer = setTimeout(load, 300); });
  load();
})();
