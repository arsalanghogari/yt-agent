// Chrome built-in AI path in content.js, against a fake LanguageModel: download/availability errors,
// language fallback, long-transcript condensing, both streaming styles, provider fallback.
import fs from "fs"; import vm from "vm"; import assert from "assert";
const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const block = src.slice(src.indexOf("  const effectiveProvider ="), src.indexOf("  // ---------- Rendering ----------"));
const statuses = [];
let windowSize = 1000, created = [], streamMode = "delta", availability = "available", createFails = null;
class FakeSession {
  constructor(o) { this.o = o; this.contextWindow = windowSize; this.destroyed = false; created.push(this); }
  async measureContextUsage(t) { return Math.ceil(t.length / 4); }
  async prompt(t) { return t.split("\n").filter((_, i) => i % 3 === 0).map((l) => l.slice(0, 30)).join("\n"); }
  async *promptStreaming() {
    const parts = ["Hello ", "world", "!"];
    if (streamMode === "delta") yield* parts; else { let acc = ""; for (const p of parts) yield (acc += p); }
  }
  destroy() { this.destroyed = true; }
}
const ctx = {
  chrome: { storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } } },
  LanguageModel: { create: async (o) => { if (createFails) throw createFails; return new FakeSession(o); }, availability: async () => availability },
  document: { getElementById: () => null },
  setStatus: (t) => statuses.push(t), buildSystem: (c, lang) => `SYSTEM[${lang}]\n${c.transcript}`, console, Error, Promise, Math, Set
};
vm.createContext(ctx);
vm.runInContext(block + "\nthis.api = { effectiveProvider, startBuiltin, fitForBuiltin, builtinChat, builtinError, builtinOptions, BuiltinUnavailable };", ctx);
const api = ctx.api;

// provider fallback: an incomplete provider means the built-in AI
assert.equal(api.effectiveProvider({}), "builtin");
assert.equal(api.effectiveProvider({ provider: "openai", model: "gpt-4o" }), "builtin", "no key");
assert.equal(api.effectiveProvider({ provider: "openai", apiKey: "k", model: "gpt-4o" }), "openai");
assert.equal(api.effectiveProvider({ provider: "custom", model: "m", baseUrl: "http://localhost:11434/v1" }), "custom");

assert.deepEqual([...api.builtinOptions("Spanish").expectedOutputs[0].languages], ["es"]);
assert.deepEqual([...api.builtinOptions("Klingon").expectedOutputs[0].languages], ["en"]);

// short transcript used as-is; long one condensed, cached, every session destroyed
assert.equal((await api.fitForBuiltin({ transcript: "[0:00] short" }, {})).transcript, "[0:00] short");
const long = Array.from({ length: 400 }, (_, i) => `[${Math.floor(i / 3)}:${String((i * 20) % 60).padStart(2, "0")}] some spoken words that go on for a while here`).join("\n");
created = []; const c = { transcript: long };
const fitted = await api.fitForBuiltin(c, {});
assert.ok(fitted.transcript.startsWith("(Condensed notes"));
assert.ok(fitted.transcript.length / 4 <= windowSize * 0.5, "fits the budget");
assert.ok(statuses.some((s) => /part 1 of \d+/.test(s)), "shows progress");
assert.ok(created.every((s) => s.destroyed));
const n = created.length; await api.fitForBuiltin(c, {}); assert.equal(created.length, n, "cached");

// streaming: delta and cumulative chunks give the same text; history passed, last question prompted
for (streamMode of ["delta", "cumulative"]) {
  const seen = [];
  const text = await api.builtinChat({ transcript: "[0:00] hi" }, "English",
    [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }], (t) => seen.push(t));
  assert.equal(text, "Hello world!"); assert.deepEqual(seen, ["Hello ", "Hello world", "Hello world!"]);
  assert.deepEqual(created.at(-1).o.initialPrompts.map((m) => m.role), ["system", "user", "assistant"]);
}

// errors: missing API, unsupported computer, lost click; language not available falls back to English
const saved = ctx.LanguageModel; ctx.LanguageModel = undefined;
await assert.rejects(api.startBuiltin("English"), (e) => e instanceof api.BuiltinUnavailable && /version of Chrome/.test(e.message));
ctx.LanguageModel = saved;
createFails = Object.assign(new Error("no"), { name: "NotSupportedError" }); availability = "unavailable";
await assert.rejects(api.startBuiltin("English"), (e) => e instanceof api.BuiltinUnavailable && /22 GB/.test(e.message));
createFails = Object.assign(new Error("gesture"), { name: "NotAllowedError" }); availability = "downloadable";
await assert.rejects(api.startBuiltin("English"), (e) => e.name === "NotAllowedError");
assert.match(api.builtinError(createFails), /Press Go again/);
assert.match(api.builtinError(Object.assign(new Error("x"), { name: "QuotaExceededError" })), /🗑/);
createFails = null; availability = "unavailable";
const sp = await api.startBuiltin("Spanish");
assert.deepEqual([...sp.expectedOutputs[0].languages], ["en"], "Spanish unavailable -> English, not 'unsupported computer'");
console.log("built-in AI checks passed");
