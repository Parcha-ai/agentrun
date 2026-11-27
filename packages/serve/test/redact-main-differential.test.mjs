// What main did not show, never shown now. fixtures/redact-main-verdicts.json pins main's redactSecrets verdict (at
// 712b392, before string literals joined by "+" were read together) on every text it did not show as it came: each text
// redact-contract hands redactSecrets (up to 4 KiB), the reviews' probes (the 62 spellings of a key split into literals,
// prose before single-quoted code, the operator cases) and the second review's rows (a string prefix before a quote, a
// needle holding a "+" across two values). "withheld": main answered "[redacted]"; "cut": main cut it in place. A change
// to the join view that turns one of them back to shown fails here, with main's verdict as the expected value, so no
// checkout of main is needed. Substrings a secret scanner would flag are written in the fixture with a JSON escape.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { redactSecrets } from "../dist/learn/secrets.js";

const rows = JSON.parse(readFileSync(new URL("./fixtures/redact-main-verdicts.json", import.meta.url), "utf8"));

const count = (source, main) => rows.filter((row) => row.sources.includes(source) && row.main === main).length;

test("main's verdicts are pinned for the contract's texts, the reviews' probes and the second review's rows", () => {
  assert.ok(count("contract", "withheld") >= 200, `contract withheld: ${count("contract", "withheld")}`);
  assert.ok(count("contract", "cut") >= 40, `contract cut: ${count("contract", "cut")}`);
  assert.ok(count("review probe", "withheld") >= 10, `review probe: ${count("review probe", "withheld")}`);
  assert.equal(count("review r2 addendum", "withheld"), 34);
  assert.equal(count("review r2 P1-A", "withheld"), 8);
});

test("no text main withheld is shown or only cut now", () => {
  const regressed = rows.filter((row) => row.main === "withheld" && redactSecrets(row.text, row.values) !== "[redacted]");
  assert.deepEqual(regressed.map((row) => ({ sources: row.sources, text: row.text })), []);
});

// The contract's credential URL is a row of both fixtures: its colons are written as JSON escapes, so neither file holds
// a URL with a login as written (the source export blocks on one), and a regeneration that writes it plainly fails here.
test("neither fixture holds a URL with a login as written", () => {
  const plain = ["redact-main-verdicts.json", "redact-main-glued.json"].filter((name) =>
    /https?:\/\/[^\s/:]+:[^\s/@]+@/.test(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")),
  );
  assert.deepEqual(plain, []);
});

test("no text main cut in place shows as it came now", () => {
  const regressed = rows.filter((row) => row.main === "cut" && redactSecrets(row.text, row.values) === row.text);
  assert.deepEqual(regressed.map((row) => ({ sources: row.sources, text: row.text })), []);
});
