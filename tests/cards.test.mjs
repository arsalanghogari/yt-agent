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

// timestamps and links the model writes into the text are removed (the time is kept separately)
const dup = parseCards(JSON.stringify([
  { front: "What is Cas9?", back: "An enzyme that cuts DNA where guide RNA points it [3:36]. [3:36](https://www.youtube.com/watch?v=x#)", time: "3:36" },
  { front: "What is CRISPR? (1:19)", back: "A technology for altering DNA (1:19).", time: "1:19" }
]), 10, 3600);
assert.equal(dup[0].back, "A technology for altering DNA.", "sorted into video order, timestamps stripped");
assert.equal(dup[0].front, "What is CRISPR?");
assert.equal(dup[1].back, "An enzyme that cuts DNA where guide RNA points it.", "markdown timestamp links stripped");
assert.deepEqual(dup.map((c) => c.t), [79, 216]);
assert.ok(!/\d:\d\d/.test(cardsAsText(dup).replace(/\(video at [^)]*\)/g, "")), "only the one link-back time remains in the export");
// longer, specific answers are kept whole (no length cap in code)
const longBack = "x ".repeat(60).trim();
assert.equal(parseCards(JSON.stringify([{ front: "Q?", back: longBack }]), 5)[0].back, longBack);
console.log("flashcard checks passed");
