// The run's hand-over of its live viewers over the one store (browser-live.ts): the runner seals each session's viewer
// token and puts it under its claim, and drops it as the session is released; the server reads them, newest first, opens
// each token, and checks each as the hand-over files were. A session's release removes its own row and never a newer
// session's, even when the two cross (a relaunch); only the run's live claim shows a viewer, so a runner that died names
// none; a row whose seal does not open names none. The token's plaintext never reaches the store. On the store's fake
// (live-viewers-support.mjs), which the store's real liveViewers replaces.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { dropLiveViewer, liveViewer, liveViewerById, putLiveViewer, readLiveViewers } from "../dist/browser-live.js";
import { aadOf, sealColumn, sealedAt } from "../dist/store/seal.js";
import { fakeLiveViewersStore } from "./live-viewers-support.mjs";

const RUN = "run-1";
/** A test seal key, no real one. */
const KEY = randomBytes(32);
const handover = (tag) => ({ port: 40000, id: randomBytes(16).toString("base64url"), token: randomBytes(32).toString("base64url"), tag });
/** What the readers give for `given`, put at `at`. */
const read = (given, at) => ({ port: given.port, id: given.id, token: given.token, tag: given.tag, at });

test("the AAD a viewer's token is sealed under is browser_viewers|<run>/<tag>|sealed", () => {
  assert.equal(aadOf(sealedAt.liveViewer("run-1", "ar-run-1-1")), "browser_viewers|run-1/ar-run-1-1|sealed");
});

test("a session's viewer put under the run's claim reads back whole, newest first, at the store's time: liveViewer is the newest, liveViewerById finds one by its path id", async () => {
  const store = fakeLiveViewersStore({ start: 1_000 });
  const claim = store.claim(RUN);
  const older = handover("ar-run-1-1");
  const newer = handover("ar-run-1-2");
  assert.equal(await putLiveViewer(store, KEY, claim, older), true);
  store.advance(1_000);
  assert.equal(await putLiveViewer(store, KEY, claim, { ...newer, at: 5 }), true, "a time the runner names is not the store's");
  const all = await readLiveViewers(store, KEY, RUN);
  assert.deepEqual(all, [read(newer, 2_000), read(older, 1_000)]);
  assert.deepEqual(Object.keys(all[0]).sort(), ["at", "id", "port", "tag", "token"], "a hand-over, and nothing of the row beside it");
  assert.deepEqual(await liveViewer(store, KEY, RUN), read(newer, 2_000));
  assert.deepEqual(await liveViewerById(store, KEY, RUN, older.id), read(older, 1_000));
  assert.equal(await liveViewerById(store, KEY, RUN, "AAAAAAAAAAAAAAAAAAAAAA"), undefined);
  assert.deepEqual(await readLiveViewers(store, KEY, "run-2"), [], "another run reads none of it");
  assert.equal(await liveViewer(store, KEY, "run-2"), undefined);
});

test("one viewer per session: a relaunch's put under the same tag replaces the session's row", async () => {
  const store = fakeLiveViewersStore();
  const claim = store.claim(RUN);
  await putLiveViewer(store, KEY, claim, handover("ar-run-1-1"));
  store.advance(10);
  const again = handover("ar-run-1-1");
  await putLiveViewer(store, KEY, claim, again);
  assert.deepEqual((await readLiveViewers(store, KEY, RUN)).map((v) => v.token), [again.token]);
});

test("an old session's release that crosses a new session's put never removes the new one", async () => {
  const store = fakeLiveViewersStore();
  const claim = store.claim(RUN);
  for (let i = 0; i < 40; i += 1) {
    const old = handover(`ar-run-1-${i}`);
    const fresh = handover(`ar-run-1-${i}b`);
    await putLiveViewer(store, KEY, claim, old);
    await Promise.all([dropLiveViewer(store, claim, old.tag), putLiveViewer(store, KEY, claim, fresh)]);
    assert.equal((await liveViewer(store, KEY, RUN))?.tag, fresh.tag, `round ${i}: the new session's viewer is still handed over`);
    await dropLiveViewer(store, claim, fresh.tag);
    assert.equal(await liveViewer(store, KEY, RUN), undefined, `round ${i}: its own release removes it`);
  }
});

test("a release removes its own row and leaves another session's; with no tag, every one of the run's goes", async () => {
  const store = fakeLiveViewersStore();
  const claim = store.claim(RUN);
  const other = store.claim("run-2");
  const a = handover("ar-run-2-1");
  const b = handover("ar-run-2-2");
  const c = handover("ar-run-3-1");
  await putLiveViewer(store, KEY, claim, a);
  store.advance(1);
  await putLiveViewer(store, KEY, claim, b);
  await putLiveViewer(store, KEY, other, c);
  await dropLiveViewer(store, claim, b.tag);
  assert.equal((await liveViewer(store, KEY, RUN))?.tag, a.tag, "the other session's is still there");
  await putLiveViewer(store, KEY, claim, b);
  await dropLiveViewer(store, claim);
  assert.equal(await liveViewer(store, KEY, RUN), undefined);
  assert.deepEqual((await readLiveViewers(store, KEY, "run-2")).map((v) => v.tag), [c.tag], "another run's is never touched");
  // A tag that is not a session's names no row: nothing is dropped.
  await dropLiveViewer(store, other, "../ar-run-3-1");
  assert.deepEqual((await readLiveViewers(store, KEY, "run-2")).map((v) => v.tag), [c.tag]);
});

