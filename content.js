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

  const { el, fmtTime, parseTime, toSeconds, icon, parseMindMap, mindMapMarkdown, renderMindMap } = globalThis.StudyPal;
  const renderMarkdown = (md) => globalThis.StudyPal.renderMarkdown(md, { onTime: seekTo });

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
    if (mode === "map") {
      return [
        "Make a mind map of what this video teaches.",
        "topic: the video's main subject in 2 to 5 words. branches: the 4 to 6 main ideas, in the order the video covers them, each 2 to 5 words. points: for each branch, the 2 to 4 most important details, examples or facts, each under 8 words. Give the timestamp where each branch and point is covered.",
        "Use only what the video says. Short, concrete labels; no full sentences.",
        'Reply with only a JSON object and no other text, like: {"topic":"How CRISPR works","branches":[{"label":"Cutting DNA","time":"3:36","points":[{"label":"Cas9 is the scissors","time":"3:36"},{"label":"Guide RNA sets the target","time":"3:52"}]}]}'
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
    .then((c) => Object.assign(prefs, { provider: effectiveProvider(c), language: c.language || "English" }))
    .then(syncUpsell);

  // On the free on-device AI, a quiet pointer to adding your own key for stronger answers.
  function syncUpsell() {
    const u = document.getElementById("yta-upsell");
    if (u) u.hidden = prefs.provider !== "builtin";
  }
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

  // Each tab keeps its own thread: a container per tab, and only the open tab's is inside #yta-thread.
  const box = (mode = state.mode) => state.boxes[mode];

  function addMessage(role, content, { pending = false, cards = null, quiz = null, notes = false, map = null, to = box() } = {}) {
    const thread = $("#yta-thread");
    const msg = el("div", { class: `yta-msg yta-${role}` });
    if (pending) {
      msg.classList.add("yta-pending");
      msg.append(el("span", { class: "yta-dots" }, el("i"), el("i"), el("i")));
    } else if (role === "assistant") {
      fillAssistant(msg, content, { cards, quiz, notes, map });
    } else {
      msg.append(el("p", { text: content }));
    }
    to.append(msg);
    thread.scrollTop = thread.scrollHeight;
    return msg;
  }

  function fillAssistant(msg, content, { streaming = false, cards = null, quiz = null, notes = false, map = null } = {}) {
    msg.classList.remove("yta-pending");
    msg.replaceChildren(quiz ? renderQuiz(quiz) : cards ? renderCards(cards)
      : map ? el("div", { class: "yta-mm-scroll" }, renderMindMap(map, { onTime: seekTo })) : renderMarkdown(content));
    if (streaming) return;
    if (map) {
      msg.append(el("div", { class: "yta-card-actions" },
        el("button", { class: "yta-secondary", text: "Open large in library", onclick: () => openLibrary() })));
    }
    if (notes) {
      msg.append(el("div", { class: "yta-card-actions" },
        el("button", { class: "yta-primary", title: "Opens a print-ready page; choose Save as PDF", onclick: () => saveNotesPdf(content) },
          icon("notes", 16), el("span", { text: "Save as PDF" }))));
    }
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
    ["notes", "Notes", "notes", "Study notes and mind maps", "The key ideas, terms and examples to review without rewatching, or the whole video as a mind map.", "Make study notes"],
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
        el("button", { class: "yta-icon", title: "Your library: every video you've studied", "aria-label": "Open your library", onclick: () => openLibrary() }, icon("library")),
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
      el("button", { id: "yta-run", class: "yta-primary yta-go", onclick: () => runMode() }, icon("spark", 16), el("span", { id: "yta-run-label" })),
      el("button", { id: "yta-run-map", class: "yta-secondary yta-go-map", onclick: () => runMode("map") }, icon("map", 16), el("span", { text: "Make mind map" })),
      el("p", { class: "yta-notice", id: "yta-notice" })
    );

    const thread = el("div", { id: "yta-thread", class: "yta-thread", "aria-live": "polite" });
    state.boxes = Object.fromEntries(MODES.map(([id]) => [id, el("div", { class: "yta-msgs", "data-mode": id })]));

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

    const upsell = el("p", { class: "yta-upsell", id: "yta-upsell", hidden: "" }, "Free on-device AI. ",
      el("button", { class: "yta-link-btn", text: "Want sharper answers? Add your own AI key",
        onclick: () => alive() && chrome.runtime.sendMessage({ type: "openOptions" }) }));

    const course = el("div", { class: "yta-course", id: "yta-course", hidden: "" });

    const clear = el("button", { class: "yta-mini yta-clear", text: "Clear this tab", title: "Clear this tab's conversation for this video", onclick: clearHistory });

    const body = el("div", { class: "yta-body" }, course, tabs, form, thread, clear, intro, chatBox, upsell);
    panel.append(header, body);
    return panel;
  }

  function setMode(mode) {
    state.mode = mode;
    const panel = $("#yta-panel");
    panel.dataset.mode = mode;
    $("#yta-thread").replaceChildren(box(mode)); // switch to this tab's own thread (others keep their state)
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

  async function runMode(kind) {
    if (!alive()) return;
    if (state.busy || state.mode === "chat") return;
    const builtinReady = prefs.provider === "builtin" ? startBuiltin(prefs.language) : null;
    builtinReady?.catch(() => {}); // awaited (and reported) in ask()
    const mode = kind || state.mode;
    const cfg = await chrome.storage.local.get(["language"]);
    const fields = {
      cardCount: Number($("#yta-card-count").value) || 20,
      cardStyle: $("#yta-card-style").value,
      quizCount: Number($("#yta-quiz-count").value) || 5
    };
    const label = mode === "notes" ? "Study notes" : mode === "map" ? "Mind map"
      : mode === "quiz" ? `Quiz: ${fields.quizCount} questions`
      : `Flashcards: ${fields.cardCount} ${fields.cardStyle === "qa" ? "questions" : "terms"}`;
    await ask(buildTask(mode, fields), label, cfg.language, builtinReady,
      { cards: mode === "cards" ? fields.cardCount : 0, quiz: mode === "quiz" ? fields.quizCount : 0, notes: mode === "notes", map: mode === "map" });
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

  async function ask(userContent, displayLabel, language, builtinReady, { cards = 0, quiz = 0, notes = false, map = false } = {}) {
    // Bound to the tab it was asked from, even if the student switches tabs while it's answering.
    const to = box(), messages = state.threads[state.mode];
    const configured = await chrome.runtime.sendMessage({ type: "isConfigured" });
    if (!configured?.ok) {
      addMessage("assistant", "**No AI is set up.** Click ⚙ and choose Chrome built-in AI (free, no key) or add an API key.", { to });
      return;
    }
    state.busy = true;
    $("#yta-run").disabled = true;
    addMessage("user", displayLabel, { to });
    const pending = addMessage("assistant", "", { pending: true, to });
    try {
      const builtin = configured.provider === "builtin";
      const builtinOpts = builtin ? await builtinReady : null; // model ready before the slower caption fetch
      const ctx = await ensureContext();
      if ((cards || quiz || map) && !ctx.transcript) {
        pending.remove();
        addMessage("assistant", `${cards ? "Flashcards" : quiz ? "Quizzes" : "Mind maps"} need the video's captions, and none could be read for this video.`, { to });
        return;
      }
      messages.push({ role: "user", content: userContent, label: displayLabel });
      const thread = $("#yta-thread");
      let frame = 0, latest = "";
      const onDelta = (text) => {
        latest = text;
        if (cards || quiz || map) return; // the reply is JSON; keep the dots until it's turned into cards, a quiz or a map
        // Re-render at most once per frame; only follow the bottom if the reader is already there.
        frame ||= requestAnimationFrame(() => {
          frame = 0;
          const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
          fillAssistant(pending, latest, { streaming: true });
          if (atBottom) thread.scrollTop = thread.scrollHeight;
        });
      };
      const res = builtin
        ? await builtinChat(ctx, language, messages, onDelta, builtinOpts).then(
            (text) => ({ ok: true, text }),
            (e) => ({ ok: false, error: builtinError(e), partial: latest }))
        : await sendChat(buildSystem(ctx, language), messages, onDelta);
      cancelAnimationFrame(frame);
      if (!res?.ok) {
        messages.pop();
        if (res?.partial && !cards && !quiz && !map) fillAssistant(pending, res.partial);
        else pending.remove();
        addMessage("assistant", builtin ? res.error : `**Error:** ${res?.error || "unknown"}\n\nCheck your key and model in ⚙ settings.`, { to });
        return;
      }
      if (map) {
        const tree = parseMindMap(res.text, ctx.lengthSeconds);
        if (!tree) {
          messages.pop();
          pending.remove();
          addMessage("assistant", "Couldn't read a mind map from the AI's answer. Press the button to try again.", { to });
          return;
        }
        const content = mindMapMarkdown(tree);
        messages.push({ role: "assistant", content, map: tree });
        fillAssistant(pending, content, { map: tree });
        saveHistory();
        setStatus("Mind map ready", "yta-ok");
        return;
      }
      if (cards || quiz) {
        const items = cards ? parseCards(res.text, cards, ctx.lengthSeconds) : parseQuiz(res.text, quiz, ctx.lengthSeconds);
        if (!items.length) {
          messages.pop();
          pending.remove();
          addMessage("assistant", `Couldn't read ${cards ? "flashcards" : "a quiz"} from the AI's answer. Press the button to try again.`, { to });
          return;
        }
        const content = cards ? cardsMarkdown(items) : quizMarkdown(items);
        messages.push({ role: "assistant", content, ...(cards ? { cards: items } : { quiz: items }) });
        fillAssistant(pending, content, cards ? { cards: items } : { quiz: items });
        saveHistory();
        if (cards) {
          const added = await addToDeck(items);
          setStatus(added ? `${added} cards added to review` : `${items.length} flashcards ready`, "yta-ok");
        } else setStatus("Quiz ready", "yta-ok");
        return;
      }
      messages.push({ role: "assistant", content: res.text, ...(notes ? { notes: true } : {}) });
      fillAssistant(pending, res.text, { notes });
      saveHistory();
      setStatus(builtin ? "On-device AI" : configured.model, "yta-ok");
    } catch (e) {
      pending.remove();
      addMessage("assistant", builtinError(e), { to });
    } finally {
      state.busy = false;
      $("#yta-run").disabled = false;
    }
  }

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

  const cardsAsText = (cards) => globalThis.StudyPal.cardsText(cards, state.videoId);

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

  // ---------- Notes PDF ----------
  // No PDF library: notes.html (an extension page) lays the notes out for print and opens Chrome's print
  // dialog, where "Save as PDF" makes the file. Timestamps become links to that moment of the video.
  async function saveNotesPdf(content) {
    if (!alive()) return;
    const body = renderMarkdown(content);
    body.querySelectorAll("a.yta-ts").forEach((a) => {
      a.href = `https://www.youtube.com/watch?v=${state.videoId}&t=${parseTime(a.dataset.t)}s`;
      a.removeAttribute("class");
      a.removeAttribute("data-t");
    });
    await chrome.storage.local.set({ notesPdf: {
      title: state.ctx?.title || document.title.replace(/ - YouTube$/, ""), channel: state.ctx?.author || "",
      url: `https://www.youtube.com/watch?v=${state.videoId}`, html: body.innerHTML, at: Date.now()
    } });
    chrome.runtime.sendMessage({ type: "openNotesPdf" });
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
    state.boxes[state.mode].append(box);
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

  // ---------- Courses: a playlist studied in order ----------
  // course:<listId> = { listId, title, channel, videos: [{ id, title, length }], done: { videoId: true }, started, updated }

  const courseKey = (listId) => `course:${listId}`;

  // The playlist this video is being watched from. Mixes (RD...), Watch later and Liked aren't courses.
  function getListId() {
    const list = new URL(location.href).searchParams.get("list");
    return list && !/^(RD|WL$|LL$|LM$)/.test(list) ? list : null;
  }

  const courseUrl = (course, videoId) => `https://www.youtube.com/watch?v=${videoId}&list=${encodeURIComponent(course.listId)}`;

  // Videos from a playlist page's ytInitialData. YouTube has used two shapes: playlistVideoRenderer and
  // the newer lockupViewModel; walk the whole object so either (or both) are found.
  // ponytail: only the first page of the playlist (~100 videos); follow the continuation for longer ones.
  function parsePlaylist(html) {
    let data;
    try { data = JSON.parse(String(html).match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1]); } catch { return null; }
    if (!data) return null;
    const videos = [], seen = new Set();
    const add = (id, title, length) => {
      if (!/^[\w-]{11}$/.test(id || "") || seen.has(id)) return;
      seen.add(id);
      videos.push({ id, title: String(title || "Untitled video").trim(), length: Number(length) || 0 });
    };
    let channel = "";
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      const r = o.playlistVideoRenderer;
      if (r) add(r.videoId, r.title?.runs?.[0]?.text || r.title?.simpleText, r.lengthSeconds);
      const l = o.lockupViewModel;
      if (l?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
        const meta = l.metadata?.lockupMetadataViewModel;
        const dur = JSON.stringify(l.contentImage || {}).match(/"text":"(\d{1,2}(?::\d{2}){1,2})"/)?.[1];
        add(l.contentId, meta?.title?.content, dur ? parseTime(dur) : 0);
        channel ||= meta?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || "";
      }
      for (const k in o) if (k !== "playlistVideoRenderer" && k !== "lockupViewModel") walk(o[k]);
    })(data);
    const title = data.metadata?.playlistMetadataRenderer?.title || "Playlist";
    return videos.length ? { title, channel, videos } : null;
  }

  async function fetchPlaylist(listId) {
    const res = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}&hl=en`, { credentials: "include" });
    return parsePlaylist(await res.text());
  }

  const courseProgress = (course) => course.videos.filter((v) => course.done[v.id]).length;
  // The first unfinished video after this one, else the first unfinished one at all.
  function nextInCourse(course, currentId) {
    const i = course.videos.findIndex((v) => v.id === currentId);
    const after = [...course.videos.slice(i + 1), ...course.videos.slice(0, Math.max(0, i))];
    return after.find((v) => !course.done[v.id]) || null;
  }

  const playlistPreview = new Map(); // listId -> playlist, so the offer doesn't refetch on every video

  async function syncCourse() {
    const bar = $("#yta-course");
    const listId = getListId();
    if (!bar || !alive()) return;
    if (!listId) { bar.hidden = true; return; }
    const course = (await chrome.storage.local.get(courseKey(listId)))[courseKey(listId)];
    if (state?.listId !== listId) return;
    if (course) return renderCourse(bar, course);
    // Not started: offer it once we know the playlist (fetched once per page session).
    let pl = playlistPreview.get(listId);
    if (pl === undefined) {
      pl = await fetchPlaylist(listId).catch(() => null);
      playlistPreview.set(listId, pl);
    }
    if (!pl || pl.videos.length < 2 || state?.listId !== listId) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.replaceChildren(
      el("div", { class: "yta-course-row" }, icon("library", 16),
        el("span", { class: "yta-course-text" }, "Part of ", el("strong", { text: pl.title }), ` (${pl.videos.length} videos)`)),
      el("button", { class: "yta-primary yta-course-start", onclick: () => startCourse(listId, pl) }, icon("spark", 15), el("span", { text: "Study as a course" })));
  }

  async function startCourse(listId, pl) {
    if (!alive()) return;
    const course = { listId, title: pl.title, channel: pl.channel, videos: pl.videos, done: {}, started: Date.now(), updated: Date.now() };
    await chrome.storage.local.set({ [courseKey(listId)]: course });
    setStatus("Course started", "yta-ok");
    syncCourse();
  }

  async function setDone(listId, videoId, done) {
    if (!alive()) return;
    const key = courseKey(listId);
    const course = (await chrome.storage.local.get(key))[key];
    if (!course || !!course.done[videoId] === done) return;
    if (done) course.done[videoId] = true; else delete course.done[videoId];
    course.updated = Date.now();
    await chrome.storage.local.set({ [key]: course });
    if (state?.listId === listId) renderCourse($("#yta-course"), course);
  }

  function renderCourse(bar, course) {
    bar.hidden = false;
    const n = courseProgress(course), total = course.videos.length;
    const here = course.videos.findIndex((v) => v.id === state.videoId);
    const done = !!course.done[state.videoId];
    const next = nextInCourse(course, state.videoId);
    const list = el("ol", { class: "yta-course-list", hidden: "" }, ...course.videos.map((v, i) =>
      el("li", { class: `${course.done[v.id] ? "yta-done" : ""} ${i === here ? "yta-here" : ""}` },
        el("span", { class: "yta-check", "aria-label": course.done[v.id] ? "Done" : "Not done yet" }, course.done[v.id] ? "✓" : String(i + 1)),
        el("a", { href: courseUrl(course, v.id), text: v.title }),
        v.length ? el("small", { text: fmtTime(v.length) }) : null)));
    const toggle = el("button", { class: "yta-icon yta-course-toggle", "aria-expanded": "false", title: "Show all videos", "aria-label": "Show all videos" }, icon("chevron", 16));
    toggle.addEventListener("click", () => {
      list.hidden = !list.hidden;
      toggle.setAttribute("aria-expanded", String(!list.hidden));
    });
    bar.replaceChildren(
      el("div", { class: "yta-course-row" }, icon("library", 16),
        el("span", { class: "yta-course-text" }, el("strong", { text: course.title })),
        el("span", { class: "yta-course-count", text: `${n} of ${total}` }), toggle),
      el("div", { class: "yta-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": String(n), "aria-label": "Course progress" },
        el("span", { style: `width:${Math.round((n / total) * 100)}%` })),
      el("div", { class: "yta-course-actions" },
        here >= 0 ? el("button", { class: "yta-secondary", onclick: () => setDone(course.listId, state.videoId, !done) }, done ? "✓ Done" : "Mark done") : null,
        next ? el("a", { class: "yta-primary", href: courseUrl(course, next.id) }, el("span", { text: here >= 0 ? "Next video" : "Continue" }), icon("play", 13))
          : el("span", { class: "yta-course-finished", text: n === total ? "Course complete. Nice work!" : "" })),
      list);
  }

  // Watching 90% of a course video marks it done.
  document.addEventListener("timeupdate", (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !state?.listId || $(".ad-showing")) return;
    if (v.duration > 30 && v.currentTime / v.duration >= 0.9 && !state.markedDone) {
      state.markedDone = true;
      setDone(state.listId, state.videoId, true);
    }
  }, true);
  chrome.storage.onChanged.addListener((changes) => {
    if (state?.listId && courseKey(state.listId) in changes) syncCourse();
  });

  // ---------- History ----------
  // ponytail: one key per video, never evicted; add LRU pruning if chrome.storage.local (10 MB) fills up.

  const historyKey = (videoId) => `chat:${videoId}`;
  const emptyThreads = () => ({ chat: [], notes: [], cards: [], quiz: [] });

  // The library (library.js) lists every video with a saved history, using these details.
  function saveHistory() {
    const ctx = state.ctx || {};
    chrome.storage.local.set({
      [historyKey(state.videoId)]: state.threads,
      [`video:${state.videoId}`]: { title: ctx.title || document.title.replace(/ - YouTube$/, ""), author: ctx.author || "", lengthSeconds: ctx.lengthSeconds || 0, updated: Date.now() }
    });
  }

  function openLibrary() {
    if (alive()) chrome.runtime.sendMessage({ type: "openLibrary", videoId: state?.videoId });
  }

  // Older versions saved one combined list: sort each exchange into the tab it came from.
  function splitThreads(list) {
    const threads = emptyThreads();
    let tab = "chat";
    list.forEach((m, i) => {
      if (m.role === "user") {
        const a = list[i + 1];
        tab = a?.cards ? "cards" : a?.quiz ? "quiz" : a?.notes || a?.map ? "notes" : "chat";
      }
      threads[tab].push(m);
    });
    return threads;
  }

  async function restoreHistory(videoId) {
    if (!alive()) return;
    const saved = (await chrome.storage.local.get(historyKey(videoId)))[historyKey(videoId)];
    if (!saved || state?.videoId !== videoId || Object.values(state.threads).some((t) => t.length)) return;
    state.threads = { ...emptyThreads(), ...(Array.isArray(saved) ? splitThreads(saved) : saved) };
    for (const [tab, list] of Object.entries(state.threads)) {
      for (const m of list) {
        addMessage(m.role, m.role === "user" ? m.label || m.content : m.content, { cards: m.cards, quiz: m.quiz, notes: m.notes, map: m.map, to: box(tab) });
      }
    }
  }

  // Clears the open tab's thread only.
  function clearHistory() {
    if (!alive()) return;
    if (state.busy) return;
    state.threads[state.mode] = [];
    box().replaceChildren();
    saveHistory();
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
    state = { videoId, listId: getListId(), markedDone: false, mode: "chat", ctx: null, ctxPromise: null, threads: emptyThreads(), boxes: {}, busy: false };

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
      syncUpsell();
      syncCourse();
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
