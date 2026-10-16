import fs from "fs"; import vm from "vm"; import assert from "assert";
const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const grab = (re) => src.match(re)[0];
const code = [
  "const MAX_TRANSCRIPT_CHARS = 120000;",
  grab(/  function fmtTime\([\s\S]*?\n  }\n/), grab(/  function parseTime\([\s\S]*?\n  }\n/),
  grab(/  function buildTimeline\([\s\S]*?\n  }\n/),
  src.slice(src.indexOf("  const toSeconds ="), src.indexOf("  let activeCut = null;"))
].join("\n") + "\nthis.api = { parseCut, cutMarkdown, fmtDuration, buildTimeline, withSentenceTranscript, findPhrase };";
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
const { parseCut, cutMarkdown, fmtDuration, buildTimeline, withSentenceTranscript, findPhrase } = ctx.api;
const buildSentences = (segs) => buildTimeline(segs).sentences;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.05, `${msg}: ${a} vs ${b}`);

// --- sentences from uploaded (punctuated) captions: real TED lines, one line ends mid-sentence
const manual = [
  { t: 19.423, end: 21.471, text: "Now, when a normal student writes a paper," },
  { t: 21.495, end: 23.868, text: "they might spread the work out a little like this." },
  { t: 23.892, end: 25.043, text: "So, you know -- You start a little slowly," },
  { t: 25.1, end: 28.0, text: "but you get enough done." }
];
let s = buildSentences(manual);
assert.deepEqual(s.map((x) => x.text), [
  "Now, when a normal student writes a paper, they might spread the work out a little like this.",
  "So, you know -- You start a little slowly, but you get enough done."
]);
near(s[0].start, 19.423, "first sentence starts at its line"); near(s[0].end, 23.868, "ends where its line ends");
near(s[1].start, 23.892, "second starts at the next line"); near(s[1].end, 28.0, "ends at the full stop");
// a full stop inside a line: times are interpolated within the line
s = buildSentences([{ t: 10, end: 20, text: "Short one. Then a longer second sentence here." }]);
assert.equal(s.length, 2); near(s[0].end, 12.17, "ends at the full stop (interpolated by characters)"); near(s[1].start, 12.39, "next starts there");

// --- sentences from auto-captions: per-word times, no punctuation; pauses split them
const w = (t, ...words) => words.map((x, i) => ({ t: t + i * 0.25, text: (i ? " " : "") + x }));
const asr = [
  { t: 19.64, end: 22.1, text: "when a normal student writes a paper", words: w(19.64, "when", "a", "normal", "student", "writes", "a", "paper") },
  { t: 21.4, end: 23.0, text: "they might spread it out", words: w(21.4, "they", "might", "spread", "it", "out") },
  { t: 24.6, end: 26.0, text: "so you start slowly", words: w(24.6, "so", "you", "start", "slowly") }   // 1.6 s pause before
];
s = buildSentences(asr);
assert.deepEqual(s.map((x) => x.text), ["when a normal student writes a paper they might spread it out", "so you start slowly"], "pause splits; words join with spaces");
near(s[0].start, 19.64, "starts at first word"); assert.ok(s[0].end <= 24.6 && s[0].end >= 22.4, "ends after last word, before the next");
// a fast talker with no pauses is still capped
const rambling = [{ t: 0, end: 60, text: "x", words: Array.from({ length: 240 }, (_, i) => ({ t: i * 0.25, text: " w" })) }];
assert.ok(buildSentences(rambling).every((x) => x.end - x.start <= 41), "capped at ~40 s");

