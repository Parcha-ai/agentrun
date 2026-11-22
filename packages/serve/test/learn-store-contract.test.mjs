// The learning store's contract (src/learn/store.ts LearningStore), with the SAME assertions over both stores: the
// local git folder through learning.sh (the default, src/learn/store-local.ts) and code.storage over its in-memory fake
// (src/learn/code-storage.ts, fixtures/code-storage-fake.mjs). Each case starts from an empty store. What a store
// holds is files at paths; a save is one commit on main by compare and swap on the head it read; a run's merge leaves
// its marker file (.agentrun/runs/<key>) in the same commit; a run's purge rewrites the whole history without its text
// (src/learn/purge.ts), marking .agentrun/purged/<run>.
//
// Against the real code.storage too, when this process is started with its settings (CI never sets them):
//   AGENTRUN_CODE_STORAGE_NAME=<org> AGENTRUN_CODE_STORAGE_KEY="$(cat key.pem)" [AGENTRUN_CODE_STORAGE_API_URL=<url>] \
//     node --test packages/serve/test/learn-store-contract.test.mjs
// Each case there is a server id of its own (12 fresh hex digits), so its repositories are
// agentrun-<that id>-agent-one-g<N>; every generation is deleted (each by its exact id, no listing) when the case ends.
// The settings are read once, below, before any of dist is imported (every dist import here is a dynamic one inside a
// case): dist's secrets module takes each key out of the environment as it loads (secrets.ts).
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { codeStorageFake } from "./fixtures/code-storage-fake.mjs";

/** The variable the capture path's check (the case at the end) hands its child the fake's public key in: set, the live
 *  cases run against a fake keyed with it, never the network. */
const FAKE_PEM = "LEARN_STORE_CONTRACT_FAKE_PEM";
/** The live settings, as this process was started with them: read here, before dist takes the key out. */
const LIVE = { name: process.env.AGENTRUN_CODE_STORAGE_NAME, key: process.env.AGENTRUN_CODE_STORAGE_KEY, apiUrl: process.env.AGENTRUN_CODE_STORAGE_API_URL, fake: process.env[FAKE_PEM] };
const HEX = /^[0-9a-f]{40}$/;
/** The fakes' server id: 12 hex digits, as archil-settings.ts serverIdOf makes one. */
const SRV = "0123456789ab";
/** Every repository id this server may name (code.storage.ts AGENTRUN_REPO's start). */
const GUARD = /^agentrun-[0-9a-f]{12}-/;
const at = () => Math.floor(Date.now() / 1000);
const text = (files, path) => {
  const file = files?.find((one) => one.path === path);
  return file ? Buffer.from(file.body).toString("utf8") : undefined;
};
const paths = (files) => (files ?? []).map((file) => file.path).sort();
const save = (store, old, writes, extra = {}) => store.save({ old, message: extra.message ?? "a change", at: at(), writes, ...extra });

/** Every code.storage fake the suite made: the repository ids each was sent are checked at its end. */
const FAKES = [];

/** The learning's own modules: its writes, its purge and its reads. */
const learn = async () => ({ ...(await import("../dist/learn/commit.js")), ...(await import("../dist/learn/purge.js")), ...(await import("../dist/learn/folder.js")) });

/** Runs merged on `store`, one each of `words` (run_<word lowercased>), each a correction line and a reason of its own. */
async function merged(store, ...words) {
  const { learningCommit } = await learn();
  for (const word of words) {
    const done = await learningCommit(store, { runId: `run_${word.toLowerCase()}`, reason: `${word} reason words`, files: [], correction: `${word} line from the owner` });
    assert.equal(done.ok, true, JSON.stringify(done));
  }
}

/** Every text the store serves of main's whole history: each commit's message, every file at it, and its diff. */
async function everything(store) {
  const head = await store.head();
  if (!head) return "";
  const out = [];
  for (const commit of (await store.log(head)) ?? []) {
    out.push(commit.message);
    for (const file of (await store.read(commit.sha)) ?? []) out.push(file.path, Buffer.from(file.body).toString("utf8"));
    for (const file of (await store.diff(commit.sha)) ?? []) out.push(file.path, file.patch ?? "");
  }
  return out.join("\n");
}

/** Every byte the fake keeps, of every repository: each commit's message and files. */
const fakeText = (fake) => [...fake.repos.values()].flatMap((repo) => [...repo.commits.values()].flatMap((commit) => [commit.message, ...[...commit.tree.values()].map((body) => Buffer.from(body).toString("utf8"))])).join("\n");

/** The local folder's .git under `data`. */
function gitDirOf(data) {
  const found = readdirSync(data, { recursive: true }).map(String).find((path) => path.endsWith(".git") && statSync(join(data, path)).isDirectory());
  assert.ok(found, "the folder's .git");
  return join(data, found);
}

