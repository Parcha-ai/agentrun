// The learning store's contract (src/learn/store.ts LearningStore), with the SAME assertions over both stores: the
// local git folder through learning.sh (the default, src/learn/store-local.ts) and code.storage over its in-memory fake
// (src/learn/code-storage.ts, fixtures/code-storage-fake.mjs). Each case starts from an empty store. What a store
// holds is files at paths; a save is one commit on main by compare and swap on the head it read; a run's merge and a
// purge leave marker files (.agentrun/runs/<key>, .agentrun/purged/<key>) in the same commit.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codeStorageFake } from "./fixtures/code-storage-fake.mjs";

const HEX = /^[0-9a-f]{40}$/;
const at = () => Math.floor(Date.now() / 1000);
const text = (files, path) => {
  const file = files?.find((one) => one.path === path);
  return file ? Buffer.from(file.body).toString("utf8") : undefined;
};
const paths = (files) => (files ?? []).map((file) => file.path).sort();
const save = (store, old, writes, extra = {}) => store.save({ old, message: extra.message ?? "a change", at: at(), writes, ...extra });

/** Each store, made empty for one case: its `store`, and `done` to clean up. */
const STORES = {
  local: async (t) => {
    const { localLearningStore } = await import("../dist/learn/store-local.js");
    const data = mkdtempSync(join(tmpdir(), "learn-store-"));
    t.after(() => rmSync(data, { recursive: true, force: true }));
    return localLearningStore(data, "agent-one");
  },
  "code.storage": async () => {
    const { codeStorageLearningStore } = await import("../dist/learn/code-storage.js");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const fake = codeStorageFake({ name: "example-org", publicKey });
    const store = codeStorageLearningStore({ name: "example-org", key: privateKey.export({ type: "pkcs8", format: "pem" }), apiUrl: "https://api.example-org.code.storage.invalid", fetch: fake.fetch, serverId: async () => "srv1" }, "agent-one");
    return Object.assign(store, { fake });
  },
};

