// What main did not show, never shown now, with code or prose glued to the quotes. fixtures/redact-main-glued.json pins
// main's redactSecrets verdict (at 712b392) on each variant fixtures/redact-glued-variants.mjs writes of every text the
// main differential reads (and of those main showed as they came): "W" withheld, "C" cut in place, "S" shown, one
// letter per variant in its order. A text none of whose variants main withheld or cut is left out. A string prefix, a
// word or a line of prose glued to a quote can turn which quotes the join view pairs; a variant main withheld or cut
// must still be, so no checkout of main is needed. Substrings a secret scanner would flag are written with a JSON escape.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { redactSecrets } from "../dist/learn/secrets.js";
import { gluedVariants } from "./fixtures/redact-glued-variants.mjs";

const rows = JSON.parse(readFileSync(new URL("./fixtures/redact-main-glued.json", import.meta.url), "utf8"));

test("main's verdicts are pinned, one for each glued variant", () => {
  assert.ok(rows.length >= 300, `rows: ${rows.length}`);
  const drift = rows.filter((row) => gluedVariants(row.text).length !== row.main.length);
  assert.deepEqual(drift.map((row) => row.text.slice(0, 80)), []);
  const count = (letter) => rows.reduce((sum, row) => sum + row.main.split(letter).length - 1, 0);
  assert.ok(count("W") >= 5000, `withheld: ${count("W")}`);
  assert.ok(count("C") >= 800, `cut: ${count("C")}`);
});

test("no glued variant main withheld or cut shows more of a held value now", (t) => {
  const regressed = [];
  let over = 0;
  for (const row of rows) {
    gluedVariants(row.text).forEach(([how, text], at) => {
      const now = redactSecrets(text, row.values);
      const main = row.main[at];
      if (main === "W" && now !== "[redacted]") regressed.push({ how, main, now: now === text ? "shown" : "cut", text });
      else if (main === "C" && now === text) regressed.push({ how, main, now: "shown", text });
      else if (main === "S" && now === "[redacted]") over++;
    });
  }
  // What main showed and is withheld now, where the two readings of the quotes differ: counted, never failed.
  t.diagnostic(`shown by main, withheld now: ${over}`);
  assert.deepEqual(regressed, []);
});
