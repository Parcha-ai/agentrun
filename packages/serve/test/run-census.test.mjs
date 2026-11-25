// A run's census (run-census.ts): where in each of its files the secrets its caller handed it sat when its end erased them,
// never the secrets. Proven here, below the server:
//   - censusOf counts each text file a cut read would serve, with the byte ranges redactSecrets cuts (multibyte text
//     too), "whole" where the text is cut whole, and leaves out what a cut read refuses (not text, over the cap, a NUL);
//   - censusCut cuts a file by its entry only while its bytes are the ones counted, and withholds ("unreadable") a file
//     with no entry, changed bytes, a marker, or ranges that don't fall on the text's characters;
//   - censusAfter keeps, over an earlier end's census, only the files both ends counted byte for byte, with both cuts;
//   - the store: a launch's census is null until an end writes one; an end writes its census in the erased secrets' place
//     only when it was made under those bytes, else CENSUS_UNSCANNED; a message's seal keeps the census as the last end
//     wrote it; every write that seals anew moves the run's list mark, so its kept listing is built again;
//   - Postgres migration 0029 settles each "pending" 0027 left as this build reads it and drops 0027's trigger; a
//     SQLite server open settles each one 0.1.0-beta.57 left the same way.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { redactSecrets } from "../dist/learn/secrets.js";
import { CENSUS_JSON_MAX, CENSUS_RANGES_MAX, censusAfter, censusCut, censusOf, fileMac, pathMac } from "../dist/run-census.js";
import { RUN_FILE_CUT_MAX } from "../dist/run-files.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { agentWithRevision, storeOn, T0 } from "./store-helpers.mjs";
import { client, dropSchema, freshSchema, PG_URL, postgresOnly, sqliteOnly } from "./store-target.mjs";

const { CENSUS_UNSCANNED } = await import("../dist/store/index.js");
/** The census 0027 gave a launch from its first sealed bytes until an end counted them. This build writes none; one left
 *  over is text it doesn't read. */
const PENDING = JSON.stringify("pending");

const KEY = `not-a-secret-${"census-model-key"}-7c41e2`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** The server's seal key, as a test holds one: each census names a file by a MAC under it. */
const SEAL = Buffer.alloc(32, 5);
const mac = (bytes) => fileMac(SEAL, bytes);
/** A file's entry key in a census under SEAL: the MAC of its path (pathMac), never the path. */
const keyOf = (path) => pathMac(SEAL, path);

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
  assert.deepEqual(Object.keys(census.files).sort(), ["clean.json", "notes.txt", "out/wide.md"].map(keyOf).sort(), "a type that isn't text, a NUL and a file over the cap are left out: a cut read refuses them");
  assert.deepEqual(census.files[keyOf("notes.txt")], { mac: mac(Buffer.from(plain)), cut: [[4, 4 + KEY.length]] }, "the value's byte range, no value, no hash of one");
  assert.equal(JSON.stringify(census).includes(KEY), false, "the census holds no value");
  const at = Buffer.from(wide).indexOf(KEY);
  assert.deepEqual(census.files[keyOf("out/wide.md")].cut[0], [at, at + KEY.length], "byte offsets of the UTF-8 bytes, past multibyte characters");
  assert.deepEqual(census.files[keyOf("clean.json")].cut, [], "a file with none counted with nothing to cut");

  const json = JSON.stringify(census);
  assert.equal(readAfter(json, "notes.txt", plain), "key=[redacted]\nthe rest stays.\n");
  assert.equal(readAfter(json, "out/wide.md", wide), redactSecrets(wide, [KEY]), "cut where the values cut it");
  assert.equal(readAfter(json, "clean.json", JSON.stringify({ fine: true })), JSON.stringify({ fine: true }));
});

