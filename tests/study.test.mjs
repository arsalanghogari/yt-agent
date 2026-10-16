// Quiz parsing and the daily-review scheduler in content.js.
import fs from "fs"; import vm from "vm"; import assert from "assert";
const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const grab = (re) => src.match(re)[0];
const code = [
  grab(/  function fmtTime\([\s\S]*?\n  }\n/), grab(/  function parseTime\([\s\S]*?\n  }\n/),
  grab(/  const toSeconds = .*\n/),
  src.slice(src.indexOf("  // The JSON array in a model reply"), src.indexOf("  function parseCards(")),
  src.slice(src.indexOf("  // ---------- Quiz ----------"), src.indexOf("  function renderQuiz(")),
  src.slice(src.indexOf("  const DECK_KEY ="), src.indexOf("  async function loadDeck()")),
  grab(/  const emptyThreads = .*\n/), grab(/  function splitThreads\([\s\S]*?\n  }\n/)
].join("\n") + "\nthis.api = { parseQuiz, quizMarkdown, mergeIntoDeck, schedule, dueCards, DAY, splitThreads };";
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
const { parseQuiz, quizMarkdown, mergeIntoDeck, schedule, dueCards, DAY, splitThreads } = ctx.api;

// --- quiz: answers given as index, letter or text; bad questions dropped; timestamps stripped; shuffled
const reply = `Here's your quiz:
[{"question":"What does Cas9 do? [3:36]","choices":["Cuts DNA","Copies RNA","Makes protein","Stores energy"],"answer":0,"explanation":"It cuts DNA where the guide RNA points (3:36).","time":"3:36"},
 {"question":"Why is the therapy expensive?","choices":["Cells are edited outside the body","It uses rare metals","Patents","Shipping"],"answer":"A","explanation":"Ex vivo processing and hospital stays.","time":"6:39"},
 {"question":"What is a gene drive?","choices":["A storage device","A way to spread a gene through a population"],"answer":"A way to spread a gene through a population","time":"19:47"},
 {"question":"No valid answer","choices":["a","b"],"answer":7},
 {"question":"Too few choices","choices":["only"],"answer":0},
 {"question":"Over the limit","choices":["x","y"],"answer":1}]`;
let n = 0; const fixed = () => [0.1, 0.9, 0.5, 0.3][n++ % 4]; // deterministic shuffle
const quiz = parseQuiz(reply, 3, 3600, fixed);
assert.equal(quiz.length, 3, "invalid questions dropped, capped at 3");
assert.equal(quiz[0].question, "What does Cas9 do?", "timestamp stripped from the question");
assert.equal(quiz[0].explanation, "It cuts DNA where the guide RNA points.");
for (const [q, right] of [[quiz[0], "Cuts DNA"], [quiz[1], "Cells are edited outside the body"], [quiz[2], "A way to spread a gene through a population"]]) {
  assert.equal(q.choices[q.answer], right, "answer still points at the right choice after shuffling");
}
assert.equal(quiz[0].t, 216);
// the shuffle actually moves the right answer off the first slot sometimes
const positions = new Set();
for (let i = 0; i < 40; i++) positions.add(parseQuiz(reply, 1)[0].answer);
assert.ok(positions.size > 1, "right answer isn't always first");
assert.match(quizMarkdown(quiz), /1\. What does Cas9 do\? Answer: Cuts DNA\. It cuts DNA/);
assert.equal(parseQuiz("Sorry.", 5).length, 0);

// --- deck: new cards due now, duplicates (same video + front) skipped, other videos kept apart
const now = 1_000_000_000_000;
let { deck, added } = mergeIntoDeck([], [{ front: "Cas9", back: "Cuts DNA", t: 216 }, { front: "Gene drive", back: "Spreads a gene" }], { id: "vidA", title: "CRISPR" }, now);
assert.equal(added, 2); assert.equal(deck[0].due, now); assert.equal(deck[0].videoTitle, "CRISPR"); assert.equal(deck[1].t, undefined);
({ deck, added } = mergeIntoDeck(deck, [{ front: "cas9", back: "again" }, { front: "New one", back: "x" }], { id: "vidA", title: "CRISPR" }, now));
assert.equal(added, 1, "case-insensitive duplicate skipped");
({ deck, added } = mergeIntoDeck(deck, [{ front: "Cas9", back: "Other video" }], { id: "vidB", title: "Other" }, now));
assert.equal(added, 1, "same front on another video is a different card");

// --- scheduling: Good = 1 day, 3 days, then x ease; Again = 10 minutes and start over; Easy = longer, easier
let c = deck[0];
c = schedule(c, "good", now); assert.equal(c.interval, 1); assert.equal(c.due, now + DAY);
c = schedule(c, "good", now); assert.equal(c.interval, 3);
c = schedule(c, "good", now); assert.equal(c.interval, 8, "3 x 2.5 rounded");
const again = schedule(c, "again", now);
assert.equal(again.reps, 0); assert.equal(again.due, now + 10 * 60 * 1000); assert.ok(Math.abs(again.ease - 2.3) < 1e-9);
const easy = schedule(deck[1], "easy", now);
assert.equal(easy.interval, 2, "first Easy: 2 days, not 1"); assert.ok(Math.abs(easy.ease - 2.65) < 1e-9);
assert.ok(schedule({ ...again, ease: 1.3 }, "again", now).ease >= 1.3, "ease never drops below 1.3");

// --- due: only cards whose time has come, oldest first
const due = dueCards([{ id: "a", due: now + 1 }, { id: "b", due: now - 5 }, { id: "c", due: now - 50 }], now);
assert.deepEqual(due.map((x) => x.id), ["c", "b"]);
// --- old saved chats (one combined list) are sorted into each tab's thread
const old = [
  { role: "user", content: "What is Cas9?" }, { role: "assistant", content: "An enzyme." },
  { role: "user", content: "notes task" }, { role: "assistant", content: "## Notes", notes: true },
  { role: "user", content: "cards task" }, { role: "assistant", content: "cards", cards: [{ front: "a", back: "b" }] },
  { role: "user", content: "quiz task" }, { role: "assistant", content: "quiz", quiz: [{}] },
  { role: "user", content: "follow-up on the quiz" }, { role: "assistant", content: "answer" }
];
const split = splitThreads(old);
assert.deepEqual(Object.fromEntries(Object.entries(split).map(([k, v]) => [k, v.length])), { chat: 4, notes: 2, cards: 2, quiz: 2 });
console.log("study checks passed");