/** A code.storage store over a fake whose `fetch` is `wrap(fake.fetch)`; `fake` on it. */
async function wrappedStore(wrap) {
  const { codeStorageLearningStore } = await import("../dist/learn/code-storage.js");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const fake = codeStorageFake({ name: "example-org", publicKey });
  FAKES.push(fake);
  const store = codeStorageLearningStore({ name: "example-org", key: privateKey.export({ type: "pkcs8", format: "pem" }), apiUrl: "https://api.example-org.code.storage.invalid", fetch: wrap(fake.fetch), serverId: async () => SRV }, "agent-one");
  return Object.assign(store, { fake });
}
/** The repository a request's token names. */
const repoOf = (init) => JSON.parse(Buffer.from(String(init?.headers?.authorization ?? "").split(" ")[1].split(".")[1], "base64url").toString("utf8")).repo;

/** Each store, made empty for one case: its `store`, and `done` to clean up. */
const STORES = {
  local: async (t) => {
    const { localLearningStore } = await import("../dist/learn/store-local.js");
    const data = mkdtempSync(join(tmpdir(), "learn-store-"));
    t.after(() => rmSync(data, { recursive: true, force: true }));
    return Object.assign(localLearningStore(data, "agent-one"), { data });
  },
  "code.storage": async () => {
    const { codeStorageLearningStore } = await import("../dist/learn/code-storage.js");
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const fake = codeStorageFake({ name: "example-org", publicKey });
    const store = codeStorageLearningStore({ name: "example-org", key: privateKey.export({ type: "pkcs8", format: "pem" }), apiUrl: "https://api.example-org.code.storage.invalid", fetch: fake.fetch, serverId: async () => SRV }, "agent-one");
    FAKES.push(fake);
    return Object.assign(store, { fake });
  },
  ...(LIVE.name ? {
    "code.storage live": async (t) => {
      const { codeStorageLearningStore } = await import("../dist/learn/code-storage.js");
      const { CODE_STORAGE_ENV, codeStorageFromEnv } = await import("../dist/learn/store-of.js");
      const settings = codeStorageFromEnv({ [CODE_STORAGE_ENV.name]: LIVE.name, [CODE_STORAGE_ENV.apiUrl]: LIVE.apiUrl }, () => LIVE.key);
      const serverId = randomBytes(6).toString("hex");
      // On stderr, so whoever ran the suite can check every agentrun-<this id>-* repository is gone after it.
      process.stderr.write(`code.storage live: ${t.name}: server id ${serverId}\n`);
      // The capture path's own check (the case at the end) runs these cases against a fake keyed with the settings' key.
      const fake = LIVE.fake ? codeStorageFake({ name: settings.name, publicKey: LIVE.fake }) : undefined;
      const store = codeStorageLearningStore({ ...settings, ...(fake ? { fetch: fake.fetch } : {}), serverId: async () => serverId }, "agent-one");
      t.after(async () => {
        await store.remove({ erase: true });
        if (fake) assert.deepEqual([...fake.repos.keys()], [], "every generation the case made is erased");
      });
      return store;
    },
  } : {}),
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

  test(`${kind}: a run merges once`, async (t) => {
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
    // Each commit's whole message, its trailers too (a run's purge finds its merges by Run-Id), at any limit or path.
    assert.match(log[1].message, /^Run-Id: run_a$/m, JSON.stringify(log[1]));
    assert.match((await store.log(three, { path: ".agentrun/runs/run_a" }))[0].message, /^Run-Id: run_a$/m);
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

  test(`${kind}: a purge takes out only the copies of a line the purged run added: one its owner removed and another run added again later stays, in that run's diff and on main`, async (t) => {
    const store = await make(t);
    const { forgetRunText, learningCommit, putCorrections, readSnapshot, runMergeOf } = await learn();
    const shared = "the same words twice";
    const merge = async (runId) => assert.equal((await learningCommit(store, { runId, reason: `${runId} reason words`, files: [], correction: shared })).ok, true);
    await merged(store, "ALPHA");
    await merge("run_gone");
    // The owner takes the purged run's line out by hand; a later run adds the same words again.
    const snap = await readSnapshot(store);
    const text = (await store.read(snap.main, ["corrections.md"]))[0].body.toString("utf8");
    assert.equal((await putCorrections(store, { text: text.replace(`- ${shared}\n`, ""), ifMatch: snap.corrections.oid })).ok, true);
    await merge("run_later");
    assert.ok("commit" in (await forgetRunText(store, "run_gone")));
    const main = (await store.read(await store.head(), ["corrections.md"]))[0].body.toString("utf8");
    assert.equal(main, `- ALPHA line from the owner\n- ${shared}\n`, "the later run's line is on main");
    const diff = await runMergeOf(store, "run_later");
    assert.deepEqual(diff.files.map((file) => [file.path, file.patch?.includes(`+- ${shared}`)]), [["corrections.md", true]], "the later run's diff adds its line");
  });

  test(`${kind}: a purge takes out the purged run's line after its owner moved it (the owner swaps two runs' lines): the other run's line stays`, async (t) => {
    const store = await make(t);
    const { forgetRunText, putCorrections, readSnapshot } = await learn();
    await merged(store, "ALPHA", "GONE", "KEPT");
    const snap = await readSnapshot(store);
    const text = (await store.read(snap.main, ["corrections.md"]))[0].body.toString("utf8");
    const swapped = text.replace("- GONE line from the owner\n- KEPT line from the owner\n", "- KEPT line from the owner\n- GONE line from the owner\n");
    assert.notEqual(swapped, text);
    assert.equal((await putCorrections(store, { text: swapped, ifMatch: snap.corrections.oid })).ok, true);
    assert.ok("commit" in (await forgetRunText(store, "run_gone")));
    const main = (await store.read(await store.head(), ["corrections.md"]))[0].body.toString("utf8");
    assert.equal(main, "- ALPHA line from the owner\n- KEPT line from the owner\n");
    assert.doesNotMatch(await everything(store), /GONE line/);
  });

  test(`${kind}: a purge takes run B's text out of every commit (no read, log message, diff or snapshot at any commit holds it), A's and C's diffs stay, B merges no more, and a purge again does nothing`, async (t) => {
    const store = await make(t);
    const { forgetRunText, readSnapshot, runMergeOf } = await learn();
    await merged(store, "ALPHA", "BRAVO", "CHARLIE");
    const before = await store.head();
    assert.match(await everything(store), /BRAVO/);
    // What each commit held but corrections.md and the host's files: the same at the commit the purge moved it to.
    const learned = async (commit) => JSON.stringify(((await store.read(commit)) ?? []).filter(({ path }) => path !== "corrections.md" && !path.startsWith(".agentrun/")).map(({ path, body }) => [path, Buffer.from(body).toString("base64")]));
    const old = await Promise.all(((await store.log(before)) ?? []).map(async ({ sha }) => [sha, await learned(sha)]));
    const done = await forgetRunText(store, "run_bravo");
    assert.match(done.commit ?? "", HEX, JSON.stringify(done));
    // Every old commit moved to one of the new history holding what it held (a promotion record follows it).
    for (const [sha, held] of old) {
      assert.match(done.moved?.get(sha) ?? "", HEX, sha);
      assert.equal(await learned(done.moved.get(sha)), held, sha);
    }
    assert.equal(await store.head(), done.commit);
    const all = await everything(store);
    assert.doesNotMatch(all, /BRAVO/);
    assert.match(all, /ALPHA line from the owner/);
    assert.match(all, /CHARLIE reason words/);
    // The old history is gone from the store: no read at its head.
    assert.equal(await store.read(before), undefined);
    // B's merge is kept, empty of its text; the tip marks the purge.
    const log = await store.log(done.commit);
    // (A store may keep a message's trailing newline or not.)
    assert.ok(log.some((commit) => commit.message.trimEnd() === "learning: run_bravo: merged\n\nmerged\n\nRun-Id: run_bravo"),JSON.stringify(log.map((commit) => commit.message)));
    assert.ok(paths(await store.read(done.commit)).includes(".agentrun/purged/run_bravo"));
    // The snapshot is main's, rebuilt: every commit it names is in the new history, B's reason cut.
    const snapshot = await readSnapshot(store);
    assert.equal(snapshot?.main, done.commit);
    const shas = new Set(log.map((commit) => commit.sha));
    assert.ok(snapshot.log.every((change) => shas.has(change.commit)), JSON.stringify(snapshot.log));
    assert.deepEqual(snapshot.log.filter((change) => change.by.run === "run_bravo").map((change) => change.reason), ["merged"]);
    // A's and C's diffs are still theirs, their lines added.
    for (const [run, word] of [["run_alpha", "ALPHA"], ["run_charlie", "CHARLIE"]]) {
      const diff = await runMergeOf(store, run);
      assert.ok(shas.has(diff?.merge), run);
      assert.match(diff.files.find((file) => file.path === "corrections.md")?.patch ?? "", new RegExp(`^\\+.*${word} line`, "m"), run);
      assert.doesNotMatch(JSON.stringify(diff), /BRAVO/, run);
    }
    // B merges no more, any round: already, nothing written.
    for (const key of ["run_bravo", "run_bravo.r2"]) assert.ok("already" in (await save(store, done.commit, [{ path: "corrections.md", text: "BRAVO again\n" }], { run: key })), key);
    assert.equal(await store.head(), done.commit);
    // A purge sent again, or one of a run that never merged, does nothing.
    assert.deepEqual(await forgetRunText(store, "run_bravo"), { nothing: "purged" });
    assert.deepEqual(await forgetRunText(store, "run_zulu"), { nothing: "unmerged" });
    assert.equal(await store.head(), done.commit);
    // No byte of the old history is left in the store itself.
    if (store.data) {
      const git = gitDirOf(store.data);
      const objects = execFileSync("git", ["--git-dir", git, "cat-file", "--batch-all-objects", "--batch"], { maxBuffer: 64 << 20 }).toString("utf8");
      assert.match(objects, /ALPHA/);
      assert.doesNotMatch(objects, /BRAVO/);
      assert.equal(execFileSync("git", ["--git-dir", git, "for-each-ref", "--format=%(refname)"]).toString("utf8").trim(), "refs/heads/main");
      assert.equal(execFileSync("git", ["--git-dir", git, "reflog", "show", "--all"]).toString("utf8").trim(), "");
    }
    if (store.data) {
      // Another run's commit being made on main (its import ref, its commit's parent main) is never disturbed by a purge
      // sent again: nothing is tidied when no rewrite stopped, and an import on main is kept when one did.
      const git = gitDirOf(store.data);
      // An identity of its own: a CI machine has none configured.
      const sh = (args, input) => execFileSync("git", ["-c", "user.name=contract test", "-c", "user.email=contract@example.invalid", "--git-dir", git, ...args], { input }).toString("utf8").trim();
      const making = sh(["commit-tree", `${done.commit}^{tree}`, "-p", done.commit, "-m", "a run's merge being made"]);
      const importRef = "refs/agentrun/import-0123456789abcdef";
      sh(["update-ref", importRef, making]);
      assert.deepEqual(await forgetRunText(store, "run_bravo"), { nothing: "purged" });
      assert.equal(sh(["rev-parse", importRef]), making);
      // A rewrite stopped after moving main (its tidy mark left, before it pruned) left the run's bytes and a ref: a
      // purge sent again finds its marker and removes them, the import on main kept.
      const blob = sh(["hash-object", "-w", "--stdin"], "BRAVO left behind\n");
      sh(["update-ref", "refs/agentrun/rewrite-0123456789abcdef", blob]);
      sh(["hash-object", "-w", "--stdin"], "BRAVO loose\n");
      writeFileSync(join(git, "agentrun-tidy"), "");
      // Another rewrite that lost its compare and swap keeps that mark: it cleaned up nothing.
      const lost = await store.rewrite(before, (commit) => commit({ parent: null, message: "a rewrite that loses", at: 1_700_000_000, files: [] }));
      assert.ok("stale" in lost, JSON.stringify(lost));
      assert.equal(existsSync(join(git, "agentrun-tidy")), true, "a lost rewrite keeps the mark another left");
      assert.deepEqual(await forgetRunText(store, "run_bravo"), { nothing: "purged" });
      const objects = execFileSync("git", ["--git-dir", git, "cat-file", "--batch-all-objects", "--batch"], { maxBuffer: 64 << 20 }).toString("utf8");
      assert.doesNotMatch(objects, /BRAVO/);
      assert.deepEqual(sh(["for-each-ref", "--format=%(refname)"]).split("\n").sort(), [importRef, "refs/heads/main"]);
      assert.equal(existsSync(join(git, "agentrun-tidy")), false, "the tidy mark goes once it is done");
    }
    if (store.fake) {
      assert.deepEqual([...store.fake.repos.keys()], [`agentrun-${SRV}-agent-one-g1`]);
      assert.doesNotMatch(fakeText(store.fake), /BRAVO/);
    }
  });
}

test("local: a purge on a folder an earlier release wrote leaves none of its diff files (.agentrun/diffs, kept outside git): no file in the folder holds the run's text", async (t) => {
  const store = await STORES.local(t);
  const { forgetRunText } = await learn();
  await merged(store, "ALPHA", "BRAVO", "CHARLIE");
  const tree = join(gitDirOf(store.data), "..");
  mkdirSync(join(tree, ".agentrun", "diffs"), { recursive: true });
  writeFileSync(join(tree, ".agentrun", "diffs", "run_bravo.json"), JSON.stringify({ v: 1, run: "run_bravo", files: [{ path: "corrections.md", patch: "+- BRAVO line\n" }] }));
  assert.ok("commit" in (await forgetRunText(store, "run_bravo")));
  assert.equal(existsSync(join(tree, ".agentrun", "diffs")), false, "the earlier release's diffs are gone");
  const held = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((one) => (one.name === ".git" ? [] : one.isDirectory() ? held(join(dir, one.name)) : readFileSync(join(dir, one.name), "utf8").includes("BRAVO") ? [join(dir, one.name)] : []));
  assert.deepEqual(held(tree), []);
});

test("local: a purge whose checkout fails (an index.lock left behind) is not done: the tidy mark stays, the purge fails retryable, and once the lock is gone the purge sent again checks main out and leaves no file holding the run's text", async (t) => {
  const store = await STORES.local(t);
  const { forgetRunText } = await learn();
  await merged(store, "ALPHA", "BRAVO", "CHARLIE");
  const git = gitDirOf(store.data);
  const tree = join(git, "..");
  const corrections = () => readFileSync(join(tree, "corrections.md"), "utf8");
  assert.match(corrections(), /BRAVO line/, "the working tree holds main's corrections");
  writeFileSync(join(git, "index.lock"), "");
  await assert.rejects(forgetRunText(store, "run_bravo"), /working tree/);
  assert.equal(existsSync(join(git, "agentrun-tidy")), true, "the tidy mark stays while the checkout is not done");
  rmSync(join(git, "index.lock"));
  assert.deepEqual(await forgetRunText(store, "run_bravo"), { nothing: "purged" });
  assert.doesNotMatch(corrections(), /BRAVO/);
  assert.match(corrections(), /ALPHA line/);
  assert.equal(existsSync(join(git, "agentrun-tidy")), false);
});

test("local: a purge through hand commits of a corrections.md far past its cap (20,000 lines, then the same lines reversed) finishes in a 256 MB heap and takes the run's line out", () => {
  const dist = (file) => JSON.stringify(new URL(`../dist/learn/${file}`, import.meta.url).href);
  const child = `
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const { localLearningStore } = await import(${dist("store-local.js")});
    const { learningCommit } = await import(${dist("commit.js")});
    const { forgetRunText } = await import(${dist("purge.js")});
    const data = mkdtempSync(join(tmpdir(), "learn-store-"));
    try {
      const store = localLearningStore(data, "agent-one");
      for (const runId of ["run_alpha", "run_gone"]) {
        const done = await learningCommit(store, { runId, reason: runId + " reason", files: [], correction: runId + " line" });
        if (!done.ok) throw new Error(JSON.stringify(done));
      }
      const many = Array.from({ length: 20000 }, (_, i) => "- hand line " + i);
      const keep = "- run_alpha line\\n- run_gone line\\n";
      for (const lines of [many, [...many].reverse()]) {
        const head = await store.head();
        const done = await store.save({ old: head, message: "by hand", at: Math.floor(Date.now() / 1000), writes: [{ path: "corrections.md", text: keep + lines.join("\\n") + "\\n" }] });
        if (!done.saved) throw new Error(JSON.stringify(done));
      }
      const forgot = await forgetRunText(store, "run_gone");
      if (!("commit" in forgot)) throw new Error(JSON.stringify(forgot));
      const main = (await store.read(await store.head(), ["corrections.md"]))[0].body.toString("utf8");
      if (main.includes("run_gone line") || !main.includes("run_alpha line") || !main.includes("- hand line 19999")) throw new Error("main: " + main.slice(0, 200));
      process.stdout.write("purged\\n");
    } finally {
      rmSync(data, { recursive: true, force: true });
    }`;
  const out = spawnSync(process.execPath, ["--max-old-space-size=256", "--input-type=module", "-e", child], { encoding: "utf8", timeout: 120_000 });
  assert.equal(out.stdout.trim(), "purged", `exit ${out.status} ${out.signal ?? ""}\n${out.stderr.slice(-2000)}`);
});

test("code.storage: the repo is agentrun-<server id>-<agent id>-g0, every call's token names it, and the key never travels", async (t) => {
  const store = await STORES["code.storage"](t);
  const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
  await store.read(one);
  await store.log(one);
  await store.remove({ erase: true });
  const { fake } = store;
  assert.ok(fake.calls.length > 4);
  // The erasure deletes g0 and the generation past it, g1, each by its exact id.
  assert.deepEqual([...new Set(fake.calls.map((call) => call.repo))], [`agentrun-${SRV}-agent-one-g0`, `agentrun-${SRV}-agent-one-g1`]);
  assert.ok(fake.calls.every((call) => !/BEGIN|PRIVATE/.test(call.search)), "no key in a URL");
});

test("code.storage: a purge killed mid-build leaves the live repository untouched; the retry deletes the half-built next generation by its exact id and finishes", async () => {
  const { forgetRunText } = await learn();
  let packs = 0;
  let killAfter = Infinity;
  const store = await wrappedStore((inner) => async (url, init) => {
    if (new URL(url).pathname.endsWith("/repos/commit-pack") && ++packs > killAfter) throw new Error("killed mid-build");
    return inner(url, init);
  });
  await merged(store, "ALPHA", "BRAVO", "CHARLIE");
  const live = await store.head();
  const before = await everything(store);
  packs = 0;
  killAfter = 2;
  await assert.rejects(forgetRunText(store, "run_bravo"), (error) => error.name === "FolderUnreadable");
  assert.equal(await store.head(), live);
  assert.equal(await everything(store), before, "the live repository is untouched");
  const next = `agentrun-${SRV}-agent-one-g1`;
  assert.equal(store.fake.repos.get(next)?.commits.size, 2, "the next generation, half built, is no one's");
  killAfter = Infinity;
  const done = await forgetRunText(store, "run_bravo");
  assert.match(done.commit ?? "", HEX);
  assert.deepEqual([...store.fake.repos.keys()], [next]);
  assert.doesNotMatch(fakeText(store.fake), /BRAVO/);
  // Each delete named its exact id: the half-built g1 before each build, then g0 once the agent was on g1.
  assert.deepEqual(store.fake.calls.filter((call) => call.method === "DELETE").map((call) => call.repo), [next, next, `agentrun-${SRV}-agent-one-g0`]);
});

test("code.storage: a purge whose old repository's delete fails is not done: the retry finds its marker, deletes the old repository by its exact id or fails retryable again", async () => {
  const { forgetRunText } = await learn();
  let refuse = true;
  const old = `agentrun-${SRV}-agent-one-g0`;
  const store = await wrappedStore((inner) => async (url, init) => (refuse && init?.method === "DELETE" && repoOf(init) === old ? new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } }) : inner(url, init)));
  await merged(store, "ALPHA", "BRAVO");
  await assert.rejects(forgetRunText(store, "run_bravo"), (error) => error.name === "FolderUnreadable");
  assert.match(fakeText(store.fake), /BRAVO/, "the old repository is left");
  assert.doesNotMatch(await everything(store), /BRAVO/, "the agent is on the next generation");
  await assert.rejects(forgetRunText(store, "run_bravo"), (error) => error.name === "FolderUnreadable");
  refuse = false;
  assert.deepEqual(await forgetRunText(store, "run_bravo"), { nothing: "purged" });
  assert.deepEqual([...store.fake.repos.keys()], [`agentrun-${SRV}-agent-one-g1`]);
  assert.doesNotMatch(fakeText(store.fake), /BRAVO/);
});

