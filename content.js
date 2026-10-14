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
          if (!text) continue;
          const t = (ev.tStartMs || 0) / 1000;
          // Auto-captions carry a time per word; kept for cutting at exact words (buildTimeline).
          const words = ev.segs.filter((s) => s.utf8.trim()).map((s) => ({ t: t + (s.tOffsetMs || 0) / 1000, text: s.utf8 }));
          segs.push({ t, end: t + (ev.dDurationMs || 0) / 1000, text, words });
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

  // Word and sentence timings, for cutting the short version at full sentences. Auto-captions carry a time
  // per word; uploaded captions only per line, so word times inside a line are interpolated by character
  // position. Uploaded captions are punctuated, so sentences end at . ? ! — auto-captions usually aren't,
  // so there pauses split the text into chunks (and the model's quoted first/last words do the real work,
  // see findPhrase).
  function buildTimeline(segs) {
    const words = [];
    for (const s of segs) {
      const end = Math.max(s.end ?? s.t + 3, s.t + 0.1);
      if (s.words?.length > 1) {
        s.words.forEach((w, i) => words.push({ t: w.t, end: Math.min(s.words[i + 1]?.t ?? end, w.t + 0.8), text: w.text.trim() }));
        continue;
      }
      for (const m of s.text.matchAll(/\S+/g)) {
        words.push({ t: s.t + (end - s.t) * m.index / s.text.length, end: s.t + (end - s.t) * (m.index + m[0].length) / s.text.length, text: m[0] });
      }
    }
    words.sort((a, b) => a.t - b.t);
    const endsSentence = (w) => /[.?!…]["'”’)\]]*$/.test(w.text);
    const punctuated = words.filter(endsSentence).length >= words.length / 40;
    const sentences = [];
    let cur = null;
    words.forEach((w, i) => {
      cur ||= { start: w.t, end: w.end, text: [] };
      cur.text.push(w.text);
      cur.end = Math.max(cur.end, w.end);
      const next = words[i + 1];
      const gap = next ? next.t - w.t : Infinity;
      const len = cur.end - cur.start;
      const ends = !next || (punctuated ? endsSentence(w) || len > 60 : gap > 1 || (len > 20 && gap > 0.5) || len > 40);
      if (!ends) return;
      if (next) cur.end = Math.min(cur.end, next.t);
      sentences.push({ start: cur.start, end: cur.end, text: cur.text.join(" ") });
      cur = null;
    });
    return { words, sentences, punctuated };
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
    const timeline = segs ? buildTimeline(segs) : { words: [], sentences: [], punctuated: false }; // for short-version cuts
    return { ...data, transcript, ...timeline, transcriptLang, transcriptLangCode, transcriptError, autoCaptions, fromDub };
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
    if (mode === "cut") {
      return [
        `Make a short version of this video, about ${fields.cutMinutes} minutes long, made of its best moments.`,
        "First read the whole transcript. Then identify the video's key points: the 5 to 10 most valuable ideas, findings, claims or pieces of advice in the entire video. The best points are often in the middle or near the end, not at the start.",
        "Rank them from most to least valuable for someone who will not watch the video.",
        "For each key point give the span where the speaker actually makes it: 10 to 45 seconds, beginning where that thought begins and ending where it ends, never mid-sentence. The transcript may have no punctuation, so judge where each thought starts and stops from the words.",
        "For each span also copy, exactly as written in the transcript, its first 5 to 8 words and its last 5 to 8 words. These are used to cut precisely.",
        "Skip intros, sponsor segments, calls to subscribe, recaps and filler.",
        'Reply with only a JSON array ordered by rank, best first, and no other text, like: [{"rank":1,"start":"4:05","end":"4:40","first_words":"but then came my senior thesis","last_words":"spend a year on it","title":"3 to 6 word label"}]'
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

  function addMessage(role, content, { pending = false, cut = null } = {}) {
    const thread = $("#yta-thread");
    const msg = el("div", { class: `yta-msg yta-${role}` });
    if (pending) {
      msg.classList.add("yta-pending");
      msg.append(el("span", { class: "yta-dots" }, el("i"), el("i"), el("i")));
    } else if (role === "assistant") {
      fillAssistant(msg, content, { cut });
    } else {
      msg.append(el("p", { text: content }));
    }
    thread.append(msg);
    thread.scrollTop = thread.scrollHeight;
    return msg;
  }

  function fillAssistant(msg, content, { streaming = false, cut = null } = {}) {
    msg.classList.remove("yta-pending");
    msg.replaceChildren(renderMarkdown(content));
    if (streaming) return;
    if (cut) {
      const btn = el("button", { class: "yta-primary yta-cut-btn", text: "▶ Play short version",
        onclick: () => (activeCut?.segs === cut ? stopCut("Stopped the short version.") : playCut(cut)) });
      btn.ytaCut = cut;
      msg.append(btn);
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
      ["ask", "Ask an expert", "Commentary through a lens you pick"],
      ["cut", "Watch short", "Play only the key moments"]
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
      // cut
      el("div", { class: "yta-fields", "data-mode": "cut" },
        el("select", { id: "yta-cut-len", "aria-label": "Length of the short version" },
          el("option", { value: "2", text: "About 2 minutes" }),
          el("option", { value: "5", text: "About 5 minutes", selected: "" }),
          el("option", { value: "10", text: "About 10 minutes" }))),
      el("div", { class: "yta-actions" },
        el("button", { id: "yta-run", class: "yta-primary", text: "Go", onclick: runMode }),
        el("span", { class: "yta-hint", id: "yta-hint" })),
      el("p", { class: "yta-notice", id: "yta-notice" })
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
      : mode === "cut" ? "Plays just the key moments, back to back."
      : "Blank = your default lens from settings.";
    const input = $(`#yta-panel .yta-fields[data-mode="${mode}"] input`);
    if (input && !$("#yta-panel").classList.contains("yta-collapsed")) input.focus();
  }

  async function ensureContext() {
    if (state.ctx) return state.ctx;
    if (state.ctxPromise) return state.ctxPromise;
    setStatus("Reading transcript...", "yta-busy");
    state.ctxPromise = loadVideoContext(state.videoId).then((ctx) => {
      const notice = $("#yta-notice");
      if (ctx.transcript) {
        state.ctx = ctx;
        setStatus(`Transcript loaded${ctx.transcriptLang ? " (" + ctx.transcriptLang + ")" : ""}`, "yta-ok");
        if (notice) notice.textContent = ctx.fromDub
          ? `This video has no captions in its original language, so the agent is reading the ${ctx.transcriptLang} captions of a dubbed version.`
          : "";
      } else {
        state.ctxPromise = null; // retry on the next request (e.g. an ad was playing)
        setStatus("No transcript", "yta-warn");
        if (notice) notice.textContent = `Couldn't read the captions: ${ctx.transcriptError}. Answers will use only the title and description. Press Go to try again.`;
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
    const builtinReady = prefs.provider === "builtin" ? startBuiltin(prefs.language) : null;
    builtinReady?.catch(() => {}); // awaited (and reported) in ask()
    const mode = state.mode;
    const cfg = await chrome.storage.local.get(["analogyDomain", "persona", "language"]);
    const fields = {
      focus: $("#yta-focus").value.trim(),
      framing: $("#yta-framing").value.trim() || cfg.analogyDomain || "",
      persona: $("#yta-persona").value.trim() || cfg.persona || "",
      question: $("#yta-question").value.trim(),
      cutMinutes: Number($("#yta-cut-len").value) || 5
    };
    const task = buildTask(mode, fields);
    const label = mode === "summarize" ? "Summarize" + (fields.focus ? `: ${fields.focus}` : "")
      : mode === "explain" ? fields.framing ? `Explain: ${fields.framing}` : "Explain simply"
      : mode === "cut" ? `Watch short: about ${fields.cutMinutes} minutes`
      : `Ask an expert: ${[fields.persona && `As ${fields.persona.replace(/^as\s+/i, "")}`, fields.question].filter(Boolean).join(", ") || "general commentary"}`;
    await ask(task, label, cfg.language, builtinReady, { cut: mode === "cut" ? fields.cutMinutes : 0 });
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

  async function ask(userContent, displayLabel, language, builtinReady, { cut = false } = {}) {
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
      if (cut && !ctx.transcript) {
        pending.remove();
        addMessage("assistant", "The short version needs the video's captions, and none could be read for this video.");
        return;
      }
      state.messages.push({ role: "user", content: userContent, label: displayLabel });
      const thread = $("#yta-thread");
      let frame = 0, latest = "";
      const onDelta = (text) => {
        latest = text;
        if (cut) return; // the reply is JSON; keep the dots until it's turned into segments
        // Re-render at most once per frame; only follow the bottom if the reader is already there.
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
          fillAssistant(pending, latest, { streaming: true });
          if (atBottom) thread.scrollTop = thread.scrollHeight;
        });
      };
      const modelCtx = cut ? withSentenceTranscript(ctx) : ctx;
      const res = builtin
        ? await builtinChat(modelCtx, language, state.messages, onDelta, builtinOpts).then(
            (text) => ({ ok: true, text }),
            (e) => ({ ok: false, error: builtinError(e), partial: latest }))
        : await sendChat(buildSystem(modelCtx, language), state.messages, onDelta);
      cancelAnimationFrame(frame);
      if (!res?.ok) {
        state.messages.pop();
        if (res?.partial) fillAssistant(pending, res.partial);
        else pending.remove();
        addMessage("assistant", builtin ? res.error : `**Error:** ${res?.error || "unknown"}\n\nCheck your key and model in ⚙ settings.`);
      } else if (cut) {
        const segs = parseCut(res.text, ctx, cut * 60);
        if (!segs.length) {
          state.messages.pop();
          pending.remove();
          addMessage("assistant", "Couldn't pick the key moments from the AI's answer. Press Go to try again.");
        } else {
          const content = cutMarkdown(segs, ctx.lengthSeconds);
          state.messages.push({ role: "assistant", content, cut: segs });
          fillAssistant(pending, content, { cut: segs });
          saveHistory();
          setStatus("Short version ready", "yta-ok");
        }
      } else {
        state.messages.push({ role: "assistant", content: res.text });
        fillAssistant(pending, res.text);
        saveHistory();
        setStatus(builtin ? "Chrome built-in AI · on-device" : `${configured.provider} · ${configured.model}`, "yta-ok");
      }
    } catch (e) {
      pending.remove();
      addMessage("assistant", builtinError(e));
    } finally {
      state.busy = false;
      $("#yta-run").disabled = false;
    }
  }

  // ---------- Short version: play only the key moments ----------

  const toSeconds = (v) => (typeof v === "number" ? v : parseTime(String(v ?? "").replace(/[^\d:]/g, "") || "NaN"));

  // "1 min 05 s" rather than "1:05", so durations aren't turned into clickable timestamps.
  const fmtDuration = (sec) => {
    sec = Math.round(sec);
    return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, "0")} s`;
  };

  const normWord = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

  // Where a quoted run of words occurs in the timeline near time `near` (within 45 s): its first word's
  // start, or (atEnd) its last word's end. Needs 3+ words in order (or all of a shorter quote).
  function findPhrase(words, phrase, near, atEnd) {
    const want = String(phrase || "").split(/\s+/).map(normWord).filter(Boolean);
    if (want.length < 2 || !Number.isFinite(near)) return null;
    let best = null;
    for (let i = 0; i < words.length; i++) {
      if (Math.abs(words[i].t - near) > 45) continue;
      let k = 0, j = i;
      while (k < want.length && j < words.length) {
        const w = normWord(words[j].text);
        if (w && w !== want[k]) break;
        if (w) k++;
        j++;
      }
      if (k < Math.min(3, want.length)) continue;
      const score = k * 100 - Math.abs(words[i].t - near);
      if (!best || score > best.score) best = { score, t: words[i].t, end: words[j - 1].end };
    }
    return best ? (atEnd ? best.end : best.t) : null;
  }

  // Turn the model's JSON (key points ranked best first) into playable segments: snap each to full
  // sentences, drop anything invalid or tiny, merge overlaps, then fit the requested length. Models are bad
  // at adding up durations, so the length is enforced here: long points are cut back to their last full
  // sentence that fits, and points are kept in rank order until the budget is used, then played in order.
  function parseCut(text, ctx, targetSeconds = Infinity) {
    let raw;
    try { raw = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0]); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    const sents = ctx.sentences || [];
    const words = ctx.words || [];
    const dur = ctx.lengthSeconds || Infinity;
    // The last sentence starting at or before t. The transcript shows times rounded down to the second
    // (a sentence starting at 19.6 s is listed as 0:19), so model-given times get up to a second of slack.
    const sentenceAt = (t, slack = 0) => {
      let found = null;
      for (const s of sents) { if (s.start <= t + slack) found = s; else break; }
      return found || sents[0];
    };
    // Exact times from the quoted words when they can be found near the model's time; then, on punctuated
    // captions, widen to the full sentence. Without punctuation the quote itself marks the thought.
    const cutStart = (t, quote) => {
      const exact = findPhrase(words, quote, t, false);
      if (exact == null) return sents.length ? sentenceAt(t, 1).start : t;
      return ctx.punctuated ? sentenceAt(exact).start : exact;
    };
    const cutEnd = (t, quote) => {
      const exact = findPhrase(words, quote, t, true);
      if (exact == null) return Math.min(sents.length ? sentenceAt(t, 1).end : t, dur);
      return Math.min(ctx.punctuated ? sentenceAt(exact - 0.2).end : exact, dur);
    };
    const segs = raw
      .map((r, i) => ({ start: toSeconds(r?.start), end: toSeconds(r?.end), title: String(r?.title || "").trim().slice(0, 60),
        rank: Number(r?.rank) || i + 1, first: r?.first_words, last: r?.last_words }))
      // judge length on the model's own times: snapping can stretch a 1-second blip to a whole sentence
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.start < dur && s.end - s.start >= 3)
      .map(({ first, last, ...s }) => ({ ...s, start: cutStart(s.start, first), end: cutEnd(s.end, last) }))
      .filter((s) => s.end - s.start >= 3)
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const s of segs) {
      const last = merged.at(-1);
      if (last && s.start <= last.end + 1) {
        last.end = Math.max(last.end, s.end);
        if (s.rank < last.rank) Object.assign(last, { rank: s.rank, title: s.title || last.title });
      } else merged.push(s);
    }
    if (!Number.isFinite(targetSeconds)) return merged;

    // Cut long points back to the last full sentence that fits (never mid-sentence: an overlong single
    // sentence is kept whole).
    const maxLen = Math.min(90, Math.max(20, targetSeconds * 0.4));
    for (const s of merged) {
      if (s.end - s.start <= maxLen) continue;
      const inside = sents.filter((x) => x.start >= s.start - 0.01 && x.end <= s.end + 0.01);
      if (!inside.length) { s.end = s.start + maxLen; continue; }
      s.end = inside.filter((x) => x.end <= s.start + maxLen).at(-1)?.end ?? inside[0].end;
    }
    // Best first; keep whatever fits in the budget.
    const budget = targetSeconds * 1.1;
    let used = 0;
    const kept = [...merged].sort((a, b) => a.rank - b.rank || a.start - b.start)
      .filter((s) => used + (s.end - s.start) <= budget && (used += s.end - s.start, true));
    if (!kept.length && merged.length) {
      const best = [...merged].sort((a, b) => a.rank - b.rank)[0];
      kept.push({ ...best, end: Math.min(best.end, best.start + budget) });
    }
    // A little lead-in and tail so the first and last words aren't clipped.
    return kept.sort((a, b) => a.start - b.start)
      .map((s) => ({ ...s, start: Math.max(0, s.start - 0.15), end: Math.min(s.end + 0.3, dur) }));
  }

  // For picking cut points the model needs a time per sentence, not one per 20-second block.
  function withSentenceTranscript(ctx) {
    if (!ctx.sentences?.length) return ctx;
    const text = ctx.sentences.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join("\n");
    // ponytail: very long videos fall back to the 20-second blocks; split the request if that hurts quality.
    if (text.length > MAX_TRANSCRIPT_CHARS) return ctx;
    return { ...ctx, transcript: text, builtinTranscript: undefined };
  }

  function cutMarkdown(segs, total) {
    const len = segs.reduce((sum, s) => sum + s.end - s.start, 0);
    return [
      `**Short version: ${fmtDuration(len)}${total ? ` instead of ${fmtDuration(total)}` : ""}** (${segs.length} parts)`,
      "",
      ...segs.map((s, i) => `${i + 1}. [${fmtTime(s.start)}] ${s.title || "Untitled"} (${fmtDuration(s.end - s.start)}${s.rank ? `, key point #${s.rank}` : ""})`)
    ].join("\n");
  }

  let activeCut = null;

  function playCut(segs) {
    stopCut();
    const video = $("video");
    if (!video) return;
    const label = el("div", { id: "yta-cut-label" });
    $("#movie_player")?.append(label);
    const cut = activeCut = { segs, i: 0, video, label };
    const go = (i) => {
      cut.i = i;
      video.currentTime = segs[i].start;
      video.play?.();
      const text = `Short version · ${i + 1} of ${segs.length}${segs[i].title ? " · " + segs[i].title : ""}`;
      label.textContent = text;
      setStatus(text, "yta-ok");
    };
    cut.onTime = () => {
      if ($(".ad-showing")) return;
      const s = segs[cut.i], t = video.currentTime;
      // The viewer jumped somewhere else themselves: hand control back to them.
      if (t < s.start - 3 || t > s.end + 3) return stopCut("Stopped the short version because you jumped elsewhere.");
      if (t < s.end) return;
      if (cut.i + 1 < segs.length) go(cut.i + 1);
      else { video.pause(); stopCut("That's the short version. Press play to keep watching from here."); }
    };
    video.addEventListener("timeupdate", cut.onTime);
    go(0);
    syncCutButtons();
  }

  function stopCut(message) {
    if (!activeCut) return;
    activeCut.video.removeEventListener("timeupdate", activeCut.onTime);
    activeCut.label.remove();
    activeCut = null;
    syncCutButtons();
    if (message) setStatus(message, "yta-ok");
  }

  // Only one short version plays at a time; its button becomes Stop.
  function syncCutButtons() {
    document.querySelectorAll("#yta-panel .yta-cut-btn").forEach((btn) => {
      btn.textContent = btn.ytaCut === activeCut?.segs ? "■ Stop" : "▶ Play short version";
    });
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
    for (const m of saved) addMessage(m.role, m.role === "user" ? m.label || m.content : m.content, { cut: m.cut });
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

    stopCut();
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
