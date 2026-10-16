// Mind map parsing and the flashcard export format in render.js.
import fs from "fs"; import vm from "vm"; import assert from "assert";
const ctx = { globalThis: {}, document: undefined };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL("../render.js", import.meta.url), "utf8"), ctx);
const { parseMindMap, mindMapMarkdown, cardsText } = ctx.StudyPal;

const reply = `Here's the map: {"topic":"How CRISPR works [0:00]","branches":[
  {"label":"Cutting DNA","time":"3:36","points":[{"label":"Cas9 is the scissors","time":"3:36"},"Guide RNA sets the target",{"label":""}]},
  {"label":"Therapies","time":"6:39","points":[{"label":"Cells edited outside the body","time":"99:99:99"}]},
  {"label":"","points":[]}
]} Hope it helps.`;
const map = parseMindMap(reply, 1980);
assert.equal(map.topic, "How CRISPR works", "timestamp stripped from labels");
assert.equal(map.branches.length, 2, "empty branch dropped");
assert.deepEqual(map.branches[0].points.map((p) => p.label), ["Cas9 is the scissors", "Guide RNA sets the target"], "plain-string points accepted, empty dropped");
assert.equal(map.branches[0].t, 216);
assert.equal(map.branches[1].points[0].t, undefined, "time past the end dropped");
assert.match(mindMapMarkdown(map), /^\*\*Mind map: How CRISPR works\*\*\n\n- \*\*Cutting DNA\*\* \[3:36\]\n  - Cas9 is the scissors \[3:36\]/);
assert.equal(parseMindMap("Sorry, I can't."), null);
assert.equal(parseMindMap('{"topic":"x","branches":[{"label":"only one"}]}'), null, "needs at least two branches");

assert.equal(cardsText([{ front: "Cas9", back: "Cuts DNA.", t: 216 }, { front: "RNA", back: "Guide." }], "vid"),
  "Cas9\tCuts DNA. (video at 3:36: youtu.be/vid?t=216)\nRNA\tGuide.");
console.log("render checks passed");