for (const [kind, make] of Object.entries(STORES)) {
  test(`${kind}: an empty store has no head; its first save makes main`, async (t) => {
    const store = await make(t);
    assert.equal(await store.head(), null);
    const first = await save(store, null, [{ path: "corrections.md", text: "- one\n" }]);
    assert.match(first.saved, HEX, JSON.stringify(first));
    assert.equal(await store.head(), first.saved);
    assert.equal(text(await store.read(first.saved), "corrections.md"), "- one\n");
    // A second first save finds main there: stale, nothing written.
    const again = await save(store, null, [{ path: "corrections.md", text: "- other\n" }]);
    assert.deepEqual(again, { stale: first.saved });
    assert.equal(await store.head(), first.saved);
  });

  test(`${kind}: a save moves main from the head it read; a stale save writes nothing`, async (t) => {
    const store = await make(t);
    const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
    const two = (await save(store, one, [{ path: "corrections.md", text: "- one\n- two\n" }, { path: "workflows/a/README.md", text: "a\n" }])).saved;
    assert.match(two, HEX);
    assert.notEqual(two, one);
    assert.equal(await store.head(), two);
    const stale = await save(store, one, [{ path: "corrections.md", text: "- lost\n" }]);
    assert.deepEqual(stale, { stale: two });
    assert.equal(await store.head(), two);
    assert.equal(text(await store.read(two), "corrections.md"), "- one\n- two\n");
    // A delete is a save too.
    const three = (await save(store, two, [], { deletes: ["workflows/a/README.md"] })).saved;
    assert.deepEqual(paths(await store.read(three)).filter((path) => !path.startsWith(".agentrun/")), ["corrections.md"]);
  });

  test(`${kind}: two saves on one head at once: exactly one lands, the other is stale`, async (t) => {
    const store = await make(t);
    const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
    const results = await Promise.all([save(store, one, [{ path: "corrections.md", text: "- a\n" }]), save(store, one, [{ path: "corrections.md", text: "- b\n" }])]);
    const won = results.filter((result) => "saved" in result);
    const lost = results.filter((result) => "stale" in result);
    assert.equal(won.length, 1, JSON.stringify(results));
    assert.equal(lost.length, 1, JSON.stringify(results));
    assert.equal(lost[0].stale, won[0].saved);
    assert.equal(await store.head(), won[0].saved);
  });

  test(`${kind}: two first saves on an empty store at once: exactly one makes main, the other is stale`, async (t) => {
    const store = await make(t);
    const results = await Promise.all([save(store, null, [{ path: "corrections.md", text: "- a\n" }]), save(store, null, [{ path: "corrections.md", text: "- b\n" }])]);
    const won = results.filter((result) => "saved" in result);
    const lost = results.filter((result) => "stale" in result);
    assert.equal(won.length, 1, JSON.stringify(results));
    assert.equal(lost.length, 1, JSON.stringify(results));
    assert.equal(lost[0].stale, won[0].saved);
    assert.equal(await store.head(), won[0].saved);
    assert.deepEqual((await store.log(won[0].saved)).map((commit) => commit.parent), [null], "one root");
  });

  test(`${kind}: a save that changes nothing is unchanged, never an error`, async (t) => {
    const store = await make(t);
    const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
    assert.deepEqual(await save(store, one, [{ path: "corrections.md", text: "- one\n" }]), { unchanged: true });
    assert.equal(await store.head(), one);
  });

  test(`${kind}: preconditions absent, same and seed each refuse, nothing written`, async (t) => {
    const store = await make(t);
    const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }, { path: "workflows/a/README.md", text: "a\n" }])).saved;
    const two = (await save(store, one, [{ path: "workflows/a/README.md", text: "a, changed\n" }])).saved;
    const write = [{ path: "workflows/b/README.md", text: "b\n" }];
    assert.deepEqual(await save(store, two, write, { absent: ["workflows/a/README.md"] }), { refused: { absent: ["workflows/a/README.md"], same: [] } });
    assert.deepEqual(await save(store, two, write, { same: [{ commit: one, path: "workflows/a/README.md" }] }), { refused: { absent: [], same: ["workflows/a/README.md"] } });
    const gone = "f".repeat(40);
    assert.deepEqual(await save(store, two, write, { seed: gone }), { refused: { absent: [], same: [], seed: gone } });
    // A `same` against a commit the store does not hold fails too.
    assert.deepEqual(await save(store, two, write, { same: [{ commit: gone, path: "corrections.md" }] }), { refused: { absent: [], same: ["corrections.md"] } });
    assert.equal(await store.head(), two);
    // Each holds: the save lands.
    const three = await save(store, two, write, { absent: ["workflows/b/README.md"], same: [{ commit: one, path: "corrections.md" }], seed: one });
    assert.match(three.saved, HEX, JSON.stringify(three));
  });

  test(`${kind}: a run merges once; a purged run's key can't merge`, async (t) => {
    const store = await make(t);
    const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
    const merge = (await save(store, one, [{ path: "corrections.md", text: "- one\n- run\n" }], { run: "run_a", message: "learning: run_a: merged" })).saved;
    assert.match(merge, HEX);
    assert.ok(paths(await store.read(merge)).includes(".agentrun/runs/run_a"), "the run's marker is in its merge");
    // Again, on the new head, whatever it writes: already, the merge named, nothing written.
    assert.deepEqual(await save(store, merge, [{ path: "workflows/x/README.md", text: "x\n" }], { run: "run_a" }), { already: merge });
    assert.equal(await store.head(), merge);
    // A round past the first is a key of its own.
    const round = await save(store, merge, [{ path: "workflows/x/README.md", text: "x\n" }], { run: "run_a.r2" });
    assert.match(round.saved, HEX);
    // A purge's scrub leaves its key's purged marker; a merge of that key is then already, at the purge.
    const purge = (await save(store, round.saved, [{ path: "corrections.md", text: "- one\n" }], { purged: "run_b" })).saved;
    assert.ok(paths(await store.read(purge)).includes(".agentrun/purged/run_b"));
    assert.deepEqual(await save(store, purge, [{ path: "workflows/y/README.md", text: "y\n" }], { run: "run_b" }), { already: purge });
    // The purge itself lands once.
    assert.deepEqual(await save(store, purge, [{ path: "corrections.md", text: "- zero\n" }], { purged: "run_b" }), { already: purge });
    assert.equal(await store.head(), purge);
  });

  test(`${kind}: a read at an older commit, and none at one the store does not hold`, async (t) => {
    const store = await make(t);
    const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
    const two = (await save(store, one, [{ path: "corrections.md", text: "- two\n" }, { path: "workflows/a/workflow.json", text: "{}\n" }])).saved;
    assert.equal(text(await store.read(one), "corrections.md"), "- one\n");
    assert.deepEqual(paths(await store.read(one)).filter((path) => !path.startsWith(".agentrun/")), ["corrections.md"]);
    assert.equal(text(await store.read(two), "corrections.md"), "- two\n");
    // Named paths alone; a path the commit does not hold is left out.
    assert.deepEqual(paths(await store.read(two, ["workflows/a/workflow.json", "workflows/none.md"])), ["workflows/a/workflow.json"]);
    assert.equal(await store.read("e".repeat(40)), undefined);
  });

  test(`${kind}: the log is main's first-parent history, newest first, and filters by path`, async (t) => {
    const store = await make(t);
    const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }], { message: "first" })).saved;
    const two = (await save(store, one, [{ path: "workflows/a/README.md", text: "a\n" }], { message: "second\n\nRun-Id: run_a\n", run: "run_a" })).saved;
    const three = (await save(store, two, [{ path: "corrections.md", text: "- three\n" }], { message: "third" })).saved;
    const log = await store.log(three);
    assert.deepEqual(log.map((commit) => [commit.sha, commit.parent]), [[three, two], [two, one], [one, null]]);
    assert.deepEqual(log.map((commit) => commit.message.trim().split("\n")[0]), ["third", "second", "first"]);
    assert.ok(log.every((commit) => !Number.isNaN(Date.parse(commit.at))));
    assert.deepEqual((await store.log(two)).map((commit) => commit.sha), [two, one]);
    assert.deepEqual((await store.log(three, { limit: 1 })).map((commit) => commit.sha), [three]);
    assert.deepEqual((await store.log(three, { path: ".agentrun/runs/run_a" })).map((commit) => commit.sha), [two]);
    assert.deepEqual((await store.log(three, { path: "corrections.md" })).map((commit) => commit.sha), [three, one]);
    assert.equal(await store.log("d".repeat(40)), undefined);
  });

  test(`${kind}: the diff of a merge is each path it changed against its parent`, async (t) => {
    const store = await make(t);
    const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }, { path: "workflows/old/README.md", text: "old\n" }])).saved;
    const merge = (await save(store, one, [{ path: "corrections.md", text: "- one\n- two\n" }, { path: "workflows/a/README.md", text: "a\n" }], { deletes: ["workflows/old/README.md"], run: "run_a" })).saved;
    const diff = await store.diff(merge);
    const byPath = new Map(diff.filter((file) => !file.path.startsWith(".agentrun/")).map((file) => [file.path, file]));
    assert.deepEqual([...byPath.keys()].sort(), ["corrections.md", "workflows/a/README.md", "workflows/old/README.md"]);
    assert.equal(byPath.get("corrections.md").status, "modified");
    assert.match(byPath.get("corrections.md").patch, /^@@/);
    assert.match(byPath.get("corrections.md").patch, /^\+- two$/m);
    assert.equal(byPath.get("workflows/a/README.md").status, "added");
    assert.match(byPath.get("workflows/a/README.md").patch, /^\+a$/m);
    assert.equal(byPath.get("workflows/old/README.md").status, "deleted");
    assert.equal(await store.diff("c".repeat(40)), undefined);
  });

  test(`${kind}: remove erases every commit; the store made again starts empty; remove twice is fine`, async (t) => {
    const store = await make(t);
    const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
    const two = (await save(store, one, [{ path: "corrections.md", text: "- two\n" }], { run: "run_a" })).saved;
    await store.remove();
    assert.equal(await store.head(), null);
    assert.equal(await store.read(two), undefined);
    assert.equal(await store.read(one), undefined);
    await store.remove();
    // The next first save makes it again: one commit, no marker of before.
    const again = (await save(store, null, [{ path: "corrections.md", text: "- fresh\n" }])).saved;
    assert.match(again, HEX);
    assert.deepEqual((await store.log(again)).map((commit) => commit.sha), [again]);
    assert.deepEqual(paths(await store.read(again)), ["corrections.md"]);
    // A merge of the run made before the reset is not "already": its marker went with the store.
    const merged = await save(store, again, [{ path: "corrections.md", text: "- fresh\n- run\n" }], { run: "run_a" });
    assert.match(merged.saved, HEX, JSON.stringify(merged));
    // And a seed the old store held is gone.
    assert.deepEqual(await save(store, merged.saved, [{ path: "workflows/z/README.md", text: "z\n" }], { seed: one }), { refused: { absent: [], same: [], seed: one } });
  });
}

test("code.storage: the repo is agentrun-<server id>-<agent id>, every call's token names it, and the key never travels", async (t) => {
  const store = await STORES["code.storage"](t);
  const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
  await store.read(one);
  await store.log(one);
  await store.remove();
  const { fake } = store;
  assert.ok(fake.calls.length > 4);
  assert.deepEqual([...new Set(fake.calls.map((call) => call.repo))], ["agentrun-srv1-agent-one"]);
  assert.ok(fake.calls.every((call) => !/BEGIN|PRIVATE/.test(call.search)), "no key in a URL");
});
