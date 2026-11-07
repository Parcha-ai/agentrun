// The run's hand-over of its live viewers (browser-live.ts): a session's release removes its own hand-over and never a
// newer session's, even when the two cross (a relaunch: the old session's release runs in the background while the new
// session writes its own).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { dropHandover, readHandover, writeHandover } from "../dist/browser-live.js";
import { scratch } from "./support.mjs";

const handover = (tag) => ({ port: 40000, id: randomBytes(16).toString("base64url"), token: randomBytes(32).toString("base64url"), tag });

test("an old session's release that crosses a new session's hand-over never removes the new one", async (t) => {
  const dir = await scratch(t);
  for (let i = 0; i < 40; i += 1) {
    const old = handover(`ar-run-1-${i}`);
    const fresh = handover(`ar-run-1-${i}b`);
    await writeHandover(dir, old);
    await Promise.all([dropHandover(dir, old.tag), writeHandover(dir, fresh)]);
    assert.equal((await readHandover(dir))?.tag, fresh.tag, `round ${i}: the new session's viewer is still handed over`);
    await dropHandover(dir, fresh.tag);
    assert.equal(await readHandover(dir), undefined, `round ${i}: its own release removes it`);
  }
});

test("a release removes its own hand-over and leaves another session's; with no tag, every one goes", async (t) => {
  const dir = await scratch(t);
  const a = handover("ar-run-2-1");
  const b = handover("ar-run-2-2");
  await writeHandover(dir, a);
  await writeHandover(dir, b);
  await dropHandover(dir, b.tag);
  assert.equal((await readHandover(dir))?.tag, a.tag, "the other session's is still there");
  await writeHandover(dir, b);
  await dropHandover(dir);
  assert.equal(await readHandover(dir), undefined);
});