test("code.storage: a save racing a purge is kept or refused, never saved and then deleted: one landing before the old main is fenced makes the purge start over and keep it; one after the fence is stale", async () => {
  const { forgetRunText } = await learn();
  let race;
  const store = await wrappedStore((inner) => async (url, init) => {
    // The fence: the one commit on the old main that writes .agentrun/moved.
    const fence = new URL(url).pathname.endsWith("/repos/commit-pack") && String(init?.body ?? "").includes(".agentrun/moved");
    const now = fence ? race : undefined;
    if (now) race = undefined;
    if (now?.at === "before") await now.run();
    const response = await inner(url, init);
    if (now?.at === "after") await now.run();
    return response;
  });
  const line = async (word) => save(store, await store.head(), [{ path: `notes/${word}.md`, text: `${word} kept\n` }]);
  await merged(store, "ALPHA", "BRAVO");
  let early;
  race = { at: "before", run: async () => void (early = await line("EARLY")) };
  await forgetRunText(store, "run_bravo");
  assert.match(early?.saved ?? "", HEX, JSON.stringify(early));
  assert.match(await everything(store), /EARLY kept/, "the save that landed first is in the new history");
  assert.doesNotMatch(await everything(store), /BRAVO/);
  await merged(store, "CHARLIE");
  let late;
  race = { at: "after", run: async () => void (late = await line("LATE")) };
  await forgetRunText(store, "run_charlie");
  assert.ok(late && "stale" in late, JSON.stringify(late));
  assert.doesNotMatch(await everything(store), /LATE|CHARLIE/);
  assert.match((await line("AFTER")).saved ?? "", HEX, "the agent's next generation takes saves");
});

