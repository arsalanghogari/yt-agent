// Background service worker: receives chat requests from the content script
// and routes them to whichever provider the user picked in settings.

const DEFAULTS = {
  provider: "anthropic",
  apiKey: "",
  model: "",
  baseUrl: "",
  language: "English",
  maxTokens: 1500
};

async function getConfig(override) {
  if (override) return Object.assign({}, DEFAULTS, override);
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return Object.assign({}, DEFAULTS, stored);
}

async function readError(res) {
  let body = "";
  try { body = await res.text(); } catch {}
  try {
    const j = JSON.parse(body);
    body = j.error?.message || j.message || j.error || body;
    if (typeof body !== "string") body = JSON.stringify(body);
  } catch {}
  return `${res.status} ${res.statusText}: ${body.slice(0, 300)}`;
}

// Reads a streamed (SSE) response, calling onDelta for each text chunk, and returns the full text.
// pick(json) pulls the text out of one event. A plain JSON body (endpoint ignored stream:true)
// goes through pick once.
async function readStream(res, pick, onDelta) {
  let text = "";
  const emit = (j) => {
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const d = pick(j);
    if (d) { text += d; onDelta(d); }
  };
  if (!(res.headers.get("content-type") || "").includes("event-stream")) {
    emit(await res.json());
    return text;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      emit(JSON.parse(data));
    }
  }
  return text;
}

// ---------- Provider adapters ----------
// Each takes ({system, messages:[{role:'user'|'assistant', content}]}, cfg, onDelta) and returns the full text.

async function callAnthropic({ system, messages }, cfg, onDelta) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      stream: true,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content }))
    })
  });
  if (!res.ok) throw new Error(await readError(res));
  return readStream(res, (j) =>
    j.type === "content_block_delta" ? j.delta?.text
      : j.content ? j.content.filter((b) => b.type === "text").map((b) => b.text).join("") // non-streamed
      : "", onDelta);
}

async function callOpenAICompatible({ system, messages }, cfg, baseUrl, onDelta) {
  const headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const body = {
    model: cfg.model,
    messages: [{ role: "system", content: system }, ...messages],
    stream: true
  };
  // Newer OpenAI reasoning models reject max_tokens; use max_completion_tokens there.
  if (/^(o\d|gpt-5)/i.test(cfg.model)) body.max_completion_tokens = cfg.maxTokens;
  else body.max_tokens = cfg.maxTokens;

  const res = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await readError(res));
  const text = await readStream(res, (j) => {
    const c = j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content;
    return typeof c === "string" ? c : (c || []).map((p) => p.text || "").join("");
  }, onDelta);
  if (!text) throw new Error("Empty response from model.");
  return text;
}

async function callGemini({ system, messages }, cfg, onDelta) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(cfg.apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      })),
      generationConfig: { maxOutputTokens: cfg.maxTokens }
    })
  });
  if (!res.ok) throw new Error(await readError(res));
  let reason = null;
  const text = await readStream(res, (j) => {
    reason = j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || reason;
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  }, onDelta);
  if (!text) {
    throw new Error(reason ? `Model returned no text (${reason}).` : "Model returned no text.");
  }
  return text;
}

async function chat(req, cfg, onDelta = () => {}) {
  if (!cfg.model) throw new Error("No model set. Open the extension settings.");
  switch (cfg.provider) {
    case "anthropic":
      if (!cfg.apiKey) throw new Error("No Anthropic API key set.");
      return callAnthropic(req, cfg, onDelta);
    case "openai":
      if (!cfg.apiKey) throw new Error("No OpenAI API key set.");
      return callOpenAICompatible(req, cfg, "https://api.openai.com/v1", onDelta);
    case "gemini":
      if (!cfg.apiKey) throw new Error("No Gemini API key set.");
      return callGemini(req, cfg, onDelta);
    case "custom":
      if (!cfg.baseUrl) throw new Error("No base URL set for custom endpoint.");
      return callOpenAICompatible(req, cfg, cfg.baseUrl.replace(/\/+$/, ""), onDelta);
    default:
      throw new Error(`Unknown provider: ${cfg.provider}`);
  }
}

// ---------- Message routing ----------

// Streaming chat: the panel opens a port, sends one request, and gets {delta} messages then {done} or {error}.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat-stream") return;
  let closed = false;
  port.onDisconnect.addListener(() => { closed = true; });
  port.onMessage.addListener(async (msg) => {
    const post = (m) => { if (!closed) port.postMessage(m); };
    try {
      const cfg = await getConfig();
      const text = await chat({ system: msg.system, messages: msg.messages }, cfg, (delta) => post({ delta }));
      post({ done: true, text, provider: cfg.provider, model: cfg.model });
    } catch (e) {
      post({ error: e?.message || String(e) });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "chat") {
    (async () => {
      try {
        const cfg = await getConfig(msg.configOverride);
        const text = await chat({ system: msg.system, messages: msg.messages }, cfg);
        sendResponse({ ok: true, text, provider: cfg.provider, model: cfg.model });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true; // keep the channel open for the async response
  }
  if (msg?.type === "openOptions") {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "isConfigured") {
    (async () => {
      const cfg = await getConfig();
      const ok = !!cfg.model && (cfg.provider === "custom" ? !!cfg.baseUrl : !!cfg.apiKey);
      sendResponse({ ok, provider: cfg.provider, model: cfg.model });
    })();
    return true;
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});