test("censusCut withholds a file with no entry, changed bytes, a marker, a damaged census, and ranges that don't fall on the text's characters", () => {
  const text = `ñ=${KEY}\n`;
  const bytes = Buffer.from(text);
  const from = Buffer.byteLength("ñ=");
  const good = JSON.stringify({ v: 1, files: { [keyOf("a.txt")]: { mac: mac(bytes), cut: [[from, from + KEY.length]] } } });
  assert.equal(readAfter(good, "a.txt", text), "ñ=[redacted]\n", "the counted file is cut");
  assert.equal(readAfter(good, "b.txt", text), "withheld", "no entry: written after the end, or past the census's caps");
  assert.equal(readAfter(good, "a.txt", `${text}more\n`), "withheld", "changed since it was counted");
  for (const marker of [CENSUS_UNSCANNED, PENDING, "not json", JSON.stringify({ v: 2, files: {} }), JSON.stringify({ v: 1 })]) assert.equal(readAfter(marker, "a.txt", text), "withheld", marker);
  const forged = (cut) => JSON.stringify({ v: 1, files: { [keyOf("a.txt")]: { mac: mac(bytes), cut } } });
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
  assert.equal(censusAfter(CENSUS_UNSCANNED, next), undefined, "a marker before: nothing says where the earlier secrets sat");
  assert.equal(censusAfter(PENDING, next), undefined, "a \"pending\" left over: no census this build reads, so the end writes the marker");
  assert.equal(censusAfter("damaged", next), undefined);
  const before = JSON.stringify({ v: 1, files: { "same.txt": { mac: "aa", cut: [[0, 5], [15, 30]] }, "changed.txt": { mac: "b0", cut: [] }, "whole.txt": { mac: "dd", cut: "whole" } } });
  assert.deepEqual(censusAfter(before, next), { v: 1, files: { "same.txt": { mac: "aa", cut: [[0, 5], [10, 30]] }, "whole.txt": { mac: "dd", cut: "whole" } } }, "a changed file and a new one have no entry: they may hold what the earlier turn was handed");
});

