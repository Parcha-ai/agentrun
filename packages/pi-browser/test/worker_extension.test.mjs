import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { copyExtension, loadConfined } from "../dist/providers/worker-extension.js";
import { scratch } from "./fixtures/scratch.mjs";

// Nothing listens here: the load fails after the policy is written.
const DEAD = "ws://127.0.0.1:9/devtools/browser/not-there";
const manifestOf = (copy) => JSON.parse(fs.readFileSync(path.join(copy, "manifest.json"), "utf8"));

test("a load that failed after the policy was written can be tried again, and fails for the same reason", async (t) => {
  const dir = await scratch(t, "worker-extension-");
  const copy = await copyExtension(dir);
  const first = await loadConfined(copy, DEAD).then(() => null, (error) => error);
  assert.ok(first, "the first load fails: nothing answers");
  assert.doesNotMatch(first.message, /already sets/);
  const second = await loadConfined(copy, DEAD).then(() => null, (error) => error);
  assert.ok(second, "the retry fails too");
  assert.doesNotMatch(second.message, /already sets/, "and not because its own earlier write is taken for someone else's policy");
  assert.match(manifestOf(copy).content_security_policy.extension_pages, /connect-src 'self' ws:\/\/127\.0\.0\.1:9\/devtools\/browser\/not-there$/);
});

test("a policy the manifest already carries that is not this lease's own is refused, not overwritten", async (t) => {
  const dir = await scratch(t, "worker-extension-");
  const copy = await copyExtension(dir);
  const file = path.join(copy, "manifest.json");
  const foreign = { extension_pages: "script-src 'self'; object-src 'self'; connect-src *" };
  fs.writeFileSync(file, JSON.stringify({ ...manifestOf(copy), content_security_policy: foreign }));
  await assert.rejects(loadConfined(copy, DEAD), /already sets a content security policy/);
  assert.deepEqual(manifestOf(copy).content_security_policy, foreign, "the policy is left as it was");
});