test("code.storage: an agent's erasure deletes every generation it ever had, each by its exact id (no listing): after two purges, a third killed mid-build and a reset whose old generation's delete failed, nothing under its prefix is left", async () => {
  const { forgetRunText } = await learn();
  let packs = 0;
  let killAfter = Infinity;
  let refuseDelete;
  const store = await wrappedStore((inner) => async (url, init) => {
    if (new URL(url).pathname.endsWith("/repos/commit-pack") && ++packs > killAfter) throw new Error("killed mid-build");
    if (init?.method === "DELETE" && repoOf(init) === refuseDelete) return new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    return inner(url, init);
  });
  const id = (n) => `agentrun-${SRV}-agent-one-g${n}`;
  await merged(store, "ALPHA", "BRAVOONE");
  await forgetRunText(store, "run_bravoone");
  await merged(store, "BRAVOTWO");
  await forgetRunText(store, "run_bravotwo");
  assert.deepEqual([...store.fake.repos.keys()], [id(2)]);
  // A third purge killed mid-build leaves g3.
  await merged(store, "BRAVOTHREE");
  packs = 0;
  killAfter = 1;
  await assert.rejects(forgetRunText(store, "run_bravothree"));
  killAfter = Infinity;
  // A reset flips past it (to g4) and its delete of g2 fails: g2 and g3 are left, named for the next call.
  refuseDelete = id(2);
  await assert.rejects(store.remove(), (error) => error.name === "FolderUnreadable");
  assert.deepEqual([...store.fake.repos.keys()].sort(), [id(2), id(3)]);
  refuseDelete = undefined;
  const sent = store.fake.calls.length;
  await store.remove({ erase: true });
  assert.deepEqual([...store.fake.repos.keys()].filter((repo) => repo.startsWith(`agentrun-${SRV}-agent-one-`)), []);
  // g0 through g5 (the generation, 4, and the one past it), each by its exact id.
  assert.deepEqual(store.fake.calls.slice(sent).map((call) => [call.method, call.repo]), [0, 1, 2, 3, 4, 5].map((n) => ["DELETE", id(n)]));
  // The agent's generation dropped with them: a store of the agent made again starts at g0.
  assert.equal(await store.head(), null);
  assert.equal(store.fake.calls.at(-1).repo, id(0));
});

