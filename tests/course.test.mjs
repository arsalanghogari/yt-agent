// Courses in content.js: which playlists count, and which video is next.
import fs from "fs"; import vm from "vm"; import assert from "assert";
const src = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const grab = (re) => src.match(re)[0];
const ctx = { location: { href: "" }, URL };
vm.createContext(ctx);
vm.runInContext([grab(/  function getListId\(\) \{[\s\S]*?\n  }\n/), grab(/  const courseProgress = .*\n/), grab(/  function nextInCourse\([\s\S]*?\n  }\n/)].join("\n")
  + "\nthis.api = { getListId, courseProgress, nextInCourse };", ctx);
const { getListId, courseProgress, nextInCourse } = ctx.api;

const list = (l) => { ctx.location.href = `https://www.youtube.com/watch?v=abc${l ? `&list=${l}` : ""}`; return getListId(); };
assert.equal(list("PL8dPuuaLjXtNlUrzyH5r6jN9ulIgZBpdo"), "PL8dPuuaLjXtNlUrzyH5r6jN9ulIgZBpdo");
assert.equal(list("OLAK5uy_abc"), "OLAK5uy_abc", "albums and other playlists count");
for (const skip of ["RDabc123", "RDMMxyz", "WL", "LL", "LM", null]) assert.equal(list(skip), null, `not a course: ${skip}`);

const course = { videos: ["a", "b", "c", "d"].map((id) => ({ id })), done: { a: true, c: true } };
assert.equal(courseProgress(course), 2);
assert.equal(nextInCourse(course, "b").id, "d", "skips finished videos after this one");
assert.equal(nextInCourse(course, "d").id, "b", "wraps around to unfinished earlier ones");
assert.equal(nextInCourse(course, "zzz").id, "b", "from a video outside the course: first unfinished");
assert.equal(nextInCourse({ ...course, done: { a: true, b: true, c: true, d: true } }, "b"), null, "all done");
console.log("course checks passed");
