// A run's census (run-census.ts): where in each of its files the secrets its caller handed it sat when its end erased them,
// never the secrets. Proven here, below the server:
//   - censusOf counts each text file a cut read would serve, with the byte ranges redactSecrets cuts (multibyte text
//     too), "whole" where the text is cut whole, and leaves out what a cut read refuses (not text, over the cap, a NUL);
//   - censusCut cuts a file by its entry only while its bytes are the ones counted, and withholds ("unreadable") a file
//     with no entry, changed bytes, a marker, or ranges that don't fall on the text's characters;
//   - censusAfter keeps, over an earlier end's census, only the files both ends counted byte for byte, with both cuts;
//   - the store: a launch takes CENSUS_PENDING with its first sealed bytes; an end writes its census in the erased
//     secrets' place only when it was made under those bytes, else CENSUS_UNSCANNED; an end with none (a runner from
//     before the census) leaves CENSUS_PENDING; a message's seal over that turns it to CENSUS_UNSCANNED, and over a
//     census keeps it; every write that seals anew moves the run's list mark, so its kept listing is built again.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { redactSecrets } from "../dist/learn/secrets.js";
import { CENSUS_JSON_MAX, CENSUS_RANGES_MAX, censusAfter, censusCut, censusOf, fileMac } from "../dist/run-census.js";
import { RUN_FILE_CUT_MAX } from "../dist/run-files.js";
import { censusOnSeal } from "../dist/store/sqlite/run-launch.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly, raw, sqliteOnly } from "./store-target.mjs";

const { CENSUS_PENDING, CENSUS_UNSCANNED } = await import("../dist/store/index.js");

const KEY = `not-a-secret-${"census-model-key"}-7c41e2`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** The server's seal key, as a test holds one: each census names a file by a MAC under it. */
const SEAL = Buffer.alloc(32, 5);
const mac = (bytes) => fileMac(SEAL, bytes);