test("the store: a sealed launch has no census until an end writes one, made under the bytes it erases, else unscanned; a message's seal keeps what the last end wrote", async (t) => {
  const { store } = await storeOn(t);
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
  assert.equal((await launch("counted")).census, null, "sealed at its start: no end counted it yet");
  await end("counted", { census: { json: census, sealed: sealedA } });
  assert.deepEqual([(await launch("counted")).sealed, (await launch("counted")).census], [null, census], "erased, its census in their place");

  await make("other-bytes", sealedB);
  await end("other-bytes", { census: { json: census, sealed: sealedA } });
  assert.deepEqual([(await launch("other-bytes")).sealed, (await launch("other-bytes")).census], [null, CENSUS_UNSCANNED], "a census made under other bytes is not written");

  await make("no-census", sealedA);
  await end("no-census");
  assert.deepEqual([(await launch("no-census")).sealed, (await launch("no-census")).census], [null, CENSUS_UNSCANNED], "an end with none: unscanned");

  // A message's seal writes the sealed bytes alone: over the marker it stays, so that end's files stay withheld; on a
  // launch that never held any, there is still no census until its end.
  await store.runs.reopen("no-census", { kind: "steer", body: { text: "More." } }, { launchSealed: sealedB });
  assert.deepEqual([(await launch("no-census")).sealed, (await launch("no-census")).census], [sealedB, CENSUS_UNSCANNED], "a message's seal over the marker keeps it");
  await store.runs.reopen("none", { kind: "steer", body: { text: "More." } }, { launchSealed: sealedB });
  assert.deepEqual([(await launch("none")).sealed, (await launch("none")).census], [sealedB, null], "a first seal by a message: no census until an end");

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

test("a store an earlier build of this version made (no run_launch.census): a runner waits for the server, which adds it, null on every launch until an end writes one", sqliteOnly("an earlier build's store file"), async (t) => {
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
    assert.equal((await second.runs.launch("live")).census, null, "a launch holding sealed bytes: no end counted them yet, so its end does");
    assert.equal((await second.runs.launch("plain")).census, null, "one holding none: no census");
  } finally {
    await second.close();
  }
});

test("a store an earlier release left with \"pending\" censuses: the server settles each as this build reads it, null on a launch still holding sealed bytes, unscanned on one an end erased, and keeps a census an end wrote", sqliteOnly("an earlier release's store file"), async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "store.sqlite");
  const first = await openSqliteStore({ file, role: "server", now: () => T0 });
  await liveAndPlain(first);
  await first.runs.create({ id: "counted", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Answer." } }, sealed: new Uint8Array([7, 7, 7, 2]) });
  await first.close();
  // As 0.1.0-beta.57 left them: "pending" on each launch that held sealed bytes, kept after an end erased them.
  const counted = JSON.stringify({ v: 1, files: {} });
  const db = new DatabaseSync(file);
  try {
    db.prepare("UPDATE run_launch SET census = ? WHERE run_id IN ('live', 'plain')").run(PENDING);
    db.prepare("UPDATE run_launch SET census = ? WHERE run_id = 'counted'").run(counted);
  } finally {
    db.close();
  }
  const second = await openSqliteStore({ file, role: "server", now: () => T0 });
  try {
    assert.equal((await second.runs.launch("live")).census, null, "a launch still holding sealed bytes: no end counted them yet, so its end does");
    assert.equal((await second.runs.launch("plain")).census, CENSUS_UNSCANNED, "one an end erased: nothing counted them, so its files are withheld");
    assert.equal((await second.runs.launch("counted")).census, counted, "a census an end wrote is kept");
  } finally {
    await second.close();
  }
});

test("migrations run_launch_census and run_launch_census_settle add run_launch.census where it is missing, null on every launch until an end writes one", postgresOnly("the Postgres migrations"), async (t) => {
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
    assert.equal((await second.runs.launch("live")).census, null, "a launch holding sealed bytes: no end counted them yet");
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
  assert.deepEqual(census.files[keyOf("only.txt")], { mac: mac(Buffer.from(KEY)), cut: [[0, KEY.length]] });
  assert.equal(readAfter(json, "only.txt", KEY), "[redacted]");
  assert.equal(readAfter(json, "only.txt", KEY, [], Buffer.alloc(32, 6)), "withheld", "another seal key: not the file counted");
  assert.equal(readAfter(json, "only.txt", KEY, [], null), "withheld", "no seal key: withheld");
});

test("a census holds no file's path: a file the run named by a handed value leaves the value nowhere in it once the end erased the seal, and a read after the end still finds the file's entry by its path", async (t) => {
  const named = `cache/${KEY}.json`;
  const { workspace } = await folder(t, { [named]: "{}", "notes.txt": `key=${KEY}\n` });
  const census = await censusOf(workspace, [KEY], SEAL);
  const json = JSON.stringify(census);
  assert.equal(json.includes(KEY), false, "no handed value, in a path or anywhere");
  for (const path of [named, "notes.txt", "cache/"]) assert.equal(json.includes(path), false, `no path: ${path}`);
  for (const path of [named, "notes.txt"]) assert.equal(json.includes(sha(Buffer.from(path))), false, `no plain hash of a path: ${path}`);
  assert.equal(Object.keys(census.files).length, 2, "both files counted");
  assert.equal(readAfter(json, named, "{}"), "{}", "found by its path after the end, nothing to cut in its text");
  assert.equal(readAfter(json, "notes.txt", `key=${KEY}\n`), "key=[redacted]\n");
  assert.equal(readAfter(json, "notes.txt", `key=${KEY}\n`, [], Buffer.alloc(32, 6)), "withheld", "another seal key names no entry as the file's");
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
  assert.equal(census.files[keyOf("many.log")]?.cut, "whole", "past CENSUS_RANGES_MAX: whole");
  assert.equal(readAfter(json, "many.log", many), "[redacted]");
  assert.ok(json.length <= CENSUS_JSON_MAX, `the census within CENSUS_JSON_MAX: ${json.length}`);
  assert.equal(census.partial, true, "entries left out: partial");
  const left = Object.keys(files).filter((path) => !Object.hasOwn(census.files, keyOf(path)));
  assert.ok(left.length > 0, "some files have no entry");
  assert.equal(readAfter(json, left[0], files[left[0]]), "withheld", "a file left out is withheld after the end");
  const merged = censusAfter(JSON.stringify({ v: 1, files: { "a.txt": { mac: "aa", cut: Array.from({ length: CENSUS_RANGES_MAX }, (_, i) => [i * 4, i * 4 + 2]) } } }), { v: 1, files: { "a.txt": { mac: "aa", cut: [[CENSUS_RANGES_MAX * 4 + 10, CENSUS_RANGES_MAX * 4 + 12]] } } });
  assert.equal(merged.files["a.txt"].cut, "whole", "two ends' cuts past CENSUS_RANGES_MAX together: whole");
  const huge = JSON.stringify({ v: 1, files: { [keyOf("a.txt")]: { mac: mac(Buffer.from("a")), cut: [] }, pad: { mac: "x".repeat(CENSUS_JSON_MAX), cut: [] } } });
  assert.equal(readAfter(huge, "a.txt", "a"), "withheld", "a census past CENSUS_JSON_MAX is no census");
});

test("migration run_launch_census_settle settles each \"pending\" 0027 left as this build reads it, and drops 0027's trigger", postgresOnly("the Postgres migrations"), async (t) => {
  const { migrationsIn, openPostgresStore } = await import("../dist/store/index.js");
  const schema = await freshSchema();
  t.after(() => dropSchema(schema));
  const first = await openPostgresStore({ url: PG_URL, schema });
  try {
    await liveAndPlain(first);
    await first.runs.create({ id: "counted", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "Answer." } }, sealed: new Uint8Array([7, 7, 7, 9]) });
  } finally {
    await first.close();
  }
  const before = migrationsIn().find((one) => one.name === "run_launch_census");
  const settle = migrationsIn().find((one) => one.name === "run_launch_census_settle");
  assert.ok(before && settle && settle.version > before.version, "run_launch_census_settle ships after run_launch_census");
  assert.equal(settle.breaking, true, "it raises the runner floor: each runner of an earlier build stops at its next floor read");
  const census = JSON.stringify({ v: 1, files: {} });
  const at = async (c, id) => (await c.query("SELECT sealed IS NOT NULL AS held, census FROM run_launch WHERE run_id = $1", [id])).rows[0];
  // 0027's trigger and function in this schema alone: other tests' schemas share the database.
  const held = async (c) =>
    Number(
      (
        await c.query(
          `SELECT (SELECT count(*) FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = $1 AND t.tgname = 'run_launch_census_on_seal')
                + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = 'run_launch_census_on_seal') AS n`,
          [schema],
        )
      ).rows[0].n,
    );
  let c = await client(schema);
  try {
    assert.equal(await held(c), 0, "at this build's schema: no trigger, no function");
    // The schema as 0027 left it: the ledger past it gone, and 0027 run again (it is written to be), so its backfill marks
    // "live" pending and its trigger is back.
    await c.query("DELETE FROM schema_migrations WHERE version > $1", [before.version]);
    await c.query(before.sql);
    await c.query("UPDATE store_meta SET schema_version = $1 WHERE singleton = 1", [before.version]);
    assert.equal(await held(c), 2, "0027's trigger and function");
    assert.deepEqual(await at(c, "live"), { held: true, census: PENDING }, "a launch holding sealed bytes: pending");
    // An earlier server seals "plain", and an earlier runner's end erases its bytes, writing no census: pending, erased.
    await c.query("UPDATE run_launch SET sealed = $1 WHERE run_id = 'plain'", [Buffer.from([7, 7, 7, 5])]);
    await c.query("UPDATE run_launch SET sealed = NULL WHERE run_id = 'plain'");
    assert.deepEqual(await at(c, "plain"), { held: false, census: PENDING });
    // An end that counted: its census in the erased bytes' place.
    await c.query("UPDATE run_launch SET census = $1, sealed = NULL WHERE run_id = 'counted'", [census]);
  } finally {
    await c.end();
  }
  const second = await openPostgresStore({ url: PG_URL, schema });
  try {
    assert.equal((await second.runs.launch("live")).census, null, "pending on a launch still holding its bytes: null, its end counts them");
    assert.equal((await second.runs.launch("plain")).census, CENSUS_UNSCANNED, "pending on one an end erased: unscanned, its files withheld");
    assert.equal((await second.runs.launch("counted")).census, census, "an end's census stays");
  } finally {
    await second.close();
  }
  c = await client(schema);
  try {
    assert.equal(await held(c), 0, "0027's trigger and function are gone");
    // With no trigger, a seal that names no census leaves it null (0027's trigger made it pending).
    await c.query("UPDATE run_launch SET sealed = $1 WHERE run_id = 'live'", [Buffer.from([7, 7, 7, 6])]);
    assert.deepEqual(await at(c, "live"), { held: true, census: null });
  } finally {
    await c.end();
  }
});
