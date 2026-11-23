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

/** A retried purge (`retried`, after one that moved main and then failed) hands back the commit map the purge made, from
 *  its marker: every commit of the old main (`before`) to one on the new main. The marker holds commit ids alone: no
 *  run's text. */
async function movedAll(store, before, retried) {
  const tip = await store.head();
  const now = new Set((await store.log(tip)).map(({ sha }) => sha));
  assert.ok(retried.moved instanceof Map, `the retry hands back the commit map: ${JSON.stringify(retried)}`);
  assert.deepEqual(before.filter((sha) => !retried.moved.has(sha)), [], "every old commit is mapped");
  for (const sha of before) assert.ok(now.has(retried.moved.get(sha)), `${sha} maps to a commit of main`);
  const [marker] = (await store.read(tip, [".agentrun/purged/run_bravo"])) ?? [];
  assert.ok(marker, "the purge's marker is at main");
  const text = Buffer.from(marker.body).toString("utf8");
  assert.doesNotMatch(text, /ALPHA|BRAVO|CHARLIE|line|reason/i, "the marker holds no run's text");
  const held = JSON.parse(text);
  assert.ok(Object.entries(held.moved).length >= before.length, text);
  for (const [from, to] of Object.entries(held.moved)) assert.ok(HEX.test(from) && HEX.test(to), text);
}

