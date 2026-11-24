// Serve's text-urls.ts, the timeline scrub's URL reading that the console compiles from source, holds the same URL tail
// block as @parcha/agentrun-web's text-urls.ts, which a fetched page's links and the link check read: where a URL ends
// and what tail is not its own. A URL the timeline scrubs ends where the same URL a page holds or an answer cites does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as web from "@parcha/agentrun-web";
import * as serve from "../dist/text-urls.js";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const BEGIN = "// URL tail, begin:";
const END = "// URL tail, end.";
const tailOf = (text, name) => {
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END);
  assert.ok(from >= 0 && to > from, `${name} holds the URL tail block once`);
  assert.equal(text.indexOf(BEGIN, from + 1), -1, `${name} holds one URL tail block`);
  return text.slice(from, to + END.length);
};

test("serve's text-urls.ts holds web's URL tail block as the same text, and imports nothing", () => {
  const mine = source("../src/text-urls.ts");
  assert.equal(tailOf(mine, "serve"), tailOf(source("../../web/src/text-urls.ts"), "web"));
  assert.doesNotMatch(mine, /^\s*import\b|\bimport\(|\brequire\(/m, "the console compiles it from source");
});

test("serve's trimmed and web's read a URL's tail the same", () => {
  assert.equal(serve.TRAILING, web.TRAILING);
  for (const raw of ["https://a/b.", "https://a/b),", "https://en.wikipedia.org/wiki/Foo_(bar)", "https://a/b)", "https://a/(b))", "https://a/b?x=1'", "https://a/[b]]", "https://a/{b}}.", "https://a/b*", "https://a/b!?;:", "https://a/" + ")".repeat(10_000)]) {
    assert.equal(serve.trimmed(raw), web.trimmed(raw), raw.slice(0, 60));
  }
});
