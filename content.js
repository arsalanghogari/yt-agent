// Content script: injects the agent panel under the YouTube player,
// pulls the transcript, and talks to the background worker.

(() => {
  if (window.__ytAgentLoaded) return;
  window.__ytAgentLoaded = true;

  const PANEL_ID = "yta-panel";
  const MAX_TRANSCRIPT_CHARS = 120000;

  // Per-video state
  let state = null;

  // ---------- Utilities ----------

  const $ = (sel, root = document) => root.querySelector(sel);

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

  function getVideoId() {
    const u = new URL(location.href);
    if (u.pathname === "/watch") return u.searchParams.get("v");
    const m = u.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/);
    return m ? m[1] : null;
  }

  function seekTo(sec) {
    const v = $("video");
    if (v) { v.currentTime = sec; v.play?.(); }
  }

  function decodeEntities(s) {
    const t = document.createElement("textarea");
    t.innerHTML = s;
    return t.value;
  }

  // ---------- Transcript ----------

  async function fetchVideoData(videoId) {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { credentials: "include" });
    const html = await res.text();

    let player = null;
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s+meta|<\/script>|\n)/s);
    if (m) { try { player = JSON.parse(m[1]); } catch {} }

    const details = player?.videoDetails || {};
    const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

    // Fallback regex if JSON parsing of the whole blob failed
    let tracksFallback = [];
    if (!tracks.length) {
      const cm = html.match(/"captionTracks":(\[.*?\])/s);
      if (cm) { try { tracksFallback = JSON.parse(cm[1]); } catch {} }
    }

    return {
      title: details.title || document.title.replace(/ - YouTube$/, ""),
      author: details.author || "",
      description: details.shortDescription || "",
      keywords: details.keywords || [],
      lengthSeconds: Number(details.lengthSeconds) || 0,
      tracks: tracks.length ? tracks : tracksFallback
    };
  }

  function pickTrack(tracks) {
    if (!tracks.length) return null;
    // English first; otherwise the language actually spoken (the auto-caption track's language)
    // beats an uploaded translation into some other language.
    const manual = (t) => t.kind !== "asr";
    const asr = tracks.find((t) => t.kind === "asr");
    return tracks.find((t) => t.languageCode?.startsWith("en") && manual(t))
      || tracks.find((t) => t.languageCode?.startsWith("en"))
      || (asr && tracks.find((t) => manual(t) && t.languageCode === asr.languageCode))
      || asr || tracks.find(manual) || tracks[0];
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs) {
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(500)) {
      const v = fn();
      if (v) return v;
    }
    return null;
  }

  // YouTube now signs caption URLs with a proof-of-origin token (exp=xpe -> pot=...) that only the
  // player generates; unsigned requests return an empty body. So we toggle CC, let the player request
  // its own signed URL, and pick that URL up from the resource-timing timeline.
  async function captureCaptionUrl(videoId) {
    const btn = await waitFor(() => !$(".ad-showing") && $("video")?.readyState >= 2 && $(".ytp-subtitles-button"), 60000);
    if (!btn) throw new Error("the player was not ready (an ad may still be playing)");
    if (btn.getAttribute("aria-disabled") === "true" || getComputedStyle(btn).display === "none") {
      throw new Error("this video has no closed captions");
    }
    const isOurs = (u) => u.includes("/api/timedtext") && u.includes(`v=${videoId}`) && /[?&]pot=/.test(u);
    const ccOn = () => btn.getAttribute("aria-pressed") === "true";
    const wasOn = ccOn();
    let hit = null;
    // An observer, not getEntries(): YouTube clears the resource buffer regularly.
    const obs = new PerformanceObserver((list) => { hit ||= list.getEntries().find((e) => isOurs(e.name))?.name; });
    obs.observe({ type: "resource", buffered: true });
    // Turning CC on (or off and on again) makes the player fetch. It sometimes ignores the
    // first toggle while still initialising, so retry a few times.
    for (let i = 0; i < 3 && !hit; i++) {
      if (ccOn()) { btn.click(); await sleep(300); }
      btn.click();
      await waitFor(() => hit, 3000);
    }
    obs.disconnect();
    if (ccOn() !== wasOn) btn.click(); // leave CC the way the viewer had it
    if (!hit) throw new Error("the captions did not load after turning CC on");
    return hit;
  }

  async function fetchTrack(trackUrl) {
    // Try json3 first, then plain XML.
    const base = trackUrl.replace(/&fmt=[^&]*/, "");
    try {
      const r = await fetch(base + "&fmt=json3", { credentials: "include" });
      const txt = await r.text();
      if (txt.trim()) {
        const j = JSON.parse(txt);
        const segs = [];
        for (const ev of j.events || []) {
          if (!ev.segs) continue;
          const text = ev.segs.map((s) => s.utf8).join("").replace(/\s+/g, " ").trim();
          if (text) segs.push({ t: (ev.tStartMs || 0) / 1000, text });
        }
        if (segs.length) return segs;
      }
    } catch {}
    try {
      const r = await fetch(base, { credentials: "include" });
      const xml = await r.text();
      const segs = [];
      const re = /<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
      let mm;
      while ((mm = re.exec(xml))) {
        const text = decodeEntities(mm[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
        if (text) segs.push({ t: parseFloat(mm[1]), text });
      }
      if (segs.length) return segs;
    } catch {}
    return null;
  }

  function segmentsToText(segs) {
    // Merge into ~20-second blocks so the model sees fewer, denser timestamps.
    const blocks = [];
    let cur = null;
    for (const s of segs) {
      if (!cur || s.t - cur.t >= 20) {
        cur = { t: s.t, parts: [] };
        blocks.push(cur);
      }
      cur.parts.push(s.text);
    }
    let out = blocks.map((b) => `[${fmtTime(b.t)}] ${b.parts.join(" ")}`).join("\n");
    if (out.length > MAX_TRANSCRIPT_CHARS) {
      // Keep the whole video represented: drop every other line until it fits.
      let lines = out.split("\n");
      while (lines.join("\n").length > MAX_TRANSCRIPT_CHARS && lines.length > 50) {
        lines = lines.filter((_, i) => i % 2 === 0 || i === lines.length - 1);
      }
      out = lines.join("\n") + "\n\n(Transcript was thinned to fit the model's context; roughly every other block is shown.)";
    }
    return out;
  }

  async function loadVideoContext(videoId) {
    const data = await fetchVideoData(videoId);
    const track = pickTrack(data.tracks);
    let transcript = null, transcriptLang = null, transcriptError = null, autoCaptions = false;
    let segs = track ? await fetchTrack(track.baseUrl) : null;
    if (!segs) {
      try {
        const url = new URL(await captureCaptionUrl(videoId));
        // The signed URL is for whatever track the viewer's player has selected (possibly an
        // auto-translation). The signature still works with another track, so ask for ours.
        url.searchParams.delete("tlang");
        if (track) {
          url.searchParams.set("lang", track.languageCode);
          if (track.kind) url.searchParams.set("kind", track.kind);
          else url.searchParams.delete("kind");
        }
        segs = await fetchTrack(url.href);
        if (!segs) transcriptError = "the closed captions came back empty";
        else if (!track) {
          transcriptLang = url.searchParams.get("lang");
          autoCaptions = url.searchParams.get("kind") === "asr";
        }
      } catch (e) {
        transcriptError = e.message;
      }
    }
    if (segs && track) {
      transcriptLang = track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode;
      autoCaptions = track.kind === "asr";
    }
    if (segs) transcript = segmentsToText(segs);
    return { ...data, transcript, transcriptLang, transcriptError, autoCaptions };
  }

  // ---------- Prompting ----------

  function buildSystem(ctx, cfgLang) {
    const meta = [
      `Title: ${ctx.title}`,
      ctx.author ? `Channel: ${ctx.author}` : null,
      ctx.lengthSeconds ? `Duration: ${fmtTime(ctx.lengthSeconds)}` : null,
      ctx.keywords.length ? `Tags: ${ctx.keywords.join(", ")}` : null
    ].filter(Boolean).join("\n");

    // The description goes in every time: it often has chapters, links, and the correct
    // spelling of names and products that auto-captions mangle.
    const description = ctx.description ? `DESCRIPTION (written by the uploader):\n${ctx.description.slice(0, 6000)}` : "";

    const content = ctx.transcript
      ? `TRANSCRIPT (${ctx.autoCaptions ? "auto-generated captions: expect misheard words, especially names, products and jargon" : "captions"}; each line starts with its timestamp):\n${ctx.transcript}`
      : `No transcript could be read (${ctx.transcriptError || "unknown reason"}). Work only from the title and description, and say clearly that you could not access the spoken content.`;

    return `You are an AI agent embedded in a YouTube page, helping the viewer with the video that is currently open.

VIDEO
${meta}

${description}

${content}

RULES
- Ground everything in the video content. If something is not covered in the video, say so instead of guessing.
- When a caption word looks misheard, use the title, tags, description, and your own knowledge to work out what was actually said, and write the corrected term. If you are not sure of the correction, keep the caption wording and note the likely intended term in parentheses.
- Whenever you reference a specific moment, cite its timestamp in square brackets like [4:32] or [1:02:15]. The viewer can click these to jump there, so use them generously and place them right after the claim they support.
- Answer in ${cfgLang || "English"}.
- Use light markdown: short headers, bullet lists, bold for key terms. No tables.
- Be direct and skip filler. Do not open with restating the request.`;
  }

  function buildTask(mode, fields) {
    if (mode === "summarize") {
      return [
        "Summarize this video so I do not have to watch it.",
        "Structure: a 2-3 sentence TL;DR, then the key points in order (each with a timestamp), then any notable details, numbers, names, or recommendations. End with one line on who this video is actually useful for.",
        fields.focus ? `Pay special attention to: ${fields.focus}` : null
      ].filter(Boolean).join("\n");
    }
    if (mode === "explain") {
      const framing = fields.framing || "a curious beginner with no background in this topic";
      return [
        "Explain what this video teaches so I truly understand it, not just what it says.",
        `Here is how I want it framed: ${framing}.`,
        "Build the explanation around analogies from that world. For each core idea: state it plainly, give the analogy, then say exactly where the analogy maps and where it breaks. Avoid jargon unless you define it right away. Include timestamps for where each idea appears in the video.",
        "Finish with a section called 'The gist' that is one or two sentences I could repeat to a friend."
      ].join("\n");
    }
    // ask
    const persona = fields.persona || "a knowledgeable expert in whatever this video is about";
    const q = fields.question?.trim();
    return [
      `Take on the perspective of ${persona}. Analyze this video the way that person would, noticing things a casual viewer would miss.`,
      q
        ? `My question: ${q}`
        : "I have no specific question: give me the commentary this expert would offer, pointing to specific moments with timestamps, including what is done well, what is weak or risky, and what to listen or look for on a rewatch."
    ].join("\n");
  }

  // Streams a reply: onDelta(fullTextSoFar) as chunks arrive; resolves like {ok, text} / {ok:false, error}.
  function sendChat(system, messages, onDelta) {
    messages = messages.map(({ role, content }) => ({ role, content })); // drop display labels
    return new Promise((resolve) => {
      const port = chrome.runtime.connect({ name: "chat-stream" });
      let text = "", settled = false;
      const finish = (r) => { if (!settled) { settled = true; port.disconnect(); resolve(r); } };
      port.onMessage.addListener((m) => {
        if (m.delta) { text += m.delta; onDelta(text); }
        else if (m.done) finish({ ok: true, text: m.text });
        else if (m.error) finish({ ok: false, error: m.error, partial: text });
      });
      port.onDisconnect.addListener(() => finish({ ok: false, error: "Connection to the extension was lost.", partial: text }));
      port.postMessage({ system, messages });
    });
  }

  // ---------- Rendering ----------

  function renderMarkdown(md) {
    // Minimal, safe markdown -> DOM. Escapes HTML first, then converts a small subset.
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
    wrap.querySelectorAll("a.yta-ts").forEach((a) =>
      a.addEventListener("click", (e) => { e.preventDefault(); seekTo(parseTime(a.dataset.t)); })
    );
    return wrap;
  }

  function addMessage(role, content, { pending = false } = {}) {
    const thread = $("#yta-thread");
    const msg = el("div", { class: `yta-msg yta-${role}` });
    if (pending) {
      msg.classList.add("yta-pending");
      msg.append(el("span", { class: "yta-dots" }, el("i"), el("i"), el("i")));
    } else if (role === "assistant") {
      fillAssistant(msg, content);
    } else {
      msg.append(el("p", { text: content }));
    }
    thread.append(msg);
    thread.scrollTop = thread.scrollHeight;
    return msg;
  }

  function fillAssistant(msg, content, { streaming = false } = {}) {
    msg.classList.remove("yta-pending");
    msg.replaceChildren(renderMarkdown(content));
    if (streaming) return;
    const tools = el("div", { class: "yta-tools" });
    tools.append(el("button", { class: "yta-mini", text: "Copy", onclick: () => navigator.clipboard.writeText(content) }));
    msg.append(tools);
  }

  // After the extension is reloaded or updated, this copy of the script keeps running in open tabs
  // but every chrome.* call throws "Extension context invalidated". Check before touching chrome.*.
  function alive() {
    if (chrome.runtime?.id) return true;
    setStatus("Extension was updated. Refresh this page to keep using it.", "yta-err");
    return false;
  }

  function setStatus(text, kind = "") {
    const s = $("#yta-status");
    if (!s) return;
    s.textContent = text;
    s.className = "yta-status " + kind;
  }

  // ---------- Panel ----------

  function buildPanel() {
    const panel = el("div", { id: PANEL_ID });

    const header = el("div", { class: "yta-header" },
      el("div", { class: "yta-brand" }, el("span", { class: "yta-logo", text: "▶" }), el("span", { text: "AI Agent" })),
      el("span", { id: "yta-status", class: "yta-status" }),
      el("div", { class: "yta-header-actions" },
        el("button", { class: "yta-icon", title: "Clear this video's chat", text: "🗑", onclick: clearHistory }),
        el("button", { class: "yta-icon", title: "Settings", text: "⚙", onclick: () => alive() && chrome.runtime.sendMessage({ type: "openOptions" }) }),
        el("button", { class: "yta-icon", id: "yta-toggle", title: "Expand / collapse", text: "▾", onclick: () => panel.classList.toggle("yta-collapsed") })
      )
    );
    header.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      panel.classList.toggle("yta-collapsed");
    });

    const tabs = el("div", { class: "yta-tabs", role: "tablist" });
    const modes = [
      ["summarize", "Summarize", "Skip the video, get the info"],
      ["explain", "Explain", "Understand it with your analogies"],
      ["ask", "Ask an expert", "Commentary through a lens you pick"]
    ];
    for (const [id, label, sub] of modes) {
      tabs.append(el("button", { class: "yta-tab", "data-mode": id, onclick: () => setMode(id) },
        el("span", { class: "yta-tab-label", text: label }),
        el("span", { class: "yta-tab-sub", text: sub })));
    }

    const form = el("div", { class: "yta-form" });
    form.append(
      // summarize
      el("div", { class: "yta-fields", "data-mode": "summarize" },
        el("input", { id: "yta-focus", placeholder: "Optional: anything specific you want out of it? (e.g. just the pricing part)" })),
      // explain
      el("div", { class: "yta-fields", "data-mode": "explain" },
        el("input", { id: "yta-framing", placeholder: "Explain it like... (e.g. I'm a rock climber, use climbing analogies)" })),
      // ask
      el("div", { class: "yta-fields", "data-mode": "ask" },
        el("input", { id: "yta-persona", placeholder: "Expert lens (e.g. a vocal coach analyzing live performances)" }),
        el("input", { id: "yta-question", placeholder: "Optional question (e.g. how is she handling the belt in the chorus?)" })),
      el("div", { class: "yta-actions" },
        el("button", { id: "yta-run", class: "yta-primary", text: "Go", onclick: runMode }),
        el("span", { class: "yta-hint", id: "yta-hint" }))
    );

    form.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); runMode(); }
    });

    const thread = el("div", { id: "yta-thread", class: "yta-thread" });

    const followup = el("div", { class: "yta-followup" },
      el("input", { id: "yta-followup-input", placeholder: "Follow up..." }),
      el("button", { class: "yta-primary", text: "Send", onclick: sendFollowup })
    );
    followup.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendFollowup(); } });

    const body = el("div", { class: "yta-body" }, tabs, form, thread, followup);
    panel.append(header, body);
    return panel;
  }

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll("#yta-panel .yta-tab").forEach((t) => t.classList.toggle("yta-active", t.dataset.mode === mode));
    document.querySelectorAll("#yta-panel .yta-fields").forEach((f) => f.classList.toggle("yta-show", f.dataset.mode === mode));
    const hint = $("#yta-hint");
    hint.textContent = mode === "summarize" ? "Get the info without watching."
      : mode === "explain" ? "Blank = your default framing from settings."
      : "Blank = your default lens from settings.";
    const input = $(`#yta-panel .yta-fields[data-mode="${mode}"] input`);
    if (input && !$("#yta-panel").classList.contains("yta-collapsed")) input.focus();
  }

  async function ensureContext() {
    if (state.ctx) return state.ctx;
    if (state.ctxPromise) return state.ctxPromise;
    setStatus("Reading transcript...", "yta-busy");
    state.ctxPromise = loadVideoContext(state.videoId).then((ctx) => {
      if (ctx.transcript) {
        state.ctx = ctx;
        setStatus(`Transcript loaded${ctx.transcriptLang ? " (" + ctx.transcriptLang + ")" : ""}`, "yta-ok");
      } else {
        state.ctxPromise = null; // retry on the next request (e.g. an ad was playing)
        setStatus(`No transcript: ${ctx.transcriptError}. Using title and description only`, "yta-warn");
      }
      return ctx;
    }).catch((e) => {
      state.ctxPromise = null;
      setStatus("Could not read video data", "yta-err");
      throw e;
    });
    return state.ctxPromise;
  }

  async function runMode() {
    if (!alive()) return;
    if (state.busy) return;
    const mode = state.mode;
    const cfg = await chrome.storage.local.get(["analogyDomain", "persona", "language"]);
    const fields = {
      focus: $("#yta-focus").value.trim(),
      framing: $("#yta-framing").value.trim() || cfg.analogyDomain || "",
      persona: $("#yta-persona").value.trim() || cfg.persona || "",
      question: $("#yta-question").value.trim()
    };
    const task = buildTask(mode, fields);
    const label = mode === "summarize" ? "Summarize" + (fields.focus ? `: ${fields.focus}` : "")
      : mode === "explain" ? fields.framing ? `Explain: ${fields.framing}` : "Explain simply"
      : `Ask an expert: ${[fields.persona && `As ${fields.persona.replace(/^as\s+/i, "")}`, fields.question].filter(Boolean).join(", ") || "general commentary"}`;
    await ask(task, label, cfg.language);
  }

  async function sendFollowup() {
    if (!alive()) return;
    const input = $("#yta-followup-input");
    const q = input.value.trim();
    if (!q || state.busy) return;
    input.value = "";
    const cfg = await chrome.storage.local.get(["language"]);
    await ask(q, q, cfg.language);
  }

  async function ask(userContent, displayLabel, language) {
    const configured = await chrome.runtime.sendMessage({ type: "isConfigured" });
    if (!configured?.ok) {
      addMessage("assistant", "**Set up a model first.** Click the ⚙ icon and add an API key for Anthropic, OpenAI, Gemini, or a custom endpoint.");
      return;
    }
    state.busy = true;
    $("#yta-run").disabled = true;
    addMessage("user", displayLabel);
    const pending = addMessage("assistant", "", { pending: true });
    try {
      const ctx = await ensureContext();
      const system = buildSystem(ctx, language);
      state.messages.push({ role: "user", content: userContent, label: displayLabel });
      const thread = $("#yta-thread");
      let frame = 0, latest = "";
      const res = await sendChat(system, state.messages, (text) => {
        latest = text;
        // Re-render at most once per frame; only follow the bottom if the reader is already there.
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
          fillAssistant(pending, latest, { streaming: true });
          if (atBottom) thread.scrollTop = thread.scrollHeight;
        });
      });
      cancelAnimationFrame(frame);
      if (!res?.ok) {
        state.messages.pop();
        if (res?.partial) fillAssistant(pending, res.partial);
        else pending.remove();
        addMessage("assistant", `**Error:** ${res?.error || "unknown"}\n\nCheck your key and model in ⚙ settings.`);
      } else {
        state.messages.push({ role: "assistant", content: res.text });
        fillAssistant(pending, res.text);
        saveHistory();
        setStatus(`${configured.provider} · ${configured.model}`, "yta-ok");
      }
    } catch (e) {
      pending.remove();
      addMessage("assistant", `**Error:** ${e?.message || e}`);
    } finally {
      state.busy = false;
      $("#yta-run").disabled = false;
    }
  }

  // ---------- History ----------
  // ponytail: one key per video, never evicted; add LRU pruning if chrome.storage.local (10 MB) fills up.

  const historyKey = (videoId) => `chat:${videoId}`;

  function saveHistory() {
    chrome.storage.local.set({ [historyKey(state.videoId)]: state.messages });
  }

  async function restoreHistory(videoId) {
    if (!alive()) return;
    const saved = (await chrome.storage.local.get(historyKey(videoId)))[historyKey(videoId)];
    if (!saved?.length || state?.videoId !== videoId || state.messages.length) return;
    state.messages = saved;
    for (const m of saved) addMessage(m.role, m.role === "user" ? m.label || m.content : m.content);
  }

  function clearHistory() {
    if (!alive()) return;
    if (state.busy) return;
    state.messages = [];
    $("#yta-thread").innerHTML = "";
    chrome.storage.local.remove(historyKey(state.videoId));
  }

  // ---------- Mounting & navigation ----------

  function findMountPoint() {
    // Right-hand column (#secondary holds the related-videos list); we sit on top of it.
    // Fall back to under the player if the layout has no sidebar (theater mode / narrow window).
    const sec = $("#secondary-inner") || $("#secondary");
    if (sec && sec.offsetParent !== null) return sec;
    return $("#below") || $("ytd-watch-metadata")?.parentElement || null;
  }

  // Track the player's height so the panel (in the sidebar) ends exactly where the video does.
  const playerSize = new ResizeObserver(([entry]) => {
    document.getElementById(PANEL_ID)?.style.setProperty("--yta-player-h", `${entry.target.offsetHeight}px`);
  });

  let mountTimer = null;
  function mount() {
    const videoId = getVideoId();
    const existing = document.getElementById(PANEL_ID);
    if (!videoId) { existing?.remove(); state = null; return; }
    if (state && state.videoId === videoId && existing && existing.isConnected) return;

    existing?.remove();
    state = { videoId, mode: "summarize", ctx: null, ctxPromise: null, messages: [], busy: false };

    const tryMount = () => {
      const mp = findMountPoint();
      if (!mp) { mountTimer = setTimeout(tryMount, 500); return; }
      const panel = buildPanel();
      mp.prepend(panel);
      const player = $("#movie_player");
      if (player) {
        panel.style.setProperty("--yta-player-h", `${player.offsetHeight}px`);
        playerSize.observe(player);
      }
      setMode("summarize");
      setStatus("Ready");
      restoreHistory(videoId);
      // Warm the transcript in the background so the first request is fast.
      ensureContext().catch(() => {});
    };
    clearTimeout(mountTimer);
    tryMount();
  }

  // If the layout changes (theater mode, narrow window) and our column disappears, move the
  // existing panel to whichever mount point is visible, keeping the conversation intact.
  let relocateTimer = null;
  function relocate() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !state) return;
    const mp = findMountPoint();
    if (mp && panel.parentElement !== mp) mp.prepend(panel);
  }
  window.addEventListener("resize", () => { clearTimeout(relocateTimer); relocateTimer = setTimeout(relocate, 250); });
  document.addEventListener("yt-page-data-updated", () => setTimeout(relocate, 300));
  document.addEventListener("yt-navigate-finish", () => setTimeout(mount, 300));
  window.addEventListener("popstate", () => setTimeout(mount, 300));
  mount();
})();