/** A learned workflow `name`'s two files as a run writes them, each saying `word`. */
const flow = (name, word) => [
  { path: `workflows/${name}/README.md`, text: `---\nname: ${name}\ndescription: ${word} answers ${name}; use when asked\n---\n` },
  { path: `workflows/${name}/workflow.json`, text: `${JSON.stringify({ name, says: `${word} flow ${name}` })}\n` },
];

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
    // The real API's head read right after a 409 can lag (the pre-write head), so live checks the counts alone.
    if (kind !== "code.storage live") {
      assert.equal(lost[0].stale, won[0].saved);
      assert.equal(await store.head(), won[0].saved);
    }
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

  test(`${kind}: a purge leaves the purged run's line in no tree older than another run's merge of the same words: its own merge, a merge between, and the owner's removal hold none, and no diff shows it`, async (t) => {
    const store = await make(t);
    const { forgetRunText, learningCommit, putCorrections, readSnapshot } = await learn();
    const shared = "the same words later";
    const merge = async (runId, correction) => assert.equal((await learningCommit(store, { runId, reason: `${runId} reason words`, files: [], correction })).ok, true, runId);
    await merged(store, "ALPHA");
    await merge("run_gone", shared);
    // Another run merges while the purged run's line is on main: its diff shows that line as context.
    await merge("run_between", "BETWEEN line from the owner");
    const snap = await readSnapshot(store);
    const text = (await store.read(snap.main, ["corrections.md"]))[0].body.toString("utf8");
    assert.equal((await putCorrections(store, { text: text.replace(`- ${shared}\n`, ""), ifMatch: snap.corrections.oid })).ok, true);
    await merge("run_later", shared);
    assert.ok("commit" in (await forgetRunText(store, "run_gone")));
    const log = await store.log(await store.head());
    const later = log.findIndex(({ message }) => message.includes("Run-Id: run_later"));
    assert.ok(later >= 0);
    // Every commit older than the later run's merge, and every diff of one, holds none of the words.
    for (const { sha } of log.slice(later + 1)) {
      const held = Buffer.from((await store.read(sha, ["corrections.md"]))?.[0]?.body ?? "").toString("utf8");
      assert.ok(!held.includes(shared), `${sha}: ${held}`);
      assert.ok(!JSON.stringify((await store.diff(sha)) ?? []).includes(shared), sha);
    }
    assert.equal((await store.read(log[later].sha, ["corrections.md"]))[0].body.toString("utf8"), `- ALPHA line from the owner\n- BETWEEN line from the owner\n- ${shared}\n`);
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

  test(`${kind}: a purge takes the purged run's workflows out of every tree: one it alone learned is in no tree, read or diff; one a later run wrote after it is that run's from its merge on and in no tree before; the other runs' things stay`, async (t) => {
    const store = await make(t);
    const { forgetRunText, learningCommit, readSnapshot, runMergeOf } = await learn();
    const merge = async (change) => assert.equal((await learningCommit(store, change)).ok, true, change.runId);
    await merge({ runId: "run_alpha", reason: "ALPHA reason words", files: flow("w", "ALPHA"), correction: "ALPHA line from the owner" });
    await merge({ runId: "run_bravo", reason: "BRAVO reason words", files: [...flow("y", "BRAVO"), ...flow("x", "BRAVO")], correction: "BRAVO line from the owner" });
    // A hand commit between B's merge and C's (the owner's own line): it changes no workflow's owner.
    const head = await store.head();
    const text = (await store.read(head, ["corrections.md"]))[0].body.toString("utf8");
    assert.ok("saved" in (await save(store, head, [{ path: "corrections.md", text: `${text}- a hand line\n` }])));
    await merge({ runId: "run_charlie", reason: "CHARLIE reason words", files: flow("x", "CHARLIE") });
    const alphaBefore = (await runMergeOf(store, "run_alpha")).files;
    const charlieX = await store.read(await store.head(), ["workflows/x/README.md", "workflows/x/workflow.json"]);

    assert.ok("commit" in (await forgetRunText(store, "run_bravo")));
    // (1) B's text (its workflow y, its text of x, its line and its reason) is in no tree, read, message or diff.
    assert.doesNotMatch(await everything(store), /BRAVO/);
    const tip = await store.head();
    assert.deepEqual(paths(await store.read(tip)).filter((path) => path.startsWith("workflows/")), ["workflows/w/README.md", "workflows/w/workflow.json", "workflows/x/README.md", "workflows/x/workflow.json"]);
    // (2) x at the tip and at C's merge is C's.
    const charlie = await runMergeOf(store, "run_charlie");
    for (const at of [tip, charlie.merge]) assert.deepEqual(await store.read(at, ["workflows/x/README.md", "workflows/x/workflow.json"]), charlieX, at);
    assert.deepEqual((await readSnapshot(store)).workflows.map(({ name, run }) => [name, run]), [["w", "run_alpha"], ["x", "run_charlie"]]);
    // (3) No tree from B's merge up to C's holds x.
    const log = await store.log(tip);
    const from = log.findIndex(({ message }) => message.includes("Run-Id: run_bravo"));
    const to = log.findIndex(({ sha }) => sha === charlie.merge);
    assert.ok(to >= 0 && from > to, JSON.stringify(log.map(({ message }) => message)));
    for (const { sha } of log.slice(to + 1, from + 1)) assert.deepEqual(paths(await store.read(sha)).filter((path) => path.startsWith("workflows/x/")), [], sha);
    // (4) A's things stay: its merge's diff, its workflow and its line at the tip.
    assert.deepEqual((await runMergeOf(store, "run_alpha")).files, alphaBefore);
    assert.equal((await store.read(tip, ["workflows/w/README.md"]))[0].body.toString("utf8"), flow("w", "ALPHA")[0].text);
    assert.equal((await store.read(tip, ["corrections.md"]))[0].body.toString("utf8"), "- ALPHA line from the owner\n- a hand line\n");
  });

  test(`${kind}: a purge takes out each workflow file the purged run wrote last, file by file: a later run that rewrote only workflow.json keeps its file, and the purged run's README.md leaves every tree (its workflow reads incomplete)`, async (t) => {
    const store = await make(t);
    const { forgetRunText, learningCommit, readSnapshot } = await learn();
    await merged(store, "ALPHA");
    assert.equal((await learningCommit(store, { runId: "run_bravo", reason: "BRAVO reason words", files: flow("x", "BRAVO") })).ok, true);
    const charlieFlow = flow("x", "CHARLIE")[1];
    assert.equal((await learningCommit(store, { runId: "run_charlie", reason: "CHARLIE reason words", files: [charlieFlow] })).ok, true);
    assert.ok("commit" in (await forgetRunText(store, "run_bravo")));
    assert.doesNotMatch(await everything(store), /BRAVO/);
    const tip = await store.head();
    assert.deepEqual(paths(await store.read(tip)).filter((path) => path.startsWith("workflows/")), ["workflows/x/workflow.json"]);
    assert.equal((await store.read(tip, ["workflows/x/workflow.json"]))[0].body.toString("utf8"), charlieFlow.text);
    assert.deepEqual((await readSnapshot(store)).workflows.map(({ name }) => name), [], "x reads incomplete: its README.md was the purged run's");
  });

  test(`${kind}: a purge of a run that learned a workflow and no line takes that workflow out of every tree and leaves the other runs' things`, async (t) => {
    const store = await make(t);
    const { forgetRunText, learningCommit, readSnapshot, runMergeOf } = await learn();
    await merged(store, "ALPHA");
    assert.equal((await learningCommit(store, { runId: "run_bravo", reason: "BRAVO reason words", files: flow("y", "BRAVO") })).ok, true);
    await merged(store, "CHARLIE");
    const alphaBefore = (await runMergeOf(store, "run_alpha")).files;
    const done = await forgetRunText(store, "run_bravo");
    assert.match(done.commit ?? "", HEX, JSON.stringify(done));
    assert.doesNotMatch(await everything(store), /BRAVO/);
    assert.deepEqual(paths(await store.read(await store.head())).filter((path) => path.startsWith("workflows/")), []);
    assert.deepEqual((await readSnapshot(store)).workflows, []);
    assert.deepEqual((await runMergeOf(store, "run_alpha")).files, alphaBefore);
    assert.equal((await store.read(await store.head(), ["corrections.md"]))[0].body.toString("utf8"), "- ALPHA line from the owner\n- CHARLIE line from the owner\n");
  });

  // A purge takes off only what the purged run's revisions put there: each workflow file the purged run wrote last holds
  // the bytes it had in the rebuilt parent of that run's merge (absent there: absent), so no other run's file goes.
  // run-purge-workflow.test.mjs runs #3458's cases on main through the server; these add what they don't check: every
  // rewritten tree, not main alone, and a revision of one file of a workflow.
  test(`${kind}: a purge gives back the workflow the purged run revised in every rewritten tree: A's v1 in each from B's merge on, its snapshot entry A's again, and a workflow B wrote alone in none`, async (t) => {
    const store = await make(t);
    const { forgetRunText, learningCommit, readSnapshot, runMergeOf } = await learn();
    const merge = async (change) => assert.equal((await learningCommit(store, change)).ok, true, change.runId);
    await merge({ runId: "run_alpha", reason: "ALPHA reason words", files: flow("x", "ALPHA") });
    await merge({ runId: "run_bravo", reason: "BRAVO reason words", files: [...flow("x", "BRAVO"), ...flow("y", "BRAVO")] });
    const alpha = await runMergeOf(store, "run_alpha");
    const v1 = await store.read(alpha.merge, ["workflows/x/README.md", "workflows/x/workflow.json"]);
    assert.ok("commit" in (await forgetRunText(store, "run_bravo")));
    assert.doesNotMatch(await everything(store), /BRAVO/);
    const tip = await store.head();
    const log = await store.log(tip);
    const from = log.findIndex(({ message }) => message.includes("Run-Id: run_bravo"));
    assert.ok(from >= 0, JSON.stringify(log.map(({ message }) => message)));
    for (const { sha } of log.slice(0, from + 1)) {
      assert.deepEqual(await store.read(sha, ["workflows/x/README.md", "workflows/x/workflow.json"]), v1, `A's x at ${sha}`);
      assert.deepEqual(paths(await store.read(sha)).filter((path) => path.startsWith("workflows/y/")), [], `no y at ${sha}`);
    }
    assert.deepEqual((await readSnapshot(store)).workflows.map(({ name, run }) => [name, run]), [["x", "run_alpha"]]);
  });

  test(`${kind}: a purge gives back the file the purged run revised alone: B rewrote only x's workflow.json, and A's README.md and workflow.json are at the tip, x's entry A's`, async (t) => {
    const store = await make(t);
    const { forgetRunText, learningCommit, readSnapshot } = await learn();
    assert.equal((await learningCommit(store, { runId: "run_alpha", reason: "ALPHA reason words", files: flow("x", "ALPHA") })).ok, true);
    const v1 = await store.read(await store.head(), ["workflows/x/README.md", "workflows/x/workflow.json"]);
    assert.equal((await learningCommit(store, { runId: "run_bravo", reason: "BRAVO reason words", files: [flow("x", "BRAVO")[1]] })).ok, true);
    assert.ok("commit" in (await forgetRunText(store, "run_bravo")));
    assert.doesNotMatch(await everything(store), /BRAVO/);
    assert.deepEqual(await store.read(await store.head(), ["workflows/x/README.md", "workflows/x/workflow.json"]), v1);
    assert.deepEqual((await readSnapshot(store)).workflows.map(({ name, run }) => [name, run]), [["x", "run_alpha"]]);
  });

  test(`${kind}: a purge keeps a later run's revision in every rewritten tree: A v1, B v2, C v3, purge B: C's v3 from C's merge on, A's v1 between B's merge and C's; a purge again changes no tree`, async (t) => {
    const store = await make(t);
    const { forgetRunText, learningCommit, readSnapshot, runMergeOf } = await learn();
    for (const word of ["ALPHA", "BRAVO", "CHARLIE"]) assert.equal((await learningCommit(store, { runId: `run_${word.toLowerCase()}`, reason: `${word} reason words`, files: flow("x", word) })).ok, true);
    const files = ["workflows/x/README.md", "workflows/x/workflow.json"];
    const v1 = await store.read((await runMergeOf(store, "run_alpha")).merge, files);
    const v3 = await store.read(await store.head(), files);
    assert.ok("commit" in (await forgetRunText(store, "run_bravo")));
    assert.doesNotMatch(await everything(store), /BRAVO/);
    const tip = await store.head();
    const log = await store.log(tip);
    const charlie = log.findIndex(({ message }) => message.includes("Run-Id: run_charlie"));
    const bravo = log.findIndex(({ message }) => message.includes("Run-Id: run_bravo"));
    assert.ok(charlie >= 0 && bravo > charlie, JSON.stringify(log.map(({ message }) => message)));
    for (const { sha } of log.slice(0, charlie + 1)) assert.deepEqual(await store.read(sha, files), v3, `C's x at ${sha}`);
    for (const { sha } of log.slice(charlie + 1, bravo + 1)) assert.deepEqual(await store.read(sha, files), v1, `A's x at ${sha}`);
    assert.deepEqual((await readSnapshot(store)).workflows.map(({ name, run }) => [name, run]), [["x", "run_charlie"]]);
    // A purge again changes nothing: main, every tree.
    const trees = await Promise.all(log.map(async ({ sha }) => [sha, paths(await store.read(sha))]));
    const again = await forgetRunText(store, "run_bravo");
    assert.equal(again.nothing, "purged", JSON.stringify(again));
    assert.equal(await store.head(), tip);
    assert.deepEqual(await Promise.all((await store.log(tip)).map(async ({ sha }) => [sha, paths(await store.read(sha))])), trees);
  });

  // Greptile P1 on #3415 (purge.ts:137), red before its fix: A wrote x v1, B v2, C v1 again (the same bytes as A's).
  // The purge of B gives back A's v1 under B's merge, so C's rewritten merge no longer changes x's bytes; a purge of A
  // then must still leave C's x, the bytes C's merge wrote, never take it off as A's.
  test(`${kind}: a run whose merge wrote back an older run's bytes keeps them through two purges: A v1, B v2, C v1, purge B then A: C's v1 stays, its entry C's`, async (t) => {
    const store = await make(t);
    const { forgetRunText, learningCommit, readSnapshot } = await learn();
    for (const [word, said] of [["ALPHA", "ALPHA"], ["BRAVO", "BRAVO"], ["CHARLIE", "ALPHA"]]) assert.equal((await learningCommit(store, { runId: `run_${word.toLowerCase()}`, reason: `${word} reason words`, files: flow("x", said) })).ok, true);
    const files = ["workflows/x/README.md", "workflows/x/workflow.json"];
    const v1 = await store.read(await store.head(), files);
    assert.ok("commit" in (await forgetRunText(store, "run_bravo")));
    assert.ok("commit" in (await forgetRunText(store, "run_alpha")));
    assert.deepEqual(await store.read(await store.head(), files), v1, "C's x is at the tip");
    assert.deepEqual((await readSnapshot(store)).workflows.map(({ name, run }) => [name, run]), [["x", "run_charlie"]]);
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
    assert.equal((await forgetRunText(store, "run_bravo")).nothing, "purged");
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
      assert.equal((await forgetRunText(store, "run_bravo")).nothing, "purged");
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
      assert.equal((await forgetRunText(store, "run_bravo")).nothing, "purged");
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

  // The lead's second read on #3415 (P2-1), red before its fix: a history whose commits do not chain (one left out
  // between two, or the oldest naming a parent) is a history read short. Rebuilt from, the purged run's merges left out
  // would keep its bytes, and a commit left out would lose another run's files: the purge refuses, retryable.
  test(`${kind}: a purge refuses a history that does not chain (a commit left out between two, or the oldest naming a parent): retryable, main and every tree as they were`, async (t) => {
    const store = await make(t);
    const { forgetRunText } = await learn();
    await merged(store, "ALPHA", "BRAVO", "CHARLIE");
    const live = await store.head();
    const before = await everything(store);
    const whole = (await store.log(live)).map(({ sha }) => sha);
    assert.ok(whole.length >= 3, JSON.stringify(whole));
    for (const [why, cut] of [["a commit left out between two", (log) => log.filter((_, i) => i !== 1)], ["the oldest left out", (log) => log.slice(0, -1)]]) {
      // The store as it is, but for a whole-history log that comes back cut.
      const short = { ...store, log: async (ref, options) => {
        const log = await store.log(ref, options);
        return log && !options?.path && !options?.limit ? cut(log) : log;
      } };
      await assert.rejects(forgetRunText(short, "run_bravo"), (error) => error.name === "FolderUnreadable", why);
      assert.equal(await store.head(), live, why);
    }
    assert.equal(await everything(store), before, "every tree as it was");
    assert.deepEqual((await store.log(live)).map(({ sha }) => sha), whole);
  });
}

test("local: a save whose checkout a purge overtook (main moved between the save's compare and swap and its checkout) leaves the working tree at main as it stands, never at the save's own older commit", async (t) => {
  const store = await STORES.local(t);
  const { localStoreHooks } = await import("../dist/learn/store-local.js");
  const clean = (await save(store, null, [{ path: "corrections.md", text: "- clean\n" }])).saved;
  // A git in front of the script's: armed, its first read-tree is a purge's landing first (main moved to the clean
  // commit, checked out), then the save's own read-tree runs.
  const bin = mkdtempSync(join(tmpdir(), "learn-git-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const arm = join(bin, "arm");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = read-tree ] && [ -f "${arm}" ]; then\n    to=$(cat "${arm}"); rm -f "${arm}"\n    /usr/bin/git update-ref refs/heads/main "$to" && /usr/bin/git read-tree -u --reset "$to" || exit 9\n    break\n  fi\ndone\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  localStoreHooks.env = { PATH: `${bin}:/usr/bin:/bin` };
  t.after(() => {
    localStoreHooks.env = undefined;
  });
  writeFileSync(arm, clean);
  const done = await save(store, clean, [{ path: "corrections.md", text: "- clean\n- PURGED words\n" }]);
  assert.match(done.saved ?? "", HEX, JSON.stringify(done));
  assert.equal(existsSync(arm), false, "the purge landed between the save's compare and swap and its checkout");
  assert.equal(await store.head(), clean, "main is the purge's");
  assert.equal(readFileSync(join(gitDirOf(store.data), "..", "corrections.md"), "utf8"), "- clean\n", "the working tree is main's: the save checked main out again");
});

test("local: a git past the script's deadline is killed with the script, its whole group: the call fails at the deadline, never waits on the pipes a stuck git holds open", async (t) => {
  const store = await STORES.local(t);
  const { localStoreHooks } = await import("../dist/learn/store-local.js");
  const head = (await save(store, null, [{ path: "corrections.md", text: "- one\n" }])).saved;
  // A git in front of the script's: armed, its ls-tree (a read's, writing to the script's stdout) says its pid and
  // hangs, holding the script's stdout and stderr open.
  const bin = mkdtempSync(join(tmpdir(), "learn-git-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const arm = join(bin, "arm");
  const pidFile = join(bin, "pid");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = ls-tree ] && [ -f "${arm}" ]; then rm -f "${arm}"; echo $$ > "${pidFile}"; exec sleep 30; fi\ndone\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
  localStoreHooks.env = { PATH: `${bin}:/usr/bin:/bin` };
  localStoreHooks.timeoutMs = 500;
  t.after(() => {
    localStoreHooks.env = undefined;
    localStoreHooks.timeoutMs = undefined;
  });
  writeFileSync(arm, "");
  const started = Date.now();
  await assert.rejects(store.read(head), /did not finish in 0\.5 s/);
  assert.equal(existsSync(arm), false, "the read's ls-tree was the stuck git");
  assert.ok(Date.now() - started < 10_000, `the call ended near its deadline, not when the stuck git let go (${Date.now() - started} ms)`);
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(alive(), false, "the stuck git is gone: its group was killed with the script");
});

test("local: every git the script runs flushes what it commits (core.fsync=committed): a save reported done survives a crash", async (t) => {
  const store = await STORES.local(t);
  const { localStoreHooks } = await import("../dist/learn/store-local.js");
  const dir = mkdtempSync(join(tmpdir(), "learn-trace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const trace = join(dir, "trace.json");
  localStoreHooks.env = { GIT_TRACE2_EVENT: trace };
  t.after(() => {
    localStoreHooks.env = undefined;
  });
  const first = await save(store, null, [{ path: "corrections.md", text: "- one\n" }]);
  await save(store, first.saved, [{ path: "corrections.md", text: "- one\n- two\n" }]);
  const starts = readFileSync(trace, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.event === "start" && !event.sid.includes("/") && event.argv[1] !== "--version");
  // The script's own gits (a git's children inherit its -c settings), past the version check that writes nothing.
  assert.ok(starts.length > 0, "the trace saw the script's gits");
  const unflushed = starts.filter(({ argv }) => !argv.some((arg, i) => arg === "-c" && argv[i + 1] === "core.fsync=committed"));
  assert.deepEqual(unflushed.map(({ argv }) => argv.join(" ")), [], "every git runs with core.fsync=committed");
});

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
  const before = (await store.log(await store.head())).map(({ sha }) => sha);
  writeFileSync(join(git, "index.lock"), "");
  await assert.rejects(forgetRunText(store, "run_bravo"), /working tree/);
  assert.equal(existsSync(join(git, "agentrun-tidy")), true, "the tidy mark stays while the checkout is not done");
  rmSync(join(git, "index.lock"));
  const retried = await forgetRunText(store, "run_bravo");
  assert.equal(retried.nothing, "purged", JSON.stringify(retried));
  await movedAll(store, before, retried);
  assert.doesNotMatch(corrections(), /BRAVO/);
  assert.match(corrections(), /ALPHA line/);
  assert.equal(existsSync(join(git, "agentrun-tidy")), false);
});

/** What a store answers at commits of a history a purge moved main off (`old`: its head; `merge`: the purged run's
 *  merge), main at `now`: nothing held, so no read, log or diff, and no save seeded from one or the same as one. */
async function unheld(store, { old, merge, now }) {
  for (const sha of [old, merge]) {
    assert.equal(await store.read(sha), undefined, `no read at ${sha}`);
    assert.equal(await store.read(sha, ["corrections.md"]), undefined, `no read of a path at ${sha}`);
    assert.equal(await store.log(sha), undefined, `no log at ${sha}`);
    assert.equal(await store.diff(sha), undefined, `no diff at ${sha}`);
  }
  const write = [{ path: "workflows/z/README.md", text: "z\n" }];
  assert.deepEqual(await save(store, now, write, { seed: merge }), { refused: { absent: [], same: [], seed: merge } });
  assert.deepEqual(await save(store, now, write, { same: [{ commit: old, path: "corrections.md" }] }), { refused: { absent: [], same: ["corrections.md"] } });
  assert.ok(((await store.read(now)) ?? []).length > 0, "main reads as ever");
  assert.equal(await store.head(), now);
}

// The lead's second read on #3415 (P3 a), red before its fix: between a rewrite moving main and its tidy, the old
// history's commits are still objects in the folder, so a tidy that failed (an index.lock left behind) left the purged
// run's commits, and a champion promoted at one, readable until a purge was sent again. While the tidy mark is there,
// the folder holds a commit only when main reaches it.
test("local: a purge whose tidy fails leaves the old history unheld until a purge sent again tidies: no read, log or diff at its commits, no save seeded from one or the same as one", async (t) => {
  const store = await STORES.local(t);
  const { forgetRunText } = await learn();
  await merged(store, "ALPHA", "BRAVO", "CHARLIE");
  const git = gitDirOf(store.data);
  const old = await store.head();
  const merge = (await store.log(old)).find(({ message }) => message.includes("Run-Id: run_bravo")).sha;
  writeFileSync(join(git, "index.lock"), "");
  await assert.rejects(forgetRunText(store, "run_bravo"), /working tree/);
  assert.equal(existsSync(join(git, "agentrun-tidy")), true, "the tidy mark stays");
  const now = await store.head();
  assert.notEqual(now, old, "main moved to the rewritten history");
  // The objects are there still: git itself reaches them.
  assert.equal(spawnSync("git", ["--git-dir", git, "cat-file", "-e", `${merge}^{commit}`]).status, 0, "the purged run's merge is an object still");
  await unheld(store, { old, merge, now });
  rmSync(join(git, "index.lock"));
  assert.equal((await forgetRunText(store, "run_bravo")).nothing, "purged");
  assert.equal(existsSync(join(git, "agentrun-tidy")), false);
  await unheld(store, { old, merge, now });
});

test("code.storage: a purge whose old repository's delete fails leaves the old history unheld: the agent reads its next generation alone, no read, log or diff at the old commits, no save seeded from one or the same as one", async () => {
  const { forgetRunText } = await learn();
  let refuse = true;
  const store = await wrappedStore((inner) => async (url, init) => (refuse && init?.method === "DELETE" && repoOf(init) === `agentrun-${SRV}-agent-one-g0` ? new Response(JSON.stringify({ error: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } }) : inner(url, init)));
  await merged(store, "ALPHA", "BRAVO", "CHARLIE");
  const old = await store.head();
  const merge = (await store.log(old)).find(({ message }) => message.includes("Run-Id: run_bravo")).sha;
  await assert.rejects(forgetRunText(store, "run_bravo"), (error) => error.name === "FolderUnreadable");
  assert.ok(store.fake.repos.has(`agentrun-${SRV}-agent-one-g0`), "the old repository is there still");
  await unheld(store, { old, merge, now: await store.head() });
  refuse = false;
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

// #3458 round 2, rule (4), red before its fix: a history read that comes back short is unknown history. A 404 on a
// page of main's commit listing (a repository read mid-flip, say) ends log()'s listing early; the purge must refuse,
// retryable, and leave main as it was: never purge a history it read short, never report a run unmerged on one.
test("code.storage: round 2 (4): a purge whose history listing comes back 404 refuses, retryable, and leaves main and its history whole", async () => {
  const { forgetRunText } = await learn();
  let gone = false;
  const store = await wrappedStore((inner) => async (url, init) => {
    if (gone && (init?.method ?? "GET") === "GET" && new URL(url).pathname.endsWith("/repos/commits")) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    return inner(url, init);
  });
  await merged(store, "ALPHA", "BRAVO");
  const live = await store.head();
  const before = await everything(store);
  const history = (await store.log(live)).map(({ sha }) => sha);
  gone = true;
  for (const run of ["run_bravo", "run_alpha"]) {
    const done = await forgetRunText(store, run).then((one) => one, (error) => ({ refused: error.name }));
    assert.deepEqual(done, { refused: "FolderUnreadable" }, `${run}: the purge refused on a short history`);
  }
  gone = false;
  assert.equal(await store.head(), live, "main never moved");
  assert.equal(await everything(store), before, "every tree as it was");
  assert.deepEqual((await store.log(live)).map(({ sha }) => sha), history, "the whole history is still there");
});

// The lead's second read on #3415 (P2-1), red before its fix: a listing page that says has_more with no cursor to read
// the rest by is a listing cut short. Read as the whole, a commit's short file listing in a purge's rebuild drops other
// runs' files, and a short history leaves the purged run's early merges (its bytes stay). The store unavailable,
// retryable.
test("code.storage: a listing that says has_more with no cursor (a commit's files, main's history) is the store unavailable, never a short answer: the read, the log and a purge refuse, retryable, main and every tree as they were", async () => {
  const { forgetRunText } = await learn();
  let cut;
  const store = await wrappedStore((inner) => async (url, init) => {
    const response = await inner(url, init);
    if (!cut || !response.ok || !new URL(url).pathname.endsWith(`/repos/${cut}`)) return response;
    const page = await response.json();
    const list = cut === "files" ? "entries" : "commits";
    const short = page[list].length < 2 ? page : { ...page, [list]: page[list].slice(0, 1), ...(page.paths ? { paths: page.paths.slice(0, 1) } : {}), has_more: true, next_cursor: null };
    return new Response(JSON.stringify(short), { status: response.status, headers: { "content-type": "application/json" } });
  });
  await merged(store, "ALPHA", "BRAVO", "CHARLIE", "DELTA");
  const live = await store.head();
  const before = await everything(store);
  for (const which of ["files", "commits"]) {
    cut = which;
    await assert.rejects(which === "files" ? store.read(live) : store.log(live), (error) => error.name === "FolderUnreadable", `${which}: the read refused`);
    await assert.rejects(forgetRunText(store, "run_bravo"), (error) => error.name === "FolderUnreadable", `${which}: the purge refused`);
    cut = undefined;
    assert.equal(await store.head(), live, which);
  }
  assert.equal(await everything(store), before, "every tree as it was");
});

// The lead's second read on #3415 (P2-2), red before its fix: agent ids differing only by case (`Foo`, `foo`) named
// repositories differing only by case, so an API naming repositories without regard to case keeps both agents'
// learning in one (and one's purge or erasure takes the other's). The plain form takes lowercase letters, digits,
// dashes and underscores alone; any other id is the hash form, its readable part lowercased (the hash, over the id as
// it is, keeps it its own).
test("code.storage: agent ids differing only by case name repositories that differ without regard to case: on an API naming them caselessly, Foo's learning is not foo's and Foo's erasure leaves foo's; an id with a capital is refused by the guard", async () => {
  const { agentrunRepo, codeStorageLearningStore, repoIdOf, RepoIdRefused } = await import("../dist/learn/code-storage.js");
  const ids = ["Foo", "foo", "FOO", "fOo"].map((agent) => repoIdOf(SRV, agent));
  for (const id of ids) assert.equal(id, id.toLowerCase(), id);
  assert.equal(new Set(ids.map((id) => id.toLowerCase())).size, ids.length, JSON.stringify(ids));
  assert.equal(ids[1], `agentrun-${SRV}-foo-g0`, "a lowercase id keeps the plain form");
  assert.match(ids[0], new RegExp(`^agentrun-${SRV}-h-foo-[0-9a-f]{24}-g0$`));
  assert.throws(() => agentrunRepo(`agentrun-${SRV}-Foo-g0`), RepoIdRefused);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const fake = codeStorageFake({ name: "example-org", publicKey, caseless: true });
  FAKES.push(fake);
  const settings = { name: "example-org", key: privateKey.export({ type: "pkcs8", format: "pem" }), apiUrl: "https://api.example-org.code.storage.invalid", fetch: fake.fetch, serverId: async () => SRV };
  const [upper, lower] = ["Foo", "foo"].map((agent) => codeStorageLearningStore(settings, agent));
  assert.match((await save(upper, null, [{ path: "corrections.md", text: "- Foo's line\n" }])).saved ?? "", HEX);
  assert.equal(await lower.head(), null, "foo has learned nothing");
  const two = (await save(lower, null, [{ path: "corrections.md", text: "- foo's line\n" }])).saved;
  assert.match(two ?? "", HEX);
  await upper.remove({ erase: true });
  assert.equal(await upper.head(), null);
  assert.equal(await lower.head(), two, "Foo's erasure left foo's learning");
});

// The lead's second read on #3415 (P3 c), red before its fix: a failure's words carry up to 300 characters of what the
// API answered, into errors and logs, so an API echoing the request's bearer token put the token there. The token
// sent is cut from them, "[token]" in its place.
test("code.storage: an API failure that echoes the bearer token sent (in a JSON error or plain text) says [token] in its words, never the token", async () => {
  const sent = [];
  let echo;
  const store = await wrappedStore((inner) => async (url, init) => {
    if (!echo) return inner(url, init);
    const bearer = String(init?.headers?.authorization ?? "").replace(/^Bearer /, "");
    sent.push(bearer);
    const said = `the token ${bearer} is refused`;
    return echo === "json" ? new Response(JSON.stringify({ error: said }), { status: 500, headers: { "content-type": "application/json" } }) : new Response(said, { status: 500, headers: { "content-type": "text/plain" } });
  });
  for (const kind of ["json", "text"]) {
    echo = kind;
    sent.length = 0;
    const error = await store.head().then(() => assert.fail("the call failed"), (failure) => failure);
    assert.equal(error.name, "FolderUnreadable", kind);
    assert.ok(sent.length > 0 && sent.every((token) => token.length > 100), kind);
    for (const token of sent) assert.ok(!error.message.includes(token.slice(0, 40)), `${kind}: ${error.message}`);
    assert.match(error.message, /the token \[token\] is refused/, kind);
  }
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
  const before = (await store.log(await store.head())).map(({ sha }) => sha);
  await assert.rejects(forgetRunText(store, "run_bravo"), (error) => error.name === "FolderUnreadable");
  assert.match(fakeText(store.fake), /BRAVO/, "the old repository is left");
  assert.doesNotMatch(await everything(store), /BRAVO/, "the agent is on the next generation");
  await assert.rejects(forgetRunText(store, "run_bravo"), (error) => error.name === "FolderUnreadable");
  refuse = false;
  const retried = await forgetRunText(store, "run_bravo");
  assert.equal(retried.nothing, "purged", JSON.stringify(retried));
  await movedAll(store, before, retried);
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

test("code.storage: a token is signed only for a repository of the signing server's own id: server A asked to sign for agentrun-<B>-agent-one-g0 (another server's agent) refuses before its key is read, so no call for it is made; its own agentrun-<A>-... is signed", async () => {
  const { repoToken, RepoIdRefused } = await import("../dist/learn/code-storage.js");
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const A = SRV;
  const B = "ba9876543210";
  const claimsOf = (token) => JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  const org = { name: "example-org", key: () => privateKey };
  assert.equal(claimsOf(repoToken(org, A, `agentrun-${A}-agent-one-g0`, ["git:read"])).repo, `agentrun-${A}-agent-one-g0`);
  assert.equal(claimsOf(repoToken(org, B, `agentrun-${B}-agent-one-g3`, ["repo:write"])).repo, `agentrun-${B}-agent-one-g3`);
  const unread = { name: "example-org", key: () => assert.fail("the key is read for a repository refused") };
  for (const repo of [`agentrun-${B}-agent-one-g0`, `agentrun-${B}-agent-one-g1`, `agentrun-${A.slice(0, 11)}0-agent-one-g0`, `agentrun-${B}-${A}-agent-one-g0`]) {
    assert.throws(() => repoToken(unread, A, repo, ["git:read"]), RepoIdRefused, repo);
  }
  // A signing server id that is no server id (not 12 hex digits) signs for none.
  for (const server of ["", "x", A.toUpperCase(), `${A}-agent-one`]) assert.throws(() => repoToken(unread, server, `agentrun-${A}-agent-one-g0`, ["git:read"]), RepoIdRefused, server);
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

test("code.storage: no call follows a redirect: the API answering one with a 302 to another origin fails that call, and the redirect's target gets no request, so the bearer token never rides it", async (t) => {
  const { createServer } = await import("node:http");
  const { codeStorageLearningStore } = await import("../dist/learn/code-storage.js");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const fake = codeStorageFake({ name: "example-org", publicKey });
  const listen = (server) => new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));
  // The redirect's target: every request it gets, with its Authorization header.
  const elsewhere = [];
  const other = createServer((request, response) => {
    elsewhere.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ commits: [] }));
  });
  const otherPort = await listen(other);
  // The API: the fake over real HTTP, but its first history read answered 302 to the other origin.
  let redirected = 0;
  const api = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.method === "GET" && request.url.startsWith("/api/v1/repos/commits") && redirected++ === 0) return response.writeHead(302, { location: `http://127.0.0.1:${otherPort}${request.url}` }).end();
    const answer = await fake.fetch(new URL(request.url, "https://api.example-org.code.storage.invalid"), { method: request.method, headers: request.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    response.writeHead(answer.status, Object.fromEntries(answer.headers)).end(Buffer.from(await answer.arrayBuffer()));
  });
  const apiPort = await listen(api);
  t.after(() => {
    other.close();
    api.close();
  });
  // The real fetch (no `fetch` given), as the server runs it.
  const store = codeStorageLearningStore({ name: "example-org", key: privateKey.export({ type: "pkcs8", format: "pem" }), apiUrl: `http://127.0.0.1:${apiPort}`, serverId: async () => SRV }, "agent-one");
  await assert.rejects(store.head(), (error) => error?.name === "FolderUnreadable", "the redirected call fails, the store unavailable");
  assert.equal(redirected, 1, "the API answered the call with its redirect");
  assert.deepEqual(elsewhere, [], "the redirect's target got no request (no Authorization header reached it)");
  // The next call, answered by the API itself, goes on as usual.
  assert.equal(await store.head(), null);
});

test("code.storage: every repository id the whole suite sent is agentrun-<12 hex>-... (no other repository of the org is created, read, written or deleted), no call listed repositories, and every call refused redirects", () => {
  const sent = FAKES.flatMap((fake) => fake.calls);
  assert.ok(sent.length > 50, `the suite's calls: ${sent.length}`);
  assert.deepEqual(sent.filter((call) => call.redirect !== "error"), [], "every fetch passes redirect: \"error\"");
  for (const call of sent) assert.match(String(call.repo), GUARD, JSON.stringify(call));
  for (const call of sent) assert.match(String(call.repo), /^agentrun-[0-9a-f]{12}-[a-z0-9_-]+$/, JSON.stringify(call));
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
