import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// A script that imports scripts/own-chrome.mjs starts a browser. It should only do so when it opens a tab: a script that only makes HTTP requests would start a Chrome for nothing,
// and fail on a box without one.
test("only scripts that open a tab import own-chrome", () => {
  const dir = new URL("../scripts/", import.meta.url);
  const wired = readdirSync(dir).filter((f) => f.endsWith(".mjs") && /^import "\.\/own-chrome\.mjs"/m.test(readFileSync(new URL(f, dir), "utf8")));
  assert.ok(wired.length >= 6, `the tab-opening checks import it (found ${wired.join(", ")})`);
  const without = wired.filter((f) => !/\bopenTab\(/.test(readFileSync(new URL(f, dir), "utf8")));
  assert.deepEqual(without, [], "these import own-chrome but never call openTab");
});
