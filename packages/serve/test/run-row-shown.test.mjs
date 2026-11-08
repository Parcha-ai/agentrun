// The summary choke point (run-view.ts rowShown): a run read from its row and record alone (an ended one a list shows) is
// served cut of every pointer it was handed of its agent's browser sign-in, and withheld whole when what it was handed
// can't be read back here. This is where summaryOfRow cuts a handed pointer and withholds on an unreadable hash; it fails
// closed, so a marked run is never served uncut.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { rowShown } from "../dist/run-view.js";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
// A sign-in store that keeps one live pointer `ref` (none when undefined) and nothing forgotten.
const signInsFor = (ref) => ({
  async peek() {
    return ref ? { ref } : undefined;
  },
  async forgotten() {
    return { refs: [], unreadable: false };
  },
});
const deps = (ref, secrets = []) => ({ serverSecrets: () => secrets, signIns: signInsFor(ref) });

test("a run whose words hold a handed pointer serves them cut", async () => {
  const ref = "sign-in-ptr-abcdef123456";
  const shown = await rowShown(deps(ref), "agent1", "chromium", [sha(ref)], false);
  assert.notEqual(shown, "withheld");
  const out = shown(`continue at ${ref} now`);
  assert.ok(!out.includes(ref), "the handed pointer is cut from the words");
});

test("a handed hash that matches no readable pointer withholds the run's words", async () => {
  const shown = await rowShown(deps("live-ptr-xyz987654"), "agent1", "chromium", [sha("some-other-pointer-value")], false);
  assert.equal(shown, "withheld");
});

test("a malformed handed mark withholds", async () => {
  assert.equal(await rowShown(deps("live-ptr-xyz987654"), "agent1", "chromium", "malformed", false), "withheld");
});

test("a record that was there but unreadable withholds", async () => {
  assert.equal(await rowShown(deps("live-ptr-xyz987654"), "agent1", "chromium", undefined, true), "withheld");
});

test("a run handed a pointer with no vendor browser to read it back withholds", async () => {
  assert.equal(await rowShown(deps("live-ptr-xyz987654"), "agent1", undefined, [sha("live-ptr-xyz987654")], false), "withheld");
});

test("a run handed nothing serves its words cut only of the server's own secrets", async () => {
  const shown = await rowShown(deps(undefined, ["server-secret-xyz"]), "agent1", undefined, undefined, false);
  assert.notEqual(shown, "withheld");
  assert.ok(!shown("key is server-secret-xyz here").includes("server-secret-xyz"));
});
