// An API key made in the console (api-keys.ts) is cut from a text by its shape: `ar_key_` and 43 or more base64url
// characters. The server keeps only a keyed hash of such a key, so it holds no value to cut by, as it cuts its own
// token: the shape is how a key a person pasted into a run, or a tool echoed, is found where nothing labels it (after a
// `Bearer` scheme the bearer shape finds it too). The key is cut where it stands, alone, after a scheme or a variable's
// name, and glued to a word's character too (the `n` of a line break as JSON text writes it), and one the server really
// makes is cut. A long name that only holds the prefix's letters, a key cut short, and the words a document says the
// format in are left as written.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { API_KEY_PREFIX, ApiKeys } from "../dist/api-keys.js";
import { redacted, redactedAnswer } from "../dist/key-refusal.js";
import { redactLearned, redactSecrets, secretShapes } from "../dist/learn/secrets.js";
import { openSqliteStore } from "../dist/store/index.js";

// Made at run time from parts: no key-shaped literal for a scanner, and none a server ever made.
const PREFIX = ["ar", "key", ""].join("_");
const BODY = "Qm2Lp9Xk4Rt8-Zx7".repeat(3).slice(0, 43);
const KEY = `${PREFIX}${BODY}`;
const SCHEME = ["Bea", "rer"].join("");
const KIND = "AgentRun API key";
/** What a cut leaves in a key's place. Put into each expected text below, so no line here reads as a credential set to a
 *  literal to the source export's scan. */
const CUT = "[redacted]";
const cut = (text) => redactSecrets(text, []);

test("the shape is the prefix the server's keys start with, and 43 characters: 32 bytes in base64url", () => {
  assert.equal(PREFIX, API_KEY_PREFIX);
  assert.equal(BODY.length, 43);
  assert.equal(randomBytes(32).toString("base64url").length, 43);
});

test("a key is cut where it stands: alone, after a Bearer scheme, after a variable's name, in JSON, in a path", () => {
  assert.equal(cut(`the app sends ${KEY} on each call`), "the app sends [redacted] on each call");
  assert.equal(cut(KEY), "[redacted]");
  assert.equal(cut(`Authorization: ${SCHEME} ${KEY}`), `Authorization: ${SCHEME} [redacted]`);
  assert.equal(cut(`AGENTRUN_API_KEY=${KEY}`), "AGENTRUN_API_KEY=[redacted]");
  assert.equal(cut(`export AGENTRUN_API_KEY="${KEY}"\nnext`), `export AGENTRUN_API_KEY="${CUT}"\nnext`);
  assert.equal(cut(JSON.stringify({ api_key: KEY, name: "billing app" })), `{"api_key":"${CUT}","name":"billing app"}`);
  assert.equal(cut(`https://example.test/x/${KEY}/y`), "https://example.test/x/[redacted]/y");
  assert.equal(cut(`first ${KEY}, then ${KEY}.`), "first [redacted], then [redacted].");
  assert.deepEqual(secretShapes(`see ${KEY}`), [KIND]);
});

test("a key glued to more of its characters is cut whole, never cut short", () => {
  assert.equal(cut(`k ${KEY}moreOfTheSame_-09 end`), "k [redacted] end");
  assert.equal(cut(`k ${KEY}${KEY} end`), "k [redacted] end", "two back to back are one run");
});

test("a key is cut whatever stands before it: a word's character too, as a line break in JSON text leaves one", () => {
  // A tool's output kept as JSON text: the key follows the two characters of an escaped line break, a backslash and "n".
  const kept = JSON.stringify({ stdout: `https://agentrun.example.test\n${KEY}` });
  assert.ok(kept.includes(`\\n${KEY}`), "the fixture holds the key right after the letter n");
  assert.equal(cut(kept), `{"stdout":"https://agentrun.example.test\\n${CUT}"}`);
  assert.equal(redacted(kept, ["a-value-the-server-holds"]), `{"stdout":"https://agentrun.example.test\\n${CUT}"}`, "in a run's view");
  for (const before of ["\\t", "\\r", "x", "X_", "my_", "9", "-", "/", "=", '"']) {
    assert.equal(cut(`${before}${KEY} end`), `${before}${CUT} end`, JSON.stringify(before));
  }
  assert.equal(cut(`x${PREFIX}${KEY} end`), `x${CUT} end`, "the prefix twice: the run from the first is the key's");
});

test("what only resembles a key is left as written", () => {
  const plain = [
    `the prefix is ${PREFIX} and nothing follows`,
    `${PREFIX}${BODY.slice(0, 42)} is one character short`,
    `${PREFIX}abc is cut short`,
    // Long names that hold the prefix's letters: all lower case, as a name is and 32 random bytes all but never are.
    `the option simil${PREFIX}for_the_long_configuration_option_name_here_and_more is a name`,
    `${PREFIX}${"a_long_lowercase_name_that_goes_on_and_on_and_on_x"} is a name`,
    `the pattern ^${PREFIX}[A-Za-z0-9_-]{43}$ says the format`,
    `${PREFIX}<the key> is a placeholder`,
    `${PREFIX.toUpperCase()}${BODY} is not the prefix`,
  ];
  for (const text of plain) {
    assert.equal(cut(text), text);
    assert.deepEqual(secretShapes(text), [], text);
  }
});

test("a key the server makes is cut by the same shape, in a learned note and in a run's views too", async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "api-key-shape-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = await openSqliteStore({ dataDir: dir });
  t.after(() => store.close());
  const keys = new ApiKeys(store, randomBytes(32));
  // Several, so the test does not pass by one key's luck: each is random, and "-" and "_" are among its characters.
  for (let i = 0; i < 25; i++) {
    const made = await keys.create({ name: `key ${i}` });
    const text = `curl -H "Authorization: ${SCHEME} ${made.api_key}" then AGENTRUN_API_KEY=${made.api_key} done`;
    const want = `curl -H "Authorization: ${SCHEME} [redacted]" then AGENTRUN_API_KEY=[redacted] done`;
    assert.equal(redactSecrets(text, []), want);
    assert.equal(redactLearned(text, []), want, "a learned note");
    // A run's views cut by the values the server holds; it holds none of this key, and the shape still finds it.
    assert.equal(redacted(text, ["a-value-the-server-holds"]), want, "a run's view");
    assert.equal(redactedAnswer(text, ["a-value-the-server-holds"]), want, "a run's answer");
    // With no scheme or parameter name beside it, the key's own shape alone finds it.
    assert.deepEqual(secretShapes(`the app sends ${made.api_key} on each call`), [KIND]);
  }
});