test("code.storage: a reset whose old generation's delete fails reports it retryable; the store is already reset, the old repository kept named and deleted by the next call", async () => {
  let refuse = true;
  const store = await wrappedStore((inner) => async (url, init) => (refuse && init?.method === "DELETE" && repoOf(init) === `agentrun-${SRV}-agent-one-g0` ? new Response(JSON.stringify({ error: "conflict" }), { status: 409, headers: { "content-type": "application/json" } }) : inner(url, init)));
  const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
  assert.match(one, HEX);
  await assert.rejects(store.remove(), (error) => error.name === "FolderUnreadable" && error.link === false);
  assert.ok(store.fake.repos.has(`agentrun-${SRV}-agent-one-g0`), "the old repository is there until its delete lands");
  assert.equal(await store.head(), null);
  refuse = false;
  assert.equal(await store.head(), null);
  assert.ok(!store.fake.repos.has(`agentrun-${SRV}-agent-one-g0`), "the next call deleted it");
});

test("code.storage: the repository id is agentrun-<12 hex>-<agent id>-g<N> whatever the ids: a forged agent id (a slash, ../, empty, 65 characters, an h- form) maps under agentrun-<server id>-, and a server id that is not 12 hex digits, or any id outside agentrun-<12 hex>-, is refused before a request goes out", async () => {
  const { agentrunRepo, codeStorageLearningStore, repoIdOf, RepoIdRefused } = await import("../dist/learn/code-storage.js");
  for (const agent of ["../x", "../etc", "a/b", "", "x".repeat(65), "..", "agent one", "h-x-0123456789abcdef01234567"]) {
    const id = repoIdOf(SRV, agent);
    assert.match(id, new RegExp(`^agentrun-${SRV}-h-[A-Za-z0-9_-]*-[0-9a-f]{24}-g0$`), JSON.stringify(agent));
    assert.match(id, GUARD);
    assert.ok(!id.includes("/") && !id.includes(".."), id);
  }
  assert.equal(repoIdOf(SRV, "agent-one"), `agentrun-${SRV}-agent-one-g0`);
  assert.equal(repoIdOf(SRV, "agent-one", 3), `agentrun-${SRV}-agent-one-g3`);
  for (const server of ["", "x/y", "a/b", "../x", "a-b", "srv1", "smoke0123456789ab", "0123456789AB", "x".repeat(65), undefined]) assert.throws(() => repoIdOf(server, "agent-one"), RepoIdRefused, JSON.stringify(server));
  for (const generation of [-1, 1.5, Number.NaN]) assert.throws(() => repoIdOf(SRV, "agent-one", generation), RepoIdRefused, String(generation));
  for (const id of ["grep-prod", "other", "agentrun-", "agentrun-a/b", "agentrun-../x", "xagentrun-a", "", "agentrun-srv1-agent-one", `agentrun-${SRV}`, `agentrun-${SRV}-`, `agentrun-${SRV}-a/b`]) assert.throws(() => agentrunRepo(id), RepoIdRefused, id);
  // A store whose server id can't name a repository sends nothing at all.
  for (const server of ["", "x/y"]) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const fake = codeStorageFake({ name: "example-org", publicKey });
    const store = codeStorageLearningStore({ name: "example-org", key: privateKey.export({ type: "pkcs8", format: "pem" }), apiUrl: "https://api.example-org.code.storage.invalid", fetch: fake.fetch, serverId: async () => server }, "agent-one");
    for (const call of [() => store.head(), () => store.read("a".repeat(40)), () => store.log("a".repeat(40)), () => store.diff("a".repeat(40)), () => save(store, null, [{ path: "corrections.md", text: "x\n" }]), () => store.rewrite("a".repeat(40), async () => "a".repeat(40)), () => store.remove(), () => store.remove({ erase: true })]) await assert.rejects(call(), RepoIdRefused);
    assert.deepEqual(fake.calls, [], `no request went out (${JSON.stringify(server)})`);
  }
});

