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
    const captions = player?.captions?.playerCaptionsTracklistRenderer;
    const tracks = captions?.captionTracks || [];
    // Videos with AI dubs list several audio tracks; the default one is the original ("en-US.4" -> "en").
    const audioId = captions?.audioTracks?.[captions.defaultAudioTrackIndex]?.audioTrackId;

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
      originalLang: audioId ? audioId.split(/[-.]/)[0] : null,
      lengthSeconds: Number(details.lengthSeconds) || 0,
      tracks: tracks.length ? tracks : tracksFallback
    };
  }

  const baseLang = (code) => (code || "").split("-")[0];

  function pickTrack(tracks, originalLang) {
    if (!tracks.length) return null;
    const manual = (t) => t.kind !== "asr";
    // Uploaded captions in that language, else auto-captions in it.
    const inLang = (l) => tracks.find((t) => baseLang(t.languageCode) === l && manual(t))
      || tracks.find((t) => baseLang(t.languageCode) === l);
    const asr = tracks.find((t) => !manual(t));
    // English, then the video's original language. AI-dubbed videos sometimes list only captions of
    // their dubs, so next take a Latin-script dub (names like "OpenAI" survive, unlike in e.g. Bangla).
    // Otherwise the spoken language (the auto-caption track's) beats an uploaded translation.
    return inLang("en")
      || (originalLang && (inLang(originalLang) || ["es", "fr", "de", "pt", "it", "nl"].map(inLang).find(Boolean)))
      || (asr && inLang(baseLang(asr.languageCode)))
      || tracks[0];
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
    // An observer, not getEntries(): YouTube clears the resource buffer regularly. Not buffered either:
    // the signed URL expires within a minute or two, so only take requests made after we ask.
    const obs = new PerformanceObserver((list) => { hit ||= list.getEntries().find((e) => isOurs(e.name))?.name; });
    obs.observe({ type: "resource" });
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
      const re = /<text start="([\d.]+)"(?:[^>]*?dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
      let mm;
      while ((mm = re.exec(xml))) {
        const text = decodeEntities(mm[3].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
        const t = parseFloat(mm[1]);
        if (text) segs.push({ t, end: t + (parseFloat(mm[2]) || 3), text });
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
    const track = pickTrack(data.tracks, data.originalLang);
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
    const transcriptLangCode = baseLang(track?.languageCode) || null;
    const fromDub = !!(segs && data.originalLang && transcriptLangCode && transcriptLangCode !== data.originalLang);
    return { ...data, transcript, transcriptLang, transcriptLangCode, transcriptError, autoCaptions, fromDub };
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
      ? `TRANSCRIPT (${ctx.autoCaptions ? "auto-generated captions: expect misheard words, especially names, products and jargon" : "captions"}; each line starts with its timestamp)${ctx.fromDub ? `\nNote: this video was made in "${ctx.originalLang}", but the only captions available are of a dubbed "${ctx.transcriptLangCode}" audio track. Treat it as a translation of what was said.` : ""}:\n${ctx.transcript}`
      : `No transcript could be read (${ctx.transcriptError || "unknown reason"}). Work only from the title and description, and say clearly that you could not access the spoken content.`;

    return `You are Study Pal, a tutor embedded in a YouTube page, helping a student learn from the video that is currently open.

VIDEO
${meta}

${description}

${content}

RULES
- Ground your answers in the video. If a question goes beyond it, you may answer from general knowledge, but say clearly which parts are not from the video.
- Teach, don't just answer: explain clearly at the student's level, define jargon when you first use it, and use a short example when it helps.
- When a caption word looks misheard, use the title, tags, description, and your own knowledge to work out what was actually said, and write the corrected term. If you are not sure of the correction, keep the caption wording and note the likely intended term in parentheses.
- Whenever you reference a specific moment, cite its timestamp in square brackets like [4:32] or [1:02:15]. The viewer can click these to jump there, so use them generously and place them right after the claim they support.
- Answer in ${cfgLang || "English"}.
- Use light markdown: short headers, bullet lists, bold for key terms. No tables.
- Be direct and skip filler. Do not open with restating the request.`;
  }

  function buildTask(mode, fields) {
    if (mode === "notes") {
      return [
        "Write study notes for this video that I can review instead of rewatching it.",
        "Use these sections: ## Overview (2-3 sentences on what the video teaches). ## Key ideas (the main ideas in the order they come, each as a bullet that explains the idea in a full sentence or two, with its timestamp). ## Key terms (each term in bold, then its definition as the video gives it). ## Examples (the examples, cases or numbers the video uses, with timestamps). ## Remember (the 3 to 5 most important takeaways).",
        "Be accurate and complete, but don't pad: leave out a section if the video has nothing for it."
      ].join("\n");
    }
    if (mode === "quiz") {
      return [
        `Write a multiple-choice quiz of ${fields.quizCount} questions that checks whether I understood this video.`,
        "Test understanding of the most important ideas across the whole video, not trivia: ask why and how, apply ideas to a new case, compare concepts. Mix easier and harder questions.",
        "Each question has 4 answer choices: one clearly correct, three plausible but wrong (common misconceptions, not obviously silly). Each question must make sense without the video.",
        "For each question give a 1-2 sentence explanation of why the right answer is right, and the timestamp where the video covers it. Do not put timestamps in the question, choices or explanation text.",
        'Reply with only a JSON array and no other text, like: [{"question":"Why does spacing reviews out help memory?","choices":["It forces effortful recall","It reduces study time","It avoids boredom","It improves reading speed"],"answer":0,"explanation":"Recalling after a gap takes effort, which strengthens the memory.","time":"4:32"}] where answer is the index of the correct choice.'
      ].join("\n");
    }
    // cards
    const style = fields.cardStyle === "qa"
      ? "a question on the front and its answer on the back"
      : "a key term or concept on the front and its definition or explanation on the back";
    return [
      `Make up to ${fields.cardCount} flashcards for studying what this video teaches, with ${style}.`,
      "Cover the most important, testable ideas across the whole video, not just the start. Fewer, better cards beat padding: never make two cards that test the same fact.",
      "Front: a clear, grammatical question or term with exactly one right answer, specific enough that it can't be answered with a generic statement.",
      "Back: the actual answer as the video explains it, in 1 to 3 sentences (up to about 50 words). Include the specifics the video gives, such as how or why it works, numbers, names, examples and comparisons, so the card teaches something rather than restating the question. Use only what the video says.",
      "Each card must make sense without the video. No trivia about the presenter, the channel or sponsors. Do not put timestamps or links in the card text.",
      "For each card give, separately, the timestamp where that idea is explained.",
      'Reply with only a JSON array and no other text, like: [{"front":"Spaced repetition","back":"Reviewing material at increasing intervals so it moves into long-term memory.","time":"4:32"}]'
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

  // ---------- Chrome built-in AI (Gemini Nano, runs on the user's computer) ----------
  // The default provider: free, no API key, and nothing leaves the device. Chrome only downloads the
  // model (several GB, once) right after a user click, so Go/Send call startBuiltin() before any await.

  // A provider picked in settings but missing its key, model or URL can't work, so the built-in AI is
  // used instead of asking the user to set something up. Same rule as effectiveProvider() in background.js.
  const effectiveProvider = (c) =>
    !c.provider || c.provider === "builtin" || !c.model || !(c.provider === "custom" ? c.baseUrl : c.apiKey)
      ? "builtin" : c.provider;

  // Read synchronously by the click handlers, so kept up to date here (the API key itself isn't kept).
  const prefs = { provider: "builtin", language: "English" };
  const loadPrefs = () => chrome.storage.local.get(["provider", "apiKey", "baseUrl", "model", "language"])
    .then((c) => Object.assign(prefs, { provider: effectiveProvider(c), language: c.language || "English" }));
  loadPrefs();
  chrome.storage.onChanged.addListener((changes) => {
    if (["provider", "apiKey", "baseUrl", "model", "language"].some((k) => k in changes)) loadPrefs();
  });

  // Languages the on-device model supports; anything else is answered in English.
  const BUILTIN_LANGS = { english: "en", spanish: "es", japanese: "ja", german: "de", french: "fr" };
  function builtinOptions(language) {
    const out = BUILTIN_LANGS[(language || "").trim().toLowerCase()] || "en";
    return {
      expectedInputs: [{ type: "text", languages: [...new Set(["en", out])] }],
      expectedOutputs: [{ type: "text", languages: [out] }]
    };
  }

  class BuiltinUnavailable extends Error {}

  // The user's answer language if this Chrome supports it on-device, otherwise English.
  async function resolveBuiltinOptions(language) {
    const opts = builtinOptions(language);
    if (opts.expectedOutputs[0].languages[0] === "en") return opts;
    return (await LanguageModel.availability(opts)) === "unavailable" ? builtinOptions("English") : opts;
  }

  // Must be called synchronously from a click handler. Resolves to the model options once it's ready.
  function startBuiltin(language) {
    if (typeof LanguageModel === "undefined") {
      return Promise.reject(new BuiltinUnavailable("this version of Chrome doesn't include it. Updating Chrome may add it"));
    }
    let opts;
    return resolveBuiltinOptions(language).then((o) => LanguageModel.create({
      ...(opts = o),
      monitor: (m) => m.addEventListener("downloadprogress", (e) =>
        setStatus(`Downloading Chrome's AI model (one time only)... ${Math.round(e.loaded * 100)}%`, "yta-busy"))
    })).then((s) => { s.destroy(); return opts; }, async (e) => {
      opts ||= builtinOptions("English");
      if ((await LanguageModel.availability(opts).catch(() => "unavailable")) === "unavailable") {
        throw new BuiltinUnavailable("this computer doesn't meet its requirements (22 GB of free disk space, plus a graphics card with more than 4 GB of memory or 16 GB of RAM)");
      }
      throw e;
    });
  }

  const CONDENSE_PROMPT = "You condense one part of a YouTube video transcript into dense notes. Each transcript line starts with a [m:ss] timestamp. Write one short line per distinct point, each starting with the timestamp where that point begins, in the same [m:ss] format. Keep names, numbers, claims, examples and recommendations. No introduction, headings or commentary.";

  // The on-device model has a small context window. If the transcript doesn't fit, condense it part by
  // part into timestamped notes first (cached on the video's context), then answer from the notes.
  async function fitForBuiltin(ctx, opts) {
    if (!ctx.transcript) return ctx;
    if (ctx.builtinTranscript) return { ...ctx, transcript: ctx.builtinTranscript };
    const probe = await LanguageModel.create(opts);
    try {
      const windowSize = probe.contextWindow ?? probe.inputQuota;
      const measure = (t) => (probe.measureContextUsage ?? probe.measureInputUsage).call(probe, t);
      const budget = windowSize * 0.5; // leave room for instructions, the conversation and the answer
      let transcript = ctx.transcript;
      for (let round = 0; round < 3; round++) {
        const tokens = await measure(transcript);
        if (tokens <= budget) break;
        // Split on line boundaries into parts that each fit comfortably in their own session.
        const maxChars = Math.floor(budget * 0.8 * (transcript.length / tokens));
        const parts = [];
        let cur = "";
        for (const line of transcript.split("\n")) {
          if (cur && cur.length + line.length > maxChars) { parts.push(cur); cur = ""; }
          cur += (cur ? "\n" : "") + line.slice(0, maxChars);
        }
        if (cur) parts.push(cur);
        const notes = [];
        for (const [i, part] of parts.entries()) {
          setStatus(`Reading the video with on-device AI... part ${i + 1} of ${parts.length}`, "yta-busy");
          const s = await LanguageModel.create({ ...opts, initialPrompts: [{ role: "system", content: CONDENSE_PROMPT }] });
          try { notes.push((await s.prompt(part)).trim()); } finally { s.destroy(); }
        }
        transcript = notes.join("\n");
      }
      if (transcript !== ctx.transcript) {
        transcript = `(Condensed notes of the transcript, made so it fits the on-device AI.)\n${transcript}`;
      }
      ctx.builtinTranscript = transcript;
      return { ...ctx, transcript };
    } finally {
      probe.destroy();
    }
  }

  async function builtinChat(ctx, language, messages, onDelta, opts) {
    opts ||= await resolveBuiltinOptions(language);
    if (opts.expectedOutputs[0].languages[0] === "en") language = "English"; // language not available on-device
    const system = buildSystem(await fitForBuiltin(ctx, opts), language);
    const history = messages.slice(0, -1).map(({ role, content }) => ({ role, content }));
    const session = await LanguageModel.create({ ...opts, initialPrompts: [{ role: "system", content: system }, ...history] });
    try {
      let text = "";
      for await (const chunk of session.promptStreaming(messages.at(-1).content)) {
        // Older Chrome versions streamed the whole answer so far; newer ones stream only the new part.
        text = text && chunk.startsWith(text) ? chunk : text + chunk;
        onDelta(text);
      }
      return text;
    } finally {
      session.destroy();
    }
  }

  function builtinError(e) {
    if (e instanceof BuiltinUnavailable) {
      return `**Chrome's built-in AI isn't available:** ${e.message}.\n\nClick ⚙ and pick an AI provider with your own API key instead. It takes about a minute.`;
    }
    if (e?.name === "QuotaExceededError") return "This conversation is too long for the on-device AI. Click 🗑 to start a fresh one.";
    if (e?.name === "NotAllowedError") return "Chrome needs a fresh click to start its AI model. Press Go again.";
    return `**Error:** ${e?.message || e}`;
  }

  // ---------- Icons ----------
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
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'
  };
  function icon(name, size = 18) {
    const span = el("span", { class: "yta-ico", "aria-hidden": "true" });
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
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

  function addMessage(role, content, { pending = false, cards = null, quiz = null } = {}) {
    const thread = $("#yta-thread");
    const msg = el("div", { class: `yta-msg yta-${role}` });
    if (pending) {
      msg.classList.add("yta-pending");
      msg.append(el("span", { class: "yta-dots" }, el("i"), el("i"), el("i")));
    } else if (role === "assistant") {
      fillAssistant(msg, content, { cards, quiz });
    } else {
      msg.append(el("p", { text: content }));
    }
    thread.append(msg);
    thread.scrollTop = thread.scrollHeight;
    return msg;
  }

  function fillAssistant(msg, content, { streaming = false, cards = null, quiz = null } = {}) {
    msg.classList.remove("yta-pending");
    msg.replaceChildren(quiz ? renderQuiz(quiz) : cards ? renderCards(cards) : renderMarkdown(content));
    if (streaming) return;
    if (cards) {
      msg.append(el("div", { class: "yta-card-actions" },
        el("button", { class: "yta-primary", text: "Send to Quizlet", title: "Opens Quizlet and fills in a new set for you to check and create", onclick: () => sendToQuizlet(cards) }),
        el("button", { class: "yta-secondary", text: "Copy for Quizlet", onclick: () => copyForQuizlet(cards) }),
        el("button", { class: "yta-secondary", text: "Download for Anki", onclick: () => downloadForAnki(cards) })));
    }
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
    s.title = text; // the header truncates long messages
    s.className = "yta-status " + kind;
  }

  // ---------- Panel ----------

  // id, tab label, icon, intro title, intro text, action button label
  const MODES = [
    ["chat", "Chat", "chat", "Ask me anything about this video", "I'll answer from the video and point you to the exact moment. Try one of these:"],
    ["notes", "Notes", "notes", "Study notes in seconds", "The key ideas, terms and examples, so you can review without rewatching.", "Make study notes"],
    ["cards", "Flashcards", "cards", "Turn this video into flashcards", "They go into your daily review automatically, and you can send them to Quizlet or Anki.", "Make flashcards"],
    ["quiz", "Quiz", "quiz", "Check what stuck", "A quick multiple-choice quiz. Miss one and I'll show you the part to rewatch.", "Start the quiz"]
  ];
  const SUGGESTIONS = ["Explain the main idea simply", "What should I remember from this?", "Give me an example I can relate to"];

  function buildPanel() {
    const panel = el("div", { id: PANEL_ID });

    const logo = el("span", { class: "yta-logo" });
    logo.append(icon("chat", 15));
    const header = el("div", { class: "yta-header" },
      el("div", { class: "yta-brand" }, logo,
        el("div", { class: "yta-titles" },
          el("span", { class: "yta-name", text: "Study Pal" }),
          el("span", { id: "yta-status", class: "yta-status", "aria-live": "polite" }))),
      el("div", { class: "yta-header-actions" },
        el("button", { class: "yta-review-btn", id: "yta-review", title: "Review the flashcards that are due today", onclick: startReview },
          icon("review", 16), el("span", { text: "Review" }), el("span", { class: "yta-badge", id: "yta-due", hidden: "" })),
        el("button", { class: "yta-icon", title: "Clear this video's chat", "aria-label": "Clear this video's chat", onclick: clearHistory }, icon("trash")),
        el("button", { class: "yta-icon", title: "Settings", "aria-label": "Settings", onclick: () => alive() && chrome.runtime.sendMessage({ type: "openOptions" }) }, icon("gear")),
        el("button", { class: "yta-icon", id: "yta-toggle", title: "Expand / collapse", "aria-label": "Expand or collapse", onclick: () => panel.classList.toggle("yta-collapsed") }, icon("chevron"))
      )
    );
    header.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      panel.classList.toggle("yta-collapsed");
    });

    const tabs = el("div", { class: "yta-tabs", role: "tablist" });
    for (const [id, label, ico] of MODES) {
      tabs.append(el("button", { class: "yta-tab", role: "tab", "data-mode": id, onclick: () => setMode(id) }, icon(ico, 16), el("span", { text: label })));
    }

    const form = el("div", { class: "yta-form" });
    form.append(
      el("div", { class: "yta-fields", "data-mode": "cards" },
        el("select", { id: "yta-card-count", "aria-label": "Number of flashcards" },
          el("option", { value: "10", text: "10 cards" }),
          el("option", { value: "20", text: "20 cards", selected: "" }),
          el("option", { value: "30", text: "30 cards" })),
        el("select", { id: "yta-card-style", "aria-label": "Flashcard style" },
          el("option", { value: "terms", text: "Term → definition" }),
          el("option", { value: "qa", text: "Question → answer" }))),
      el("div", { class: "yta-fields", "data-mode": "quiz" },
        el("select", { id: "yta-quiz-count", "aria-label": "Number of questions" },
          el("option", { value: "5", text: "5 questions" }),
          el("option", { value: "10", text: "10 questions" }))),
      el("button", { id: "yta-run", class: "yta-primary yta-go", onclick: runMode }, icon("spark", 16), el("span", { id: "yta-run-label" })),
      el("p", { class: "yta-notice", id: "yta-notice" })
    );

    const thread = el("div", { id: "yta-thread", class: "yta-thread", "aria-live": "polite" });

    // Shown while this video's thread is empty: what the tab does (and, on Chat, questions to start with).
    const intro = el("div", { class: "yta-intro", id: "yta-intro" },
      el("p", { class: "yta-intro-title", id: "yta-intro-title" }),
      el("p", { class: "yta-intro-text", id: "yta-intro-text" }),
      el("div", { class: "yta-chips", id: "yta-chips" },
        ...SUGGESTIONS.map((q) => el("button", { class: "yta-chip", text: q, onclick: () => {
          $("#yta-followup-input").value = q;
          sendFollowup();
        } }))));

    // The chat box: the main input on the Chat tab, and for follow-ups everywhere else.
    const chatBox = el("div", { class: "yta-followup" },
      el("input", { id: "yta-followup-input", placeholder: "Ask anything about this video...", "aria-label": "Ask a question about this video" }),
      el("button", { class: "yta-send", "aria-label": "Send", title: "Send", onclick: sendFollowup }, icon("send", 18))
    );
    chatBox.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendFollowup(); } });

    const body = el("div", { class: "yta-body" }, tabs, form, thread, intro, chatBox);
    panel.append(header, body);
    return panel;
  }

  function setMode(mode) {
    state.mode = mode;
    const panel = $("#yta-panel");
    panel.dataset.mode = mode;
    document.querySelectorAll("#yta-panel .yta-tab").forEach((t) => {
      t.classList.toggle("yta-active", t.dataset.mode === mode);
      t.setAttribute("aria-selected", String(t.dataset.mode === mode));
    });
    document.querySelectorAll("#yta-panel .yta-fields").forEach((f) => f.classList.toggle("yta-show", f.dataset.mode === mode));
    const [, , , title, text, action] = MODES.find(([id]) => id === mode);
    $("#yta-intro-title").textContent = title;
    $("#yta-intro-text").textContent = text;
    $("#yta-run-label").textContent = action || "";
    $("#yta-followup-input").placeholder = mode === "chat" ? "Ask anything about this video..." : "Ask a follow-up...";
    if (mode === "chat" && !panel.classList.contains("yta-collapsed")) $("#yta-followup-input").focus();
  }

  async function ensureContext() {
    if (state.ctx) return state.ctx;
    if (state.ctxPromise) return state.ctxPromise;
    setStatus("Reading captions", "yta-busy");
    state.ctxPromise = loadVideoContext(state.videoId).then((ctx) => {
      const notice = $("#yta-notice");
      if (ctx.transcript) {
        state.ctx = ctx;
        setStatus("Captions ready", "yta-ok");
        if (notice) notice.textContent = ctx.fromDub
          ? `This video has no captions in its original language, so Study Pal is reading the ${ctx.transcriptLang} captions of a dubbed version.`
          : "";
      } else {
        state.ctxPromise = null; // retry on the next request (e.g. an ad was playing)
        setStatus("No transcript", "yta-warn");
        if (notice) notice.textContent = `Couldn't read the captions: ${ctx.transcriptError}. Answers will use only the title and description. Try again in a moment.`;
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
    if (state.busy || state.mode === "chat") return;
    const builtinReady = prefs.provider === "builtin" ? startBuiltin(prefs.language) : null;
    builtinReady?.catch(() => {}); // awaited (and reported) in ask()
    const mode = state.mode;
    const cfg = await chrome.storage.local.get(["language"]);
    const fields = {
      cardCount: Number($("#yta-card-count").value) || 20,
      cardStyle: $("#yta-card-style").value,
      quizCount: Number($("#yta-quiz-count").value) || 5
    };
    const label = mode === "notes" ? "Study notes"
      : mode === "quiz" ? `Quiz: ${fields.quizCount} questions`
      : `Flashcards: ${fields.cardCount} ${fields.cardStyle === "qa" ? "questions" : "terms"}`;
    await ask(buildTask(mode, fields), label, cfg.language, builtinReady,
      { cards: mode === "cards" ? fields.cardCount : 0, quiz: mode === "quiz" ? fields.quizCount : 0 });
  }

  async function sendFollowup() {
    if (!alive()) return;
    const input = $("#yta-followup-input");
    const q = input.value.trim();
    if (!q || state.busy) return;
    const builtinReady = prefs.provider === "builtin" ? startBuiltin(prefs.language) : null;
    builtinReady?.catch(() => {}); // awaited (and reported) in ask()
    input.value = "";
    const cfg = await chrome.storage.local.get(["language"]);
    await ask(q, q, cfg.language, builtinReady);
  }

  async function ask(userContent, displayLabel, language, builtinReady, { cards = 0, quiz = 0 } = {}) {
    const configured = await chrome.runtime.sendMessage({ type: "isConfigured" });
    if (!configured?.ok) {
      addMessage("assistant", "**No AI is set up.** Click ⚙ and choose Chrome built-in AI (free, no key) or add an API key.");
      return;
    }
    state.busy = true;
    $("#yta-run").disabled = true;
    addMessage("user", displayLabel);
    const pending = addMessage("assistant", "", { pending: true });
    try {
      const builtin = configured.provider === "builtin";
      const builtinOpts = builtin ? await builtinReady : null; // model ready before the slower caption fetch
      const ctx = await ensureContext();
      if ((cards || quiz) && !ctx.transcript) {
        pending.remove();
        addMessage("assistant", `${cards ? "Flashcards" : "Quizzes"} need the video's captions, and none could be read for this video.`);
        return;
      }
      state.messages.push({ role: "user", content: userContent, label: displayLabel });
      const thread = $("#yta-thread");
      let frame = 0, latest = "";
      const onDelta = (text) => {
        latest = text;
        if (cards || quiz) return; // the reply is JSON; keep the dots until it's turned into cards or a quiz
        // Re-render at most once per frame; only follow the bottom if the reader is already there.
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
          fillAssistant(pending, latest, { streaming: true });
          if (atBottom) thread.scrollTop = thread.scrollHeight;
        });
      };
      const res = builtin
        ? await builtinChat(ctx, language, state.messages, onDelta, builtinOpts).then(
            (text) => ({ ok: true, text }),
            (e) => ({ ok: false, error: builtinError(e), partial: latest }))
        : await sendChat(buildSystem(ctx, language), state.messages, onDelta);
      cancelAnimationFrame(frame);
      if (!res?.ok) {
        state.messages.pop();
        if (res?.partial && !cards && !quiz) fillAssistant(pending, res.partial);
        else pending.remove();
        addMessage("assistant", builtin ? res.error : `**Error:** ${res?.error || "unknown"}\n\nCheck your key and model in ⚙ settings.`);
        return;
      }
      if (cards || quiz) {
        const items = cards ? parseCards(res.text, cards, ctx.lengthSeconds) : parseQuiz(res.text, quiz, ctx.lengthSeconds);
        if (!items.length) {
          state.messages.pop();
          pending.remove();
          addMessage("assistant", `Couldn't read ${cards ? "flashcards" : "a quiz"} from the AI's answer. Press Go to try again.`);
          return;
        }
        const content = cards ? cardsMarkdown(items) : quizMarkdown(items);
        state.messages.push({ role: "assistant", content, ...(cards ? { cards: items } : { quiz: items }) });
        fillAssistant(pending, content, cards ? { cards: items } : { quiz: items });
        saveHistory();
        if (cards) {
          const added = await addToDeck(items);
          setStatus(added ? `${added} cards added to review` : `${items.length} flashcards ready`, "yta-ok");
        } else setStatus("Quiz ready", "yta-ok");
        return;
      }
      state.messages.push({ role: "assistant", content: res.text });
      fillAssistant(pending, res.text);
      saveHistory();
      setStatus(builtin ? "On-device AI" : configured.model, "yta-ok");
    } catch (e) {
      pending.remove();
      addMessage("assistant", builtinError(e));
    } finally {
      state.busy = false;
      $("#yta-run").disabled = false;
    }
  }

  const toSeconds = (v) => (typeof v === "number" ? v : parseTime(String(v ?? "").replace(/[^\d:]/g, "") || "NaN"));

  // ---------- Flashcards: Quizlet and Anki ----------

  // Cards from the model's JSON: trimmed, single-line (tabs and line breaks are the import separators),
  // de-duplicated, capped at the number asked for.
  // The JSON array in a model reply (models often wrap it in prose), or [].
  function jsonArray(text) {
    try {
      const raw = JSON.parse(String(text).match(/\[[\s\S]*\]/)?.[0]);
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }

  const cleanText = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
  // Timestamps belong in `time`; models sometimes also write them (or links) into the text.
  const stripTimes = (v) => cleanText(v).replace(/\[?\(?\d{1,2}:\d{2}(?::\d{2})?\)?\]?(\(https?:[^)]*\))?/g, "")
    .replace(/\s+([.,;:!?])/g, "$1").replace(/\s{2,}/g, " ").trim();

  function parseCards(text, max, dur = Infinity) {
    const raw = jsonArray(text);
    const seen = new Set();
    const cards = [];
    for (const r of raw) {
      const front = stripTimes(r?.front ?? r?.term ?? r?.question), back = stripTimes(r?.back ?? r?.definition ?? r?.answer);
      if (!front || !back || seen.has(front.toLowerCase())) continue;
      seen.add(front.toLowerCase());
      const t = toSeconds(r?.time);
      cards.push({ front, back, ...(Number.isFinite(t) && t >= 0 && t < dur ? { t } : {}) });
      if (cards.length >= max) break;
    }
    // In video order, so studying follows the video (cards without a time keep their place at the end).
    return cards.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
  }

  function cardsMarkdown(cards) {
    return [`**${cards.length} flashcards**`, "", ...cards.map((c, i) =>
      `${i + 1}. **${c.front}**: ${c.back}${c.t != null ? ` [${fmtTime(c.t)}]` : ""}`)].join("\n");
  }

  // One card per line, term and definition separated by a tab: the default format of Quizlet's import,
  // and of Anki's text import. Each answer ends with a link back to the moment it's explained.
  function cardsAsText(cards) {
    return cards.map((c) => {
      const link = c.t != null ? ` (video at ${fmtTime(c.t)}: youtu.be/${state.videoId}?t=${Math.floor(c.t)})` : "";
      return `${c.front}\t${c.back}${link}`;
    }).join("\n");
  }

  const setTitle = () => `${state.ctx?.title || document.title.replace(/ - YouTube$/, "")} (flashcards)`.slice(0, 120);

  async function copyForQuizlet(cards) {
    try {
      await navigator.clipboard.writeText(cardsAsText(cards));
      setStatus("Copied. In Quizlet: Create a set, click Import, paste.", "yta-ok");
    } catch {
      setStatus("Couldn't copy to the clipboard. Click the panel and try again.", "yta-err");
    }
  }

  // Quizlet has no public API for creating sets, so quizlet.js fills in Quizlet's own create-set page in
  // this browser, where the user is already logged in; no login details ever leave the browser. The cards
  // also go on the clipboard first, so pasting into Quizlet's Import box works if the page has changed.
  async function sendToQuizlet(cards) {
    if (!alive()) return;
    const text = cardsAsText(cards);
    navigator.clipboard.writeText(text).catch(() => {}); // fallback, while we still have the click
    await chrome.storage.local.set({ quizletPending: { title: setTitle(), text, count: cards.length, at: Date.now() } });
    chrome.runtime.sendMessage({ type: "openQuizlet" });
    setStatus("Opening Quizlet...", "yta-ok");
  }

  function downloadForAnki(cards) {
    // Anki reads these header lines (2.1.55+); older versions just ask about the separator on import.
    const file = new Blob([`#separator:tab\n#html:false\n${cardsAsText(cards)}\n`], { type: "text/plain" });
    const a = el("a", { href: URL.createObjectURL(file), download: `${setTitle().replace(/[\\/:*?"<>|]+/g, " ")}.txt` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    setStatus("Downloaded. In Anki: File → Import, choose the file.", "yta-ok");
  }

  // ---------- Quiz ----------

  // Questions from the model's JSON: 2-6 unique choices with a valid answer (index, letter, or the choice's
  // text). Choices are shuffled, because models put the right answer first far too often.
  function parseQuiz(text, max, dur = Infinity, random = Math.random) {
    const quiz = [];
    for (const r of jsonArray(text)) {
      const question = stripTimes(r?.question);
      const choices = [...new Set((Array.isArray(r?.choices) ? r.choices : []).map(stripTimes).filter(Boolean))];
      if (!question || choices.length < 2 || choices.length > 6) continue;
      const a = r?.answer;
      const answer = typeof a === "number" ? a
        : /^[A-F]$/i.test(String(a ?? "").trim()) ? String(a).trim().toUpperCase().charCodeAt(0) - 65
        : choices.findIndex((c) => c.toLowerCase() === cleanText(a).toLowerCase());
      if (!Number.isInteger(answer) || answer < 0 || answer >= choices.length) continue;
      const order = choices.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const t = toSeconds(r?.time);
      quiz.push({
        question, choices: order.map((i) => choices[i]), answer: order.indexOf(answer),
        explanation: stripTimes(r?.explanation),
        ...(Number.isFinite(t) && t >= 0 && t < dur ? { t } : {})
      });
      if (quiz.length >= max) break;
    }
    return quiz;
  }

  // Text version, for Copy and so follow-up questions can refer to the quiz.
  function quizMarkdown(quiz) {
    return [`**Quiz: ${quiz.length} questions**`, "", ...quiz.map((q, i) =>
      `${i + 1}. ${q.question} Answer: ${q.choices[q.answer]}.${q.explanation ? ` ${q.explanation}` : ""}`)].join("\n");
  }

  // Flashcards as cards you can flip (click or Enter/Space): question on the front, answer on the back.
  function renderCards(cards) {
    const wrap = el("div", { class: "yta-deck" },
      el("p", { class: "yta-deck-title" }, el("strong", { text: `${cards.length} flashcards` }), " · tap a card to flip it"));
    for (const c of cards) {
      const back = el("span", { class: "yta-flip-back" }, el("span", { text: c.back }));
      if (c.t != null) {
        back.append(el("a", { class: "yta-ts", href: "#", text: fmtTime(c.t),
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); seekTo(c.t); } }));
      }
      const card = el("div", { class: "yta-flip", role: "button", tabindex: "0", "aria-pressed": "false",
        "aria-label": `Flashcard: ${c.front}. Press to show the answer.` },
        el("span", { class: "yta-flip-front", text: c.front }), back);
      const flip = () => {
        const on = card.classList.toggle("yta-flipped");
        card.setAttribute("aria-pressed", String(on));
      };
      card.addEventListener("click", flip);
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
      wrap.append(card);
    }
    return wrap;
  }

  function renderQuiz(quiz) {
    const box = el("div", { class: "yta-quiz" });
    const score = el("p", { class: "yta-quiz-score", "aria-live": "polite" });
    let answered = 0, correct = 0;
    quiz.forEach((q, qi) => {
      const feedback = el("div", { class: "yta-quiz-feedback", "aria-live": "polite" });
      const item = el("div", { class: "yta-quiz-q" },
        el("p", { class: "yta-quiz-count", text: `Question ${qi + 1} of ${quiz.length}` }),
        el("p", { class: "yta-quiz-text", text: q.question }));
      const choices = q.choices.map((c, ci) => el("button", { class: "yta-choice", onclick: () => {
        if (item.dataset.done) return;
        item.dataset.done = "1";
        const right = ci === q.answer;
        answered++;
        if (right) correct++;
        choices.forEach((b, bi) => {
          b.disabled = true;
          if (bi === q.answer) b.classList.add("yta-right");
          else if (bi === ci) b.classList.add("yta-wrong");
        });
        feedback.append(el("p", { text: `${right ? "✓ Correct." : `✗ The answer is: ${q.choices[q.answer]}.`} ${q.explanation}`.trim() }));
        if (!right && q.t != null) {
          feedback.append(el("button", { class: "yta-secondary", text: `▶ Rewatch from ${fmtTime(q.t)}`, onclick: () => seekTo(q.t) }));
        }
        if (answered === quiz.length) {
          score.textContent = `${correct} / ${quiz.length} correct. ${correct === quiz.length ? "Perfect, you've got this video down."
            : correct >= quiz.length / 2 ? "Nice work. Rewatch the parts you missed, then try again."
            : "Worth another look: rewatch the parts linked above, then retake the quiz."}`;
          score.classList.toggle("yta-perfect", correct === quiz.length);
        }
      } }, el("span", { class: "yta-letter", text: String.fromCharCode(65 + ci) }), el("span", { text: c })));
      item.append(el("div", { class: "yta-choices" }, ...choices), feedback);
      box.append(item);
    });
    box.append(score);
    return box;
  }

  // ---------- Daily review: spaced repetition across every video ----------
  // ponytail: the whole deck in one storage key; fine for thousands of cards, split by video if it outgrows that.

  const DECK_KEY = "studyDeck";
  const DAY = 24 * 60 * 60 * 1000;

  // New cards from a video, minus ones already in the deck (same video, same front). Due right away.
  function mergeIntoDeck(deck, cards, video, now = Date.now()) {
    const have = new Set(deck.map((c) => `${c.videoId}|${c.front.toLowerCase()}`));
    const fresh = cards.filter((c) => !have.has(`${video.id}|${c.front.toLowerCase()}`)).map((c, i) => ({
      id: `${video.id}-${now}-${i}`, videoId: video.id, videoTitle: video.title,
      front: c.front, back: c.back, ...(c.t != null ? { t: c.t } : {}),
      due: now, interval: 0, ease: 2.5, reps: 0
    }));
    return { deck: [...deck, ...fresh], added: fresh.length };
  }

  // Simplified SM-2. "Again": see it again in 10 minutes and start over. "Good": 1 day, then 3, then the gap
  // times the card's ease. "Easy": a longer gap, and the card gets easier from then on.
  function schedule(card, grade, now = Date.now()) {
    const c = { ...card };
    if (grade === "again") {
      return { ...c, reps: 0, interval: 0, ease: Math.max(1.3, c.ease - 0.2), due: now + 10 * 60 * 1000 };
    }
    c.reps += 1;
    const base = c.reps === 1 ? 1 : c.reps === 2 ? 3 : Math.max(1, Math.round(c.interval * c.ease));
    if (grade === "easy") {
      c.interval = Math.max(base + 1, Math.round(base * 1.3));
      c.ease += 0.15;
    } else c.interval = base;
    c.due = now + c.interval * DAY;
    return c;
  }

  const dueCards = (deck, now = Date.now()) => deck.filter((c) => c.due <= now).sort((a, b) => a.due - b.due);

  async function loadDeck() {
    return (await chrome.storage.local.get(DECK_KEY))[DECK_KEY] || [];
  }

  async function addToDeck(cards) {
    if (!alive()) return 0;
    const video = { id: state.videoId, title: state.ctx?.title || document.title.replace(/ - YouTube$/, "") };
    const { deck, added } = mergeIntoDeck(await loadDeck(), cards, video);
    await chrome.storage.local.set({ [DECK_KEY]: deck });
    return added;
  }

  async function updateDueBadge() {
    const badge = $("#yta-due");
    if (!badge || !chrome.runtime?.id) return;
    const n = dueCards(await loadDeck()).length;
    badge.textContent = n ? String(n) : "";
    badge.hidden = !n;
  }
  chrome.storage.onChanged.addListener((changes) => { if (DECK_KEY in changes) updateDueBadge(); });
  setInterval(updateDueBadge, 60 * 1000); // cards come due while the page is open

  // One card at a time, in the thread (not saved to the chat). Answers link back to the video moment.
  async function startReview() {
    if (!alive() || state.busy) return;
    $("#yta-review-box")?.remove();
    const box = el("div", { class: "yta-msg yta-assistant yta-review", id: "yta-review-box" });
    $("#yta-thread").append(box);
    const queue = dueCards(await loadDeck());
    const total = queue.length;
    let done = 0;
    const show = () => {
      box.replaceChildren();
      const card = queue.shift();
      if (!card) {
        box.append(
          el("div", { class: "yta-review-head" }, icon("review", 16), el("strong", { text: "Daily review" })),
          el("p", { class: "yta-review-done", text: total
            ? `All done for today: ${total} card${total === 1 ? "" : "s"} reviewed. See you tomorrow.`
            : "Nothing to review right now. Make flashcards on any video and they'll show up here when they're due." }),
          el("button", { class: "yta-secondary", text: "Close", onclick: () => box.remove() }));
        return;
      }
      const jump = card.t == null ? null
        : card.videoId === state.videoId
          ? el("button", { class: "yta-mini", text: `▶ ${fmtTime(card.t)} in this video`, onclick: () => seekTo(card.t) })
          : el("a", { class: "yta-mini", href: `https://www.youtube.com/watch?v=${card.videoId}&t=${Math.floor(card.t)}s`,
              target: "_blank", rel: "noopener", text: `▶ ${fmtTime(card.t)} in the video` });
      const gap = (g) => { const d = schedule(card, g).interval; return `${d} day${d === 1 ? "" : "s"}`; };
      const grades = [["again", "Again", "10 min"], ["good", "Good", gap("good")], ["easy", "Easy", gap("easy")]].map(([g, text, when]) => el("button", {
        class: `yta-grade yta-grade-${g}`,
        onclick: async () => {
          const deck = await loadDeck();
          const i = deck.findIndex((c) => c.id === card.id);
          if (i >= 0) deck[i] = schedule(deck[i], g);
          await chrome.storage.local.set({ [DECK_KEY]: deck });
          if (g === "again") queue.push(deck[i] || card); // see it again this session
          else done++;
          show();
        }
      }, el("span", { text }), el("small", { text: when })));
      const answer = el("div", { class: "yta-review-answer", hidden: "" },
        el("p", { text: card.back }), jump, el("div", { class: "yta-grades" }, ...grades));
      const bar = el("div", { class: "yta-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(done) },
        el("span", { style: `width:${Math.round((done / total) * 100)}%` }));
      box.append(
        el("div", { class: "yta-review-head" }, icon("review", 16), el("strong", { text: "Daily review" }), el("span", { text: `${done + 1} of ${total}` })),
        bar,
        el("p", { class: "yta-review-meta", text: `From: ${card.videoTitle || "a video"}` }),
        el("p", { class: "yta-review-front", text: card.front }),
        el("button", { class: "yta-primary", text: "Show answer", onclick: (e) => { e.currentTarget.remove(); answer.hidden = false; } }),
        answer);
      $("#yta-thread").scrollTop = $("#yta-thread").scrollHeight;
    };
    show();
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
    for (const m of saved) addMessage(m.role, m.role === "user" ? m.label || m.content : m.content, { cards: m.cards, quiz: m.quiz });
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
    state = { videoId, mode: "chat", ctx: null, ctxPromise: null, messages: [], busy: false };

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
      setMode("chat");
      setStatus("Ready");
      restoreHistory(videoId);
      updateDueBadge();
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
