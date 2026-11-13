// What a streaming thinking or text block may show before it ends (key-refusal.ts' redactedLive): the whole stream
// redacted by serve's rule (learning's redactSecrets over the held values), then held back by a fixed tail, the most a
// held value takes in its widest form. A key a stream wraps is found whole; one whose tail has not streamed yet is never
// shown, not even its head.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as refusal from "../dist/key-refusal.js";

const KEY = ["not-a-secret", "streamed-key", "0123456789abcdef"].join("-");
const PAD = "Working through the request, step by step, with care. ".repeat(12);
const holdsRun = (text, secret) => {
  for (let i = 0; i + 8 <= secret.length; i++) if (text.includes(secret.slice(i, i + 8))) return true;
  return false;
};
const live = (text) => {
  assert.equal(typeof refusal.redactedLive, "function", "key-refusal.js exports redactedLive");
  return refusal.redactedLive(text, [KEY]);
};

test("a stream that wraps a held key (its head, a line break, its tail): what it shows holds no 8 characters of it", () => {
  // Before the tail: what came before the key still shows. With the whole wrapped key in, learning's rule takes the
  // whole text, as it does a settled row's (a key split by whitespace blanks the text), so the live block shows nothing.
  const head = live(`${PAD}Using ${KEY.slice(0, 20)}`);
  assert.ok(!holdsRun(head, KEY) && head.length > 0 && PAD.startsWith(head.slice(0, 40)), JSON.stringify(head.slice(-200)));
  const whole = live(`${PAD}Using ${KEY.slice(0, 20)}\n${KEY.slice(20)} now. ${PAD}`);
  assert.ok(!holdsRun(whole, KEY), JSON.stringify(whole.slice(-200)));
});

test("a stream with only a held key's head so far: what it shows holds no part of it, and a short stream shows nothing yet", () => {
  const out = live(`${PAD}Using ${KEY.slice(0, 20)}`);
  assert.ok(!holdsRun(out, KEY.slice(0, 20)), JSON.stringify(out.slice(-120)));
  assert.equal(live(`Using ${KEY.slice(0, 20)}`), "");
});