test("code.storage: each token is signed by its key's kind, as the SDK signs: an RSA key RS256, an Ed25519 key EdDSA (EC is ES256, the suite's)", async () => {
  const { codeStorageLearningStore } = await import("../dist/learn/code-storage.js");
  for (const [kind, options] of [["rsa", { modulusLength: 2048 }], ["ed25519", {}]]) {
    const { privateKey, publicKey } = generateKeyPairSync(kind, options);
    const fake = codeStorageFake({ name: "example-org", publicKey });
    FAKES.push(fake);
    const store = codeStorageLearningStore({ name: "example-org", key: privateKey.export({ type: "pkcs8", format: "pem" }), apiUrl: "https://api.example-org.code.storage.invalid", fetch: fake.fetch, serverId: async () => SRV }, "agent-one");
    const one = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
    assert.match(one, HEX, kind);
    assert.equal(text(await store.read(one), "corrections.md"), "- one\n", kind);
    assert.ok(fake.calls.every((call) => call.repo === `agentrun-${SRV}-agent-one-g0`), "each token verified under the key's own alg");
  }
});

test("code.storage: every repository id the whole suite sent is agentrun-<12 hex>-... (no other repository of the org is created, read, written or deleted), and no call listed repositories", () => {
  const sent = FAKES.flatMap((fake) => fake.calls);
  assert.ok(sent.length > 50, `the suite's calls: ${sent.length}`);
  for (const call of sent) assert.match(String(call.repo), GUARD, JSON.stringify(call));
  for (const call of sent) assert.match(String(call.repo), /^agentrun-[0-9a-f]{12}-[A-Za-z0-9_-]+$/, JSON.stringify(call));
  assert.deepEqual(sent.filter((call) => /^repos\/?$/.test(call.path) && call.method === "GET"), [], "no repository listing");
  assert.deepEqual([...new Set(sent.filter((call) => call.method === "DELETE").map((call) => call.path))], ["repos/delete"]);
});

