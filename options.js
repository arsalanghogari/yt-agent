const MODEL_SUGGESTIONS = {
  anthropic: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
  custom: ["llama3.1", "qwen2.5", "mistral"]
};

const KEY_HINTS = {
  anthropic: 'Get one at console.anthropic.com. Calls are made directly from your browser.',
  openai: 'Get one at platform.openai.com/api-keys.',
  gemini: 'Get one at aistudio.google.com/apikey (free tier available).',
  custom: 'Leave blank if your endpoint does not need a key (e.g. local Ollama).'
};

const DEFAULTS = {
  provider: "builtin",
  apiKey: "",
  model: "",
  baseUrl: "",
  analogyDomain: "",
  persona: "",
  language: "English",
  maxTokens: 1500
};

const $ = (id) => document.getElementById(id);

function fillModelList(provider) {
  const dl = $("modelList");
  dl.innerHTML = "";
  for (const m of MODEL_SUGGESTIONS[provider] || []) {
    const o = document.createElement("option");
    o.value = m;
    dl.appendChild(o);
  }
  $("keyHint").textContent = KEY_HINTS[provider] || "";
  $("customUrlWrap").classList.toggle("hidden", provider !== "custom");
  $("keyModelWrap").classList.toggle("hidden", provider === "builtin");
  $("builtinHint").classList.toggle("hidden", provider !== "builtin");
}

function readForm() {
  return {
    provider: $("provider").value,
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    baseUrl: $("baseUrl").value.trim().replace(/\/+$/, ""),
    analogyDomain: $("analogyDomain").value.trim(),
    persona: $("persona").value.trim(),
    language: $("language").value.trim() || "English",
    maxTokens: Math.max(200, Math.min(8000, Number($("maxTokens").value) || 1500))
  };
}

function setStatus(msg, ok = true) {
  const s = $("status");
  s.textContent = msg;
  s.style.color = ok ? "" : "#e62117";
}

// AI provider hosts are optional permissions, so the install prompt only lists youtube.com.
// Access to the one provider the user picks is requested when they save or test.
const PROVIDER_URLS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com"
};

async function ensureHostPermission(baseUrl) {
  if (!baseUrl) return true;
  let origin;
  try { origin = new URL(baseUrl).origin + "/*"; } catch { return false; }
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (has) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function load() {
  const cfg = Object.assign({}, DEFAULTS, await chrome.storage.local.get(Object.keys(DEFAULTS)));
  $("provider").value = cfg.provider;
  fillModelList(cfg.provider);
  $("apiKey").value = cfg.apiKey;
  $("model").value = cfg.model || MODEL_SUGGESTIONS[cfg.provider]?.[0] || "";
  $("baseUrl").value = cfg.baseUrl;
  $("analogyDomain").value = cfg.analogyDomain;
  $("persona").value = cfg.persona;
  $("language").value = cfg.language;
  $("maxTokens").value = cfg.maxTokens;
}

$("provider").addEventListener("change", () => {
  const p = $("provider").value;
  fillModelList(p);
  $("model").value = MODEL_SUGGESTIONS[p]?.[0] || "";
});

$("save").addEventListener("click", async () => {
  const cfg = readForm();
  if (cfg.provider === "builtin") {
    await chrome.storage.local.set(cfg);
    return setStatus("Saved. Open any YouTube video and press Go.");
  }
  if (cfg.provider === "custom") {
    if (!cfg.baseUrl) return setStatus("Base URL is required for a custom endpoint.", false);
  } else if (!cfg.apiKey) {
    return setStatus("API key is required.", false);
  }
  if (!cfg.model) return setStatus("Model id is required.", false);
  if (!(await ensureHostPermission(cfg.baseUrl || PROVIDER_URLS[cfg.provider]))) {
    return setStatus("Chrome needs your permission to reach that provider. Click Save again and choose Allow.", false);
  }
  await chrome.storage.local.set(cfg);
  setStatus("Saved.");
});

// Chrome's on-device model. create() is called straight from the click, because Chrome only starts the
// one-time model download right after a user gesture.
async function testBuiltin() {
  if (typeof LanguageModel === "undefined") {
    return setStatus("This version of Chrome doesn't include built-in AI. Update Chrome, or pick a provider with an API key.", false);
  }
  const opts = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
  setStatus("Starting Chrome's AI model...");
  try {
    const session = await LanguageModel.create({
      ...opts,
      monitor: (m) => m.addEventListener("downloadprogress", (e) =>
        setStatus(`Downloading Chrome's AI model (one time only)... ${Math.round(e.loaded * 100)}%`))
    });
    const reply = await session.prompt("Reply with exactly: OK");
    session.destroy();
    setStatus(`Works on this computer. Model replied: "${reply.trim().slice(0, 40)}"`);
  } catch (e) {
    const a = await LanguageModel.availability(opts).catch(() => "unavailable");
    setStatus(a === "unavailable"
      ? "This computer doesn't meet the requirements for Chrome's built-in AI. Pick a provider with an API key instead."
      : "Failed: " + (e?.message || e), false);
  }
}

$("test").addEventListener("click", async () => {
  if ($("provider").value === "builtin") return testBuiltin();
  const cfg = readForm();
  if (!(await ensureHostPermission(cfg.provider === "custom" ? cfg.baseUrl : PROVIDER_URLS[cfg.provider]))) {
    return setStatus("Chrome needs your permission to reach that provider. Click Test again and choose Allow.", false);
  }
  setStatus("Testing...");
  const res = await chrome.runtime.sendMessage({
    type: "chat",
    configOverride: cfg,
    system: "You are a connection test. Reply with exactly: OK",
    messages: [{ role: "user", content: "Say OK" }]
  });
  if (res && res.ok) setStatus(`Connected. Model replied: "${res.text.trim().slice(0, 40)}"`);
  else setStatus("Failed: " + (res && res.error ? res.error : "unknown error"), false);
});

load();
