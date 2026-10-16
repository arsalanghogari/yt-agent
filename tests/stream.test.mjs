// Streaming (SSE) parsing for every provider, plus the missing-permission guard, against background.js.
import fs from "fs"; import vm from "vm"; import assert from "assert";
const noop = { addListener() {} };
let granted = true;
const ctx = {
  chrome: { permissions: { contains: async () => granted }, runtime: { onMessage: noop, onConnect: noop, openOptionsPage() {} },
    action: { onClicked: noop }, tabs: { create() {} }, storage: { local: { get: async () => ({}) } } },
  fetch: null, Response, TextDecoderStream, URL, JSON, console, encodeURIComponent
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL("../background.js", import.meta.url), "utf8"), ctx);
const sse = (events) => {
  const body = events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\r\n\r\n`).join("");
  const chunks = body.match(/.{1,7}/gs); // split mid-line to exercise buffering
  return new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(new TextEncoder().encode(x))); c.close(); } }),
    { headers: { "content-type": "text/event-stream" } });
};
async function run(provider, res) {
  ctx.fetch = async () => res; const deltas = [];
  const text = await ctx.chat({ system: "s", messages: [{ role: "user", content: "hi" }] },
    { provider, apiKey: "k", model: "m", baseUrl: "http://localhost:11434/v1", maxTokens: 10 }, (d) => deltas.push(d));
  return { text, deltas };
}
const r = await run("anthropic", sse([{ type: "content_block_delta", delta: { text: "Hel" } }, { type: "content_block_delta", delta: { text: "lo" } }]));
assert.equal(r.text, "Hello"); assert.deepEqual(r.deltas, ["Hel", "lo"]);
assert.equal((await run("openai", sse([{ choices: [{ delta: { content: "A" } }] }, { choices: [{ delta: { content: "B" } }] }, "[DONE]"]))).text, "AB");
assert.equal((await run("gemini", sse([{ candidates: [{ content: { parts: [{ text: "G" }] } }] }]))).text, "G");
assert.equal((await run("custom", new Response(JSON.stringify({ choices: [{ message: { content: "plain" } }] }),
  { headers: { "content-type": "application/json" } }))).text, "plain", "non-streaming endpoint");
await assert.rejects(run("anthropic", sse([{ type: "error", error: { message: "overloaded" } }])), /overloaded/);
await assert.rejects(run("gemini", sse([{ candidates: [{ finishReason: "SAFETY" }] }])), /SAFETY/);
granted = false;
await assert.rejects(run("openai", sse(["[DONE]"])), /doesn't have access to https:\/\/api\.openai\.com.*click Save/);
await assert.rejects(run("custom", sse(["[DONE]"])), /http:\/\/localhost:11434/);
console.log("stream checks passed");