// The live cases' settings are read before any of dist is (LIVE): its secrets module takes every key out of the
// environment as it loads (secrets.ts), so a read inside a case would find the name alone. Checked in CI in a process of
// this file's own, started with the three settings and the fake's public key: every live case runs, against the fake.
if (!LIVE.name) {
  test("code.storage live: started with its settings, every live case runs and passes (here against the fake, keyed with the settings' key), each erasing what it made", { timeout: 180_000 }, async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    // NODE_TEST_CONTEXT left out: under `node --test` the child would report to this runner's pipe, not as TAP.
    const { NODE_TEST_CONTEXT: _, ...parent } = process.env;
    const env = {
      ...parent,
      AGENTRUN_CODE_STORAGE_NAME: "example-org",
      AGENTRUN_CODE_STORAGE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
      AGENTRUN_CODE_STORAGE_API_URL: "https://api.example-org.code.storage.invalid",
      [FAKE_PEM]: publicKey.export({ type: "spki", format: "pem" }),
    };
    const file = fileURLToPath(import.meta.url);
    const out = await promisify(execFile)(process.execPath, ["--test-reporter=tap", "--test-name-pattern=^code\\.storage live: ", file], { env, maxBuffer: 16 << 20, timeout: 170_000 }).catch((error) => error);
    const said = `${out.stdout ?? ""}${out.stderr ?? ""}`;
    const live = (said.match(/^ok \d+ - code\.storage live: /gm) ?? []).length;
    // One live case for each case every store runs.
    const each = (readFileSync(file, "utf8").match(/^ {2}test\(`\$\{kind\}: /gm) ?? []).length;
    assert.equal((said.match(/^not ok /gm) ?? []).length, 0, said);
    assert.ok(each > 0);
    assert.equal(live, each, said);
  });
}