// --- ranking: a 12-minute video, best points late, asked for ~2 minutes
const sents = Array.from({ length: 146 }, (_, i) => ({ start: i * 5 + 0.6, end: i * 5 + 5.4, text: `Sentence ${i}.` }));
const video = { sentences: sents, lengthSeconds: 730 };
const ranked = JSON.stringify([
  { rank: 1, start: "9:35", end: "10:10", title: "The big finding" },     // late in the video
  { rank: 2, start: "6:20", end: "6:50", title: "Why it works" },
  { rank: 3, start: "0:30", end: "1:00", title: "Setup" },
  { rank: 4, start: "2:00", end: "2:40", title: "Example" },
  { rank: 5, start: "4:00", end: "4:30", title: "Aside" }
]);
const sum = (xs) => xs.reduce((a, x) => a + x.end - x.start, 0);
const two = parseCut(ranked, video, 120);
assert.deepEqual(two.map((x) => x.rank), [3, 2, 1], "the best points that fit (#1-#3; #4 and #5 dropped), played in video order");
assert.deepEqual(two.map((x) => x.title), ["Setup", "Why it works", "The big finding"]);
// tighter budget: only the very best, even though it's the last in the video
const one = parseCut(ranked, video, 25);
assert.deepEqual(one.map((x) => x.rank), [1], "about 25 s keeps only #1, from near the end");
assert.ok(sum(two) <= 132, "within budget");
// cut points sit on sentence edges (with a small lead-in / tail)
for (const x of two) {
  assert.ok(sents.some((y) => Math.abs(y.start - 0.15 - x.start) < 0.01), `starts at a sentence: ${x.start}`);
  assert.ok(sents.some((y) => Math.abs(y.end + 0.3 - x.end) < 0.01), `ends at a sentence: ${x.end}`);
}
// the transcript shows times rounded down: "6:20" must mean the sentence starting at 380.6, not 375.6
near(two[1].start, 380.6 - 0.15, "rounding slack");
// a point longer than the cap is cut back to its last full sentence that fits
const long = parseCut('[{"rank":1,"start":"1:00","end":"5:00","title":"Long"}]', video, 120);
assert.equal(long.length, 1); assert.ok(long[0].end - long[0].start <= 48.5, "trimmed to the cap");
assert.ok(sents.some((y) => Math.abs(y.end + 0.3 - long[0].end) < 0.01), "trimmed at a sentence end");
// missing ranks fall back to the order given (best first)
assert.equal(parseCut('[{"start":"9:00","end":"9:30","title":"A"},{"start":"1:00","end":"1:30","title":"B"}]', video, 35)[0].title, "A");
// junk in, nothing out; no target leaves points alone
assert.equal(parseCut("Sorry, I can't.", video, 120).length, 0);
assert.equal(parseCut(ranked, video).length, 5);

// --- per-sentence transcript for the model
const wst = withSentenceTranscript({ transcript: "[0:00] blocks", sentences: sents.slice(0, 2), builtinTranscript: "cached" });
assert.equal(wst.transcript, "[0:00] Sentence 0.\n[0:05] Sentence 1.");
assert.equal(wst.builtinTranscript, undefined, "no stale on-device cache");
assert.equal(withSentenceTranscript({ transcript: "x", sentences: [] }).transcript, "x");

// --- list text
assert.equal(fmtDuration(65), "1 min 05 s");
const md = cutMarkdown(two, 730);
assert.match(md, /key point #1/); assert.match(md, /instead of 12 min 10 s/);

// --- auto-captions (no punctuation): the quoted first/last words decide the exact cut
const speech = "so I did the only thing I could I wrote 90 pages over 72 hours pulling not one but two all nighters and they said it was the best one we have ever seen".split(" ");
const asrSegs = [{ t: 100, end: 100 + speech.length * 0.3, text: speech.join(" "), words: speech.map((x, i) => ({ t: 100 + i * 0.3, text: (i ? " " : "") + x })) }];
const tl = buildTimeline(asrSegs);
assert.equal(tl.punctuated, false);
const asrVideo = { ...tl, lengthSeconds: 300 };
const quoted = parseCut(JSON.stringify([{ rank: 1, start: "1:41", end: "1:49", first_words: "I wrote 90 pages over", last_words: "not one but two all nighters", title: "The all-nighter" }]), asrVideo, 120);
assert.equal(quoted.length, 1);
near(quoted[0].start, 100 + speech.indexOf("wrote") * 0.3 - 0.3 - 0.15, "starts exactly at 'I wrote' (minus lead-in)");
near(quoted[0].end, 100 + speech.indexOf("nighters") * 0.3 + 0.3 + 0.3, "ends right after 'all nighters' (plus tail)");
// quotes are matched case- and punctuation-insensitively, and must be near the given time
assert.equal(findPhrase(tl.words, "I Wrote 90 pages, over", 103, false), 100 + speech.indexOf("wrote") * 0.3 - 0.3);
assert.equal(findPhrase(tl.words, "I wrote 90 pages over", 250, false), null, "too far from the given time");
assert.equal(findPhrase(tl.words, "nothing like this appears", 103, false), null);
// a quote that can't be found falls back to the timestamp
const fallback = parseCut('[{"rank":1,"start":"1:42","end":"1:50","first_words":"words that are not there","title":"x"}]', asrVideo, 120);
assert.equal(fallback.length, 1);
// --- punctuated captions: a quote from mid-sentence still widens to the whole sentence
const ted = { ...buildTimeline(manual), lengthSeconds: 60 };
assert.equal(ted.punctuated, true);
const mid = parseCut('[{"rank":1,"start":"0:21","end":"0:27","first_words":"they might spread the work","last_words":"start a little slowly","title":"x"}]', ted, 60);
near(mid[0].start, 19.423 - 0.15, "widened back to the start of the sentence");
near(mid[0].end, 28.0 + 0.3, "widened to the end of the sentence");
console.log("cut checks passed");