/** A scratch folder as a run's Workspace, its files `files` ({path: text | Buffer}). */
async function folder(t, files) {
  const root = await mkdtemp(join(tmpdir(), "census-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  }
  return { root, workspace: localWorkspace(root) };
}

/** What a cut read after the end serves for `text` under census `census` at `path`: the cut text, "[redacted]", or
 *  "withheld", by the rule cutRunFile applies. */
function readAfter(census, path, text, values = [], sealKey = SEAL) {
  const bytes = Buffer.from(text);
  const held = censusCut(census, path, bytes, text, sealKey);
  if (held === "unreadable") return "withheld";
  if (held === "whole") return "[redacted]";
  return redactSecrets(text, values, Buffer.byteLength(text), held);
}

test("censusOf counts each text file with the byte ranges of the handed values, multibyte text too, and leaves out what a cut read refuses; censusCut gives back the same cut while the bytes are the ones counted", async (t) => {
  const plain = `key=${KEY}\nthe rest stays.\n`;
  const wide = `ñandú → ${KEY} ✓ 日本 ${KEY}\n`;
  const { workspace } = await folder(t, {
    "notes.txt": plain,
    "out/wide.md": wide,
    "clean.json": JSON.stringify({ fine: true }),
    "shot.png": Buffer.from("89504e470d0a1a0a", "hex"),
    "nul.txt": Buffer.from(`a\u0000${KEY}`),
    "big.txt": "x".repeat(RUN_FILE_CUT_MAX + 1),
  });
  const census = await censusOf(workspace, [KEY], SEAL);
  assert.equal(census.v, 1);
  assert.equal(census.partial, undefined, "every file counted");
  assert.deepEqual(Object.keys(census.files).sort(), ["clean.json", "notes.txt", "out/wide.md"], "a type that isn't text, a NUL and a file over the cap are left out: a cut read refuses them");
  assert.deepEqual(census.files["notes.txt"], { mac: mac(Buffer.from(plain)), cut: [[4, 4 + KEY.length]] }, "the value's byte range, no value, no hash of one");
  assert.equal(JSON.stringify(census).includes(KEY), false, "the census holds no value");
  const at = Buffer.from(wide).indexOf(KEY);
  assert.deepEqual(census.files["out/wide.md"].cut[0], [at, at + KEY.length], "byte offsets of the UTF-8 bytes, past multibyte characters");
  assert.deepEqual(census.files["clean.json"].cut, [], "a file with none counted with nothing to cut");

  const json = JSON.stringify(census);
  assert.equal(readAfter(json, "notes.txt", plain), "key=[redacted]\nthe rest stays.\n");
  assert.equal(readAfter(json, "out/wide.md", wide), redactSecrets(wide, [KEY]), "cut where the values cut it");
  assert.equal(readAfter(json, "clean.json", JSON.stringify({ fine: true })), JSON.stringify({ fine: true }));
});

test("censusCut withholds a file with no entry, changed bytes, a marker, a damaged census, and ranges that don't fall on the text's characters", () => {
  const text = `ñ=${KEY}\n`;
  const bytes = Buffer.from(text);
  const from = Buffer.byteLength("ñ=");
  const good = JSON.stringify({ v: 1, files: { "a.txt": { mac: mac(bytes), cut: [[from, from + KEY.length]] } } });
  assert.equal(readAfter(good, "a.txt", text), "ñ=[redacted]\n", "the counted file is cut");
  assert.equal(readAfter(good, "b.txt", text), "withheld", "no entry: written after the end, or past the census's caps");
  assert.equal(readAfter(good, "a.txt", `${text}more\n`), "withheld", "changed since it was counted");
  for (const marker of [CENSUS_UNSCANNED, CENSUS_PENDING, "not json", JSON.stringify({ v: 2, files: {} }), JSON.stringify({ v: 1 })]) assert.equal(readAfter(marker, "a.txt", text), "withheld", marker);
  const forged = (cut) => JSON.stringify({ v: 1, files: { "a.txt": { mac: mac(bytes), cut } } });
  assert.equal(readAfter(forged([[1, 3]]), "a.txt", text), "withheld", "a range splitting ñ's two bytes");
  assert.equal(readAfter(forged([[from, bytes.length + 1]]), "a.txt", text), "withheld", "a range past the end");
  assert.equal(readAfter(forged([[4, 6], [2, 5]]), "a.txt", text), "withheld", "ranges out of order");
  assert.equal(readAfter(forged([[3, 3]]), "a.txt", text), "withheld", "an empty range");
  assert.equal(readAfter(forged("half"), "a.txt", text), "withheld");
  assert.equal(readAfter(forged("whole"), "a.txt", text), "[redacted]", "whole: the text is cut whole");
});

test("censusAfter keeps, over an earlier end's census, only the files both ends counted byte for byte, with both cuts; a marker before it gives none", () => {
  const next = { v: 1, files: { "same.txt": { mac: "aa", cut: [[10, 20]] }, "changed.txt": { mac: "bb", cut: [] }, "new.txt": { mac: "cc", cut: [] }, "whole.txt": { mac: "dd", cut: [[0, 2]] } } };
  assert.deepEqual(censusAfter(null, next), next, "no census before: this end's");
  assert.deepEqual(censusAfter(CENSUS_PENDING, next), next, "pending before: this end's");
  assert.equal(censusAfter(CENSUS_UNSCANNED, next), undefined, "a marker before: nothing says where the earlier secrets sat");
  assert.equal(censusAfter("damaged", next), undefined);
  const before = JSON.stringify({ v: 1, files: { "same.txt": { mac: "aa", cut: [[0, 5], [15, 30]] }, "changed.txt": { mac: "b0", cut: [] }, "whole.txt": { mac: "dd", cut: "whole" } } });
  assert.deepEqual(censusAfter(before, next), { v: 1, files: { "same.txt": { mac: "aa", cut: [[0, 5], [10, 30]] }, "whole.txt": { mac: "dd", cut: "whole" } } }, "a changed file and a new one have no entry: they may hold what the earlier turn was handed");
});

test("censusOnSeal: pending with a launch's first sealed bytes, unscanned over a pending an end erased with no census, an earlier census kept", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const census = JSON.stringify({ v: 1, files: {} });
  assert.equal(censusOnSeal(null, null, bytes), CENSUS_PENDING);
  assert.equal(censusOnSeal(null, null, null), null, "nothing sealed: no census");
  assert.equal(censusOnSeal(CENSUS_PENDING, bytes, bytes), CENSUS_PENDING, "a live launch sealed anew: still uncounted");
  assert.equal(censusOnSeal(CENSUS_PENDING, null, bytes), CENSUS_UNSCANNED, "an end erased them and wrote no census");
  assert.equal(censusOnSeal(census, null, bytes), census, "an earlier end's census stays: it says where that turn's sat");
  assert.equal(censusOnSeal(CENSUS_UNSCANNED, null, bytes), CENSUS_UNSCANNED);
});

test("the store: a sealed launch is pending; an end writes its census only when made under the bytes it erases, else unscanned; an end with none leaves pending; a message's seal over pending makes it unscanned", async (t) => {
  const { store, file } = await storeOn(t);
  await agentWithRevision(store);
  const sealedA = new Uint8Array([7, 7, 7, 1]);
  const sealedB = new Uint8Array([7, 7, 7, 2]);
  const census = JSON.stringify({ v: 1, files: { "a.txt": { mac: "aa", cut: [] } } });
  const make = (id, sealed) => store.runs.create({ id, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Answer." } }, sealed });
  const end = async (id, patch = {}) => store.runs.update(await store.claim(id, "runner-a", { leaseMs: 30_000 }), { state: "ended", summary: "Done.", ...patch });
  const launch = (id) => store.runs.launch(id);

  await make("none", null);
  assert.equal((await launch("none")).census, null, "never handed a secret: no census");
  await end("none", { census: { json: census, sealed: sealedA } });
  assert.equal((await launch("none")).census, null, "an end with nothing sealed writes none");

  await make("counted", sealedA);
  assert.equal((await launch("counted")).census, CENSUS_PENDING, "sealed at its start: pending");
  await end("counted", { census: { json: census, sealed: sealedA } });
  assert.deepEqual([(await launch("counted")).sealed, (await launch("counted")).census], [null, census], "erased, its census in their place");

  await make("other-bytes", sealedB);
  await end("other-bytes", { census: { json: census, sealed: sealedA } });
  assert.deepEqual([(await launch("other-bytes")).sealed, (await launch("other-bytes")).census], [null, CENSUS_UNSCANNED], "a census made under other bytes is not written");

  await make("no-census", sealedA);
  await end("no-census");
  assert.deepEqual([(await launch("no-census")).sealed, (await launch("no-census")).census], [null, CENSUS_UNSCANNED], "an end with none: unscanned");

  // A runner from before the census erases the sealed bytes and writes nothing else: pending stays, read as uncounted. A
  // message sealing new secrets over that turns it to unscanned, so its next turn's reads still withhold that end's files.
  await make("old-runner", sealedA);
  await store.runs.update(await store.claim("old-runner", "runner-a", { leaseMs: 30_000 }), { state: "ended", summary: "Done." });
  const db = await raw(file);
  try {
    // What that runner's end wrote of the launch: its sealed bytes erased, nothing else.
    await db.run("UPDATE run_launch SET sealed = NULL, census = ? WHERE run_id = ?", CENSUS_PENDING, "old-runner");
  } finally {
    await db.close();
  }
  assert.deepEqual([(await launch("old-runner")).sealed, (await launch("old-runner")).census], [null, CENSUS_PENDING], "pending with nothing sealed: an end erased them uncounted");
  await store.runs.reopen("old-runner", { kind: "steer", body: { text: "More." } }, { launchSealed: sealedB });
  assert.deepEqual([(await launch("old-runner")).sealed, (await launch("old-runner")).census], [sealedB, CENSUS_UNSCANNED], "a message's seal over it: unscanned, so that end's files stay withheld");

  // A run's cut grows by what its caller hands it only in a message's write (runs.command, runs.reopen), and that write
  // inserts the message's command, which moves the run's list mark (commands_list_moved): its kept listing, cut of the
  // server's secrets and the launch's values as they were, is built again under the new ones before a list shows it.
  const markBefore = await store.runs.listMark("counted");
  await store.runs.reopen("counted", { kind: "steer", body: { text: "More." } }, { launchSealed: sealedB });
  assert.deepEqual([(await launch("counted")).sealed, (await launch("counted")).census], [sealedB, census], "a message's seal over an end's census keeps it");
  assert.ok((await store.runs.listMark("counted")) > markBefore, "the message's write moved its list mark");
  const live = await store.claim("counted", "runner-a", { leaseMs: 30_000 });
  const markLive = await store.runs.listMark("counted");
  await store.command("counted", { kind: "steer", body: { text: "And more." } }, { launchSealed: sealedA });
  assert.deepEqual((await launch("counted")).sealed, sealedA, "a live run's message seals anew");
  assert.ok((await store.runs.listMark("counted")) > markLive, "and moves its list mark in the same write");
  assert.ok(live);
});

/** Runs "live" (its launch holding sealed bytes) and "plain" (none) of agent-1 in `store`. */
async function liveAndPlain(store) {
  await agentWithRevision(store);
  await store.runs.create({ id: "live", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Answer." } }, sealed: new Uint8Array([7, 7, 7, 1]) });
  await store.runs.create({ id: "plain", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Answer." } }, sealed: null });
}

test("a store an earlier build of this version made (no run_launch.census): a runner waits for the server, which adds it and marks each launch holding sealed bytes pending", sqliteOnly("an earlier build's store file"), async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  const first = await openSqliteStore({ file, role: "server", now: () => T0 });
  await liveAndPlain(first);
  await first.close();
  const db = new DatabaseSync(file);
  try {
    db.exec("ALTER TABLE run_launch DROP COLUMN census");
  } finally {
    db.close();
  }
  await assert.rejects(openSqliteStore({ file, role: "runner" }), /Start the AgentRun server to add each run's census before opening a runner/);
  const second = await openSqliteStore({ file, role: "server", now: () => T0 });
  try {
    assert.equal((await second.runs.launch("live")).census, CENSUS_PENDING, "a launch holding sealed bytes: pending, so its end counts them or its files read as uncounted");
    assert.equal((await second.runs.launch("plain")).census, null, "one holding none: no census");
  } finally {
    await second.close();
  }
});

test("migration run_launch_census adds run_launch.census where it is missing and marks each launch holding sealed bytes pending", postgresOnly("the Postgres migrations"), async (t) => {
  const { migrationsIn, openPostgresStore } = await import("../dist/store/index.js");
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  const first = await openPostgresStore({ url: PG_URL, schema });
  await liveAndPlain(first);
  await first.close();
  const own = migrationsIn().find((one) => one.name === "run_launch_census");
  assert.ok(own, "a migration named run_launch_census ships");
  const c = await client(schema);
  try {
    await c.query("ALTER TABLE run_launch DROP COLUMN census");
    await c.query("DELETE FROM schema_migrations WHERE version >= $1", [own.version]);
    await c.query("UPDATE store_meta SET schema_version = $1 WHERE singleton = 1", [own.version - 1]);
  } finally {
    await c.end();
  }
  const second = await openPostgresStore({ url: PG_URL, schema });
  try {
    assert.equal((await second.runs.launch("live")).census, CENSUS_PENDING);
    assert.equal((await second.runs.launch("plain")).census, null);
  } finally {
    await second.close();
  }
});

test("a census holds no hash of a file that is a handed value alone: each file is named by a MAC under the seal key, and under another key no entry reads as its file's", async (t) => {
  const { workspace } = await folder(t, { "only.txt": KEY, "line.txt": `${KEY}\n` });
  const census = await censusOf(workspace, [KEY], SEAL);
  const json = JSON.stringify(census);
  for (const plain of [KEY, `${KEY}\n`]) assert.equal(json.includes(sha(Buffer.from(plain))), false, `no SHA-256 of ${JSON.stringify(plain.slice(-3))}`);
  assert.deepEqual(census.files["only.txt"], { mac: mac(Buffer.from(KEY)), cut: [[0, KEY.length]] });
  assert.equal(readAfter(json, "only.txt", KEY), "[redacted]");
  assert.equal(readAfter(json, "only.txt", KEY, [], Buffer.alloc(32, 6)), "withheld", "another seal key: not the file counted");
  assert.equal(readAfter(json, "only.txt", KEY, [], null), "withheld", "no seal key: withheld");
});

test("a census stays small: a file past CENSUS_RANGES_MAX cuts is cut whole, entries past CENSUS_JSON_MAX are left out (partial, withheld), and a census past it is read as none", async (t) => {
  const many = Array.from({ length: CENSUS_RANGES_MAX + 1 }, (_, i) => `${i} ${KEY}`).join("\n");
  const files = { "many.log": many };
  // Enough files of CENSUS_RANGES_MAX cuts each that their entries take the census past CENSUS_JSON_MAX.
  const each = Array.from({ length: CENSUS_RANGES_MAX }, () => KEY).join(" ");
  const count = Math.ceil(CENSUS_JSON_MAX / (CENSUS_RANGES_MAX * 12)) + 2;
  for (let i = 0; i < count; i++) files[`logs/${String(i).padStart(4, "0")}.log`] = each;
  const { workspace } = await folder(t, files);
  const census = await censusOf(workspace, [KEY], SEAL);
  const json = JSON.stringify(census);
  assert.equal(census.files["many.log"]?.cut, "whole", "past CENSUS_RANGES_MAX: whole");
  assert.equal(readAfter(json, "many.log", many), "[redacted]");
  assert.ok(json.length <= CENSUS_JSON_MAX, `the census within CENSUS_JSON_MAX: ${json.length}`);
  assert.equal(census.partial, true, "entries left out: partial");
  const left = Object.keys(files).filter((path) => !Object.hasOwn(census.files, path));
  assert.ok(left.length > 0, "some files have no entry");
  assert.equal(readAfter(json, left[0], files[left[0]]), "withheld", "a file left out is withheld after the end");
  const merged = censusAfter(JSON.stringify({ v: 1, files: { "a.txt": { mac: "aa", cut: Array.from({ length: CENSUS_RANGES_MAX }, (_, i) => [i * 4, i * 4 + 2]) } } }), { v: 1, files: { "a.txt": { mac: "aa", cut: [[CENSUS_RANGES_MAX * 4 + 10, CENSUS_RANGES_MAX * 4 + 12]] } } });
  assert.equal(merged.files["a.txt"].cut, "whole", "two ends' cuts past CENSUS_RANGES_MAX together: whole");
  const huge = JSON.stringify({ v: 1, files: { "a.txt": { mac: mac(Buffer.from("a")), cut: [] }, pad: { mac: "x".repeat(CENSUS_JSON_MAX), cut: [] } } });
  assert.equal(readAfter(huge, "a.txt", "a"), "withheld", "a census past CENSUS_JSON_MAX is no census");
});
