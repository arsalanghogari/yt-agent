import fs from "fs"; import vm from "vm"; import assert from "assert";
const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const grab = (re) => src.match(re)[0];
const code = [
  grab(/  function fmtTime\([\s\S]*?\n  }\n/), grab(/  function parseTime\([\s\S]*?\n  }\n/),
  grab(/  const toSeconds = .*\n/),
  src.slice(src.indexOf("  function parseCards("), src.indexOf("  const setTitle ="))
].join("\n") + "\nthis.api = { parseCards, cardsMarkdown, cardsAsText };";
const ctx = { state: { videoId: "abc123XYZ_0" } }; vm.createContext(ctx); vm.runInContext(code, ctx);
const { parseCards, cardsMarkdown, cardsAsText } = ctx.api;

const answer = `Here are your cards:
[{"front":"Spaced repetition","back":"Reviewing at\\tgrowing intervals\\nso it sticks.","time":"4:32"},
 {"term":"Interleaving","definition":"Mixing topics in one session.","time":"9:05"},
 {"question":"Why test yourself?","answer":"Retrieval strengthens memory.","time":"99:99:99"},
 {"front":"spaced repetition","back":"duplicate","time":"5:00"},
 {"front":"","back":"no front"},
 {"front":"Fourth","back":"over the limit","time":"1:00"}]`;
const cards = parseCards(answer, 3, 1200);
assert.equal(cards.length, 3, "capped at the number asked for");
assert.deepEqual(cards.map((c) => c.front), ["Spaced repetition", "Interleaving", "Why test yourself?"], "alt field names; duplicate and empty dropped");
assert.equal(cards[0].back, "Reviewing at growing intervals so it sticks.", "tabs/newlines can't break the import format");
assert.equal(cards[0].t, 272); assert.equal(cards[2].t, undefined, "time past the end of the video dropped");

const text = cardsAsText(cards);
const lines = text.split("\n");
assert.equal(lines.length, 3, "one card per line");
assert.ok(lines.every((l) => l.split("\t").length === 2), "exactly one tab per line");
assert.equal(lines[0], "Spaced repetition\tReviewing at growing intervals so it sticks. (video at 4:32: youtu.be/abc123XYZ_0?t=272)");
assert.equal(lines[2], "Why test yourself?\tRetrieval strengthens memory.", "no link without a time");

const md = cardsMarkdown(cards);
assert.match(md, /^\*\*3 flashcards\*\*/);
assert.match(md, /1\. \*\*Spaced repetition\*\*: Reviewing .* \[4:32\]/);
assert.equal(parseCards("Sorry, I can't.", 10).length, 0);
assert.equal(parseCards('{"front":"x","back":"y"}', 10).length, 0);
console.log("flashcard checks passed");
