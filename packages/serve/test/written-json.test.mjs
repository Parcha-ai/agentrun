// A faux process notes where it held (a pid, the entries since its arm) in a file a test polls (jsonIn, writtenJson). A
// read can land after the file is made and before its JSON is in (seen in CI: "Unexpected end of JSON input"): an empty or
// partial read is a note not yet written, and the poll goes on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonIn, writtenJson } from "./support.mjs";

/** A read that gives each of `texts` in turn, then the last one again; a null is a file that does not exist. */
const reads = (texts) => {
  let n = 0;
  return async () => {
    const text = texts[Math.min(n++, texts.length - 1)];
    if (text === null) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return text;
  };
};

test("an empty or partial note reads as not yet written, never as an error", async () => {
  assert.equal(await jsonIn("held", reads([""])), null, "an empty file");
  assert.equal(await jsonIn("held", reads(['{"pid":4'])), null, "half its JSON");
  assert.equal(await jsonIn("held", reads([null])), null, "no file");
  assert.deepEqual(await jsonIn("held", reads(['{"pid":42}'])), { pid: 42 });
});

test("the poll goes on past an empty and a partial read to the note once it is whole", async () => {
  assert.deepEqual(await writtenJson("held", "the note is written", { ms: 5_000, read: reads([null, "", '{"pid":4', '{"pid":42,"since":[]}']) }), { pid: 42, since: [] });
});