test("a stale claim's put answers false and writes nothing; its drop drops nothing", async () => {
  const store = fakeLiveViewersStore();
  const first = store.claim(RUN);
  const second = store.claim(RUN, "runner-2");
  const kept = handover("ar-run-1-1");
  assert.equal(await putLiveViewer(store, KEY, second, kept), true);
  assert.equal(await putLiveViewer(store, KEY, first, handover("ar-run-1-2")), false, "fenced");
  await dropLiveViewer(store, first);
  await dropLiveViewer(store, first, kept.tag);
  assert.deepEqual((await readLiveViewers(store, KEY, RUN)).map((v) => v.tag), [kept.tag], "nothing written, nothing dropped");
});

test("a lapsed claim's rows read as none, and its put answers false: a runner that died names no viewer", async () => {
  const store = fakeLiveViewersStore();
  const claim = store.claim(RUN, "runner-1", 1_000);
  await putLiveViewer(store, KEY, claim, handover("ar-run-1-1"));
  assert.equal((await readLiveViewers(store, KEY, RUN)).length, 1);
  store.advance(1_001);
  assert.deepEqual(await readLiveViewers(store, KEY, RUN), [], "no live claim: no viewer");
  assert.equal(await liveViewer(store, KEY, RUN), undefined);
  assert.equal(await putLiveViewer(store, KEY, claim, handover("ar-run-1-2")), false, "a lapsed lease writes nothing");
  store.claim(RUN, "runner-2");
  assert.deepEqual(await readLiveViewers(store, KEY, RUN), [], "the earlier claim's row is not the new claim's");
});

test("a row whose seal does not open reads as no viewer, never a throw: tampered, sealed for another session or run, or under another key", async () => {
  const store = fakeLiveViewersStore();
  const claim = store.claim(RUN);
  const good = handover("ar-run-1-good");
  await putLiveViewer(store, KEY, claim, good);
  const token = () => randomBytes(32).toString("base64url");
  const tampered = sealColumn(KEY, sealedAt.liveViewer(RUN, "ar-run-1-tampered"), token());
  tampered[tampered.length - 1] ^= 1;
  const rows = [
    { tag: "ar-run-1-tampered", sealed: tampered },
    { tag: "ar-run-1-moved", sealed: sealColumn(KEY, sealedAt.liveViewer(RUN, "ar-run-1-elsewhere"), token()) },
    { tag: "ar-run-1-run", sealed: sealColumn(KEY, sealedAt.liveViewer("run-2", "ar-run-1-run"), token()) },
    { tag: "ar-run-1-key", sealed: sealColumn(randomBytes(32), sealedAt.liveViewer(RUN, "ar-run-1-key"), token()) },
    { tag: "ar-run-1-short", sealed: new Uint8Array(3) },
    { tag: "ar-run-1-none", sealed: null },
  ];
  for (const row of rows) store.plant(RUN, { ...row, port: 40000, id: randomBytes(16).toString("base64url") });
  assert.deepEqual((await readLiveViewers(store, KEY, RUN)).map((v) => v.tag), [good.tag]);
});

test("the readers leave out a row that is no hand-over: a bad path id, token, tag or port, or no time", async () => {
  const store = fakeLiveViewersStore();
  const claim = store.claim(RUN);
  const good = handover("ar-run-1-good");
  await putLiveViewer(store, KEY, claim, good);
  const row = (tag, patch = {}, plain = randomBytes(32).toString("base64url")) => ({ tag, port: 40000, id: randomBytes(16).toString("base64url"), sealed: sealColumn(KEY, sealedAt.liveViewer(RUN, tag), plain), ...patch });
  const bad = [
    row("ar-run-1-id", { id: "short" }),
    row("ar-run-1-token", {}, "x".repeat(42)),
    row("ar run 1"),
    row("ar-run-1-zero", { port: 0 }),
    row("ar-run-1-high", { port: 65_536 }),
    row("ar-run-1-float", { port: 4000.5 }),
    row("ar-run-1-at", { at: Number.NaN }),
  ];
  for (const each of bad) store.plant(RUN, each);
  assert.deepEqual((await readLiveViewers(store, KEY, RUN)).map((v) => v.tag), [good.tag], "the one hand-over, and nothing else");
});

test("a put whose tag is not a session's is refused before the store, in words that carry no token", async () => {
  const store = fakeLiveViewersStore();
  const claim = store.claim(RUN);
  const given = handover("../ar-run-1-1");
  await assert.rejects(putLiveViewer(store, KEY, claim, given), (error) => {
    assert.equal(error.message, "a hand-over's tag is not a session's tag");
    assert.ok(!String(error.stack).includes(given.token));
    return true;
  });
  assert.deepEqual(store.received, [], "the store was handed nothing");
});

test("the token's plaintext reaches no store row: the store is handed the tag, port, path id and the sealed token alone", async () => {
  const store = fakeLiveViewersStore();
  const claim = store.claim(RUN);
  const given = handover("ar-run-1-1");
  await putLiveViewer(store, KEY, claim, given);
  store.claim(RUN, "runner-2");
  assert.equal(await putLiveViewer(store, KEY, claim, given), false);
  assert.equal(store.received.length, 2);
  for (const { v } of store.received) {
    assert.deepEqual(Object.keys(v).sort(), ["id", "port", "sealed", "tag"]);
    assert.ok(v.sealed instanceof Uint8Array);
    assert.ok(!Buffer.from(v.sealed).includes(given.token), "not in the sealed bytes");
    assert.ok(!JSON.stringify(v).includes(given.token), "nor anywhere in what put was handed");
  }
});
