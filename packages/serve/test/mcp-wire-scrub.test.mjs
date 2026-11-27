// The MCP wire's scrubber (mcp-wire.ts scrub), which the probe and the gateway run over every upstream answer: a
// credential value the answer echoes is cut in place, whole or as its bare token, and an answer that holds one in a form
// no cut in place finds (split by a control character, a terminal sequence, a character that shows as a box) is
// withheld whole, as the redaction matcher reads it. Every key-shaped text here is put together at run time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scrub } from "../dist/mcp-wire.js";

const TOKEN = ["Zq8VbN3x", "LmT6pR2w", "Yk9HsD4f"].join("");
const SPLITS = ["\u0000", "\u001b[0m", "\ufffe"];

test("a credential value split by a control character, a terminal sequence or a box in an upstream answer withholds the answer", () => {
  const [head, rest] = [TOKEN.slice(0, 12), TOKEN.slice(12)];
  for (const between of SPLITS) {
    for (const values of [[`Bearer ${TOKEN}`], [TOKEN]]) assert.equal(scrub(`echo: ${head}${between}${rest} done`, values), "[redacted]", JSON.stringify([between, values]));
  }
});

test("a credential value echoed whole or as its bare token is cut in place, and an answer without one kept (control)", () => {
  assert.equal(scrub(`auth: Bearer ${TOKEN} ok`, [`Bearer ${TOKEN}`]), "auth: [redacted] ok");
  assert.equal(scrub(`token ${TOKEN} ok`, [`Bearer ${TOKEN}`]), "token [redacted] ok");
  assert.equal(scrub("short abc ok", ["abc"]), "short [redacted] ok");
  assert.equal(scrub("nothing here \u001b[0m done", [`Bearer ${TOKEN}`]), "nothing here \u001b[0m done");
});
