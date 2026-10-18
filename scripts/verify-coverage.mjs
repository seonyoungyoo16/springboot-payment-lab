import fs from "node:fs";
import assert from "node:assert/strict";
import crypto from "node:crypto";
const design = fs.readFileSync("docs/DESIGN.md", "utf8"),
  expected = [...design.matchAll(/^\| ([PDT CWF SU]\d\d) \|/gm)].map(
    (m) => m[1],
  ),
  ids = [];
for (const file of fs
  .readdirSync("test/browser")
  .filter((f) => f.endsWith(".spec.ts"))) {
  for (const m of fs
    .readFileSync("test/browser/" + file, "utf8")
    .matchAll(/test\(\s*["']([A-Z]\d\d) /g))
    ids.push(m[1]);
}
assert.equal(expected.length, 64);
assert.equal(ids.length, 64);
assert.equal(new Set(ids).size, 64);
assert.deepEqual(ids.sort(), expected.sort());
const report = JSON.parse(
  fs.readFileSync("docs/verification/browser.json", "utf8"),
);
assert.equal(report.status, "passed");
assert.equal(report.tests.length, 64);
assert.deepEqual(report.tests.map((t) => t.id).sort(), ids);
assert(report.tests.every((t) => t.status === "passed"));
const sources = JSON.parse(fs.readFileSync("public/flow-source.json", "utf8"));
for (const s of Object.values(sources)) {
  const raw = fs.readFileSync(s.file, "utf8");
  assert.equal(crypto.createHash("sha256").update(raw).digest("hex"), s.sha256);
  assert.equal(
    raw
      .split(/\r?\n/)
      .slice(s.line - 1, s.line - 1 + s.snippet.split("\n").length)
      .join("\n"),
    s.snippet,
  );
}
console.log(
  "64 design IDs = 64 unique actual browser passes; " +
    Object.keys(sources).length +
    " source anchors match files and lines",
);
