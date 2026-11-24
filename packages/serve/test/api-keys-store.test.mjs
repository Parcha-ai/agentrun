// The API keys over the one store (api-keys.ts), with no server, on SQLite and on Postgres (AGENTRUN_TEST_PG_URL,
// `npm run test:pg`). A key's row is a store setting, so a key made before a restart opens after it and a revoked one
// does not; the store's own capacity holds the limit; a last use is written once a minute at most, and one that loses
// to a revocation writes nothing; a key made under one seal key opens nothing under another; every check compares the
// header with every key, with no early return; and whatever decides by the keys' count takes a turn, so it never reads a
// key taken out for a removal that then fails.
import assert from "node:assert/strict";
import crypto, { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { openPostgresStore, openSqliteStore } from "../dist/store/index.js";
import { dropSchema, freshSchema, onPostgres, PG_URL } from "./store-target.mjs";

const { API_KEY_SETTING, API_KEYS_LIMIT, ApiKeys, USED_EVERY_MS } = await import("../dist/api-keys.js");
const { CLAUDE_LOGIN_SETTING, oneOwnerDeps, turnOnClaudeLogin } = await import("../dist/claude-login.js");

/** A place for one store, opened and closed by the test as a server's starts and stops would: a schema of its own on
 *  Postgres, a data directory of its own on SQLite; removed after the test. */
async function storeAt(t) {
  if (onPostgres) {
    const schema = await freshSchema();
    t.after(() => dropSchema(schema));
    return () => openPostgresStore({ url: PG_URL, schema });
  }
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "api-keys-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return () => openSqliteStore({ dataDir: dir });
}

/** A store of its own, and a server's start on it: the keys over it under one seal key, with a clock the test moves.
 *  `wrap`: the settings the keys write through, for a test that holds one of their writes. `open(options)`: a start
 *  with those options (dormant), each line it says kept in `said`. */
async function place(t, wrap = (settings) => settings) {
  const openStore = await storeAt(t);
  const clock = { at: Date.parse("2026-11-24T12:00:00.000Z") };
  const sealKey = randomBytes(32);
  const open = async (options = {}) => {
    const store = await openStore();
    const said = [];
    const keys = new ApiKeys({ settings: wrap(store.settings) }, sealKey, { now: () => clock.at, say: (fields) => said.push(fields), ...options });
    await keys.load();
    return { store, keys, said, stop: async () => (await keys.close(), await store.close()) };
  };
  return { open, clock };
}

test("a key made before a restart opens after it, listed as it was; one revoked before it does not", async (t) => {
  const { open } = await place(t);
  let { store, keys, stop } = await open();
  const [kept, gone] = [await keys.create({ name: "kept" }), await keys.create({ name: "gone" })];
  assert.equal(keys.used(`Bearer ${kept.api_key}`), kept.id);
  assert.equal(keys.used(`Bearer ${gone.api_key}`), gone.id);
  await keys.revoke(gone.id);
  assert.equal(keys.used(`Bearer ${gone.api_key}`), undefined, "revoked, it opens nothing at once");
  assert.equal(JSON.stringify(await store.settings.all({ prefix: API_KEY_SETTING })).includes(kept.api_key), false, "no row holds a key");
  await stop();

  ({ store, keys, stop } = await open());
  t.after(() => stop());
  assert.equal(keys.used(`Bearer ${kept.api_key}`), kept.id, "the key made before the restart opens");
  assert.equal(keys.used(`Bearer ${gone.api_key}`), undefined, "the one revoked before it does not");
  const { api_key: _shown, last_used_at: _then, ...view } = kept;
  const { last_used_at: _now, ...listed } = keys.list().keys[0];
  assert.deepEqual([keys.list().keys.length, listed, keys.count], [1, view, 1]);
});

test(`the store holds the limit: the key after ${API_KEYS_LIMIT} is api_keys_full, and takes once one is revoked`, async (t) => {
  const { open } = await place(t);
  const { store, keys, stop } = await open();
  t.after(() => stop());
  const made = [];
  for (let i = 0; i < API_KEYS_LIMIT; i++) made.push(await keys.create({ name: `key ${i + 1}` }));
  await assert.rejects(keys.create({ name: "one too many" }), (error) => error.code === "api_keys_full");
  assert.equal((await store.settings.all({ prefix: API_KEY_SETTING })).length, API_KEYS_LIMIT, "the refused one wrote no row");
  assert.deepEqual(keys.list().keys.map((one) => one.name), made.map((one) => one.name), "listed oldest first");
  await keys.revoke(made[0].id);
  assert.equal((await keys.create({ name: "now it fits" })).name, "now it fits");
});

test("every check compares the header with every key, on two 32-byte digests, with no early return on a match", async (t) => {
  const { open } = await place(t);
  const { keys, stop } = await open();
  t.after(() => stop());
  const made = [];
  for (const name of ["a", "b", "c"]) made.push(await keys.create({ name }));
  const spied = mock.method(crypto, "timingSafeEqual");
  syncBuiltinESMExports();
  t.after(() => (spied.mock.restore(), syncBuiltinESMExports()));
  for (const [header, expected] of [[`Bearer ${made[0].api_key}`, made[0].id], [`Bearer ${made[2].api_key}`, made[2].id], ["Bearer nope", undefined], [undefined, undefined], [made[1].api_key, undefined], [`bearer ${made[1].api_key}`, undefined], [`Bearer ${made[1].api_key} `, undefined], ["x".repeat(10_000), undefined]]) {
    spied.mock.resetCalls();
    assert.equal(keys.used(header), expected, String(header).slice(0, 20));
    assert.deepEqual(spied.mock.calls.map((one) => one.arguments.map((buffer) => buffer.length)), [[32, 32], [32, 32], [32, 32]], `three comparisons, whatever was sent (${String(header).slice(0, 20)})`);
  }
});

test("a key's last use is written to the store once a minute at most, and read back at the next start", async (t) => {
  const { open, clock } = await place(t);
  let { store, keys, stop } = await open();
  const made = await keys.create({ name: "busy" });
  const row = async () => (await store.settings.get(`${API_KEY_SETTING}${made.id}`)).last_used_at;
  const start = clock.at;
  const iso = (ms) => new Date(ms).toISOString();

  assert.equal(keys.used(`Bearer ${made.api_key}`), made.id);
  await keys.close();
  assert.equal(await row(), iso(start), "the first use is written");

  clock.at = start + USED_EVERY_MS - 1;
  keys.used(`Bearer ${made.api_key}`);
  await keys.close();
  assert.equal(await row(), iso(start), "a use within the minute is not");
  assert.equal(keys.list().keys[0].last_used_at, iso(clock.at), "though the list says it");

  clock.at = start + USED_EVERY_MS;
  keys.used(`Bearer ${made.api_key}`);
  await keys.close();
  assert.equal(await row(), iso(clock.at), "a minute on, it is written again");
  await stop();

  ({ store, keys, stop } = await open());
  t.after(() => stop());
  assert.equal(keys.list().keys[0].last_used_at, iso(start + USED_EVERY_MS), "the next start reads what was written");
  assert.equal(keys.used(`Bearer ${made.api_key}`), made.id, "and the key opens under the same seal key");
  // The row read back at the start is replaced as one this process wrote is: its next use is written.
  clock.at = start + 2 * USED_EVERY_MS;
  keys.used(`Bearer ${made.api_key}`);
  await keys.close();
  assert.equal(await row(), iso(clock.at), "a use after the restart is written over the row the start read");
});

test("a last-use write that loses to a revocation writes nothing: the revoked key's row stays gone", async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  // The store's write of a last use waits here until the test lets it go.
  const { open } = await place(t, (settings) => ({ ...settings, replaceIf: async (...args) => (await held, settings.replaceIf(...args)) }));
  const { store, keys, stop } = await open();
  t.after(() => stop());
  const made = await keys.create({ name: "revoked while in use" });
  assert.equal(keys.used(`Bearer ${made.api_key}`), made.id, "its use starts a write");
  await keys.revoke(made.id);
  release();
  await keys.close();
  assert.equal(await store.settings.get(`${API_KEY_SETTING}${made.id}`), undefined, "the late write did not bring the row back");
  assert.equal(keys.used(`Bearer ${made.api_key}`), undefined, "and the key opens nothing");
});

test("a turn waits for a revocation under way, and counts the key again when its removal failed", async (t) => {
  let fail;
  const held = new Promise((_, reject) => (fail = reject));
  // The store's removal of the key waits here, then fails: what a store that went away mid-write does.
  const { open } = await place(t, (settings) => ({ ...settings, remove: async () => held }));
  const { store, keys, stop } = await open();
  t.after(() => stop());
  const made = await keys.create({ name: "the last key" });
  const revoking = keys.revoke(made.id);
  // What the server does to turn Claude Code's login on: decide by the count, in a turn.
  let counted;
  const turn = keys.inTurn(async () => (counted = keys.count));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(keys.count, 0, "outside a turn the key is out while its removal is under way");
  assert.equal(counted, undefined, "the turn has not read the count yet: the revocation is not settled");
  fail(new Error("the store went away"));
  await assert.rejects(revoking, /the store went away/);
  await turn;
  assert.equal(counted, 1, "its removal failed, so the key is counted: nothing decided by a count of none");
  assert.equal(keys.used(`Bearer ${made.api_key}`), made.id, "and it opens still, as its row is in the store still");
  assert.equal((await store.settings.all({ prefix: API_KEY_SETTING })).length, 1);
});

test("a create's refusal is asked in the create's own turn, after the turn before it, and a refused one writes nothing", async (t) => {
  const { open } = await place(t);
  const { store, keys, stop } = await open();
  t.after(() => stop());
  const order = [];
  let release;
  const before = keys.inTurn(() => new Promise((resolve) => (release = () => (order.push("the turn before ends"), resolve()))));
  const refused = keys.create({ name: "an app" }, async () => (order.push("the refusal is asked"), "This server is one person's."));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], "not asked while the turn before it runs");
  release();
  await before;
  await assert.rejects(refused, (error) => error.code === "forbidden" && error.message === "This server is one person's.");
  assert.deepEqual(order, ["the turn before ends", "the refusal is asked"]);
  assert.deepEqual([keys.count, (await store.settings.all({ prefix: API_KEY_SETTING })).length], [0, 0], "the refused create made nothing");
  assert.equal((await keys.create({ name: "an app" }, async () => undefined)).name, "an app", "with no refusal it is made");
});

test("the login's turn-on itself waits for a revocation under way, and is refused by the key its failed removal put back", async (t) => {
  let fail;
  const held = new Promise((_, reject) => (fail = reject));
  const { open } = await place(t, (settings) => ({ ...settings, remove: async () => held }));
  const { store, keys, stop } = await open();
  t.after(() => stop());
  const made = await keys.create({ name: "the last key" });
  // What the server's routes give the turn-on (server.ts loginDeps spreads the same oneOwnerDeps over its keys): its
  // turn is the keys', and its refusal counts the keys each time it is asked. What a turn-on that got past the refusal
  // would go on to is given too, so it would show.
  const went = [];
  const deps = {
    ...oneOwnerDeps({ apiOnly: false, tokens: 1 }, keys),
    settings: { ...store.settings, put: async (...args) => (went.push("the setting was written"), store.settings.put(...args)) },
    data: "/nonexistent", env: {}, sameMachine: true,
    signIns: { view: () => undefined, serial: (work) => work({ stop: async () => undefined, start: async () => undefined }) },
    saved: () => undefined,
    pinned: async () => undefined,
    claude: async () => ({ claudeLoginCommand: () => "claude auth login" }),
    changed: async () => void went.push("the login was read again"),
  };
  const revoking = keys.revoke(made.id);
  const turning = turnOnClaudeLogin(deps, { only_me: true });
  turning.catch(() => undefined);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(keys.count, 0, "the key is out while its removal is under way");
  assert.deepEqual(went, [], "the turn-on has decided nothing yet");
  fail(new Error("the store went away"));
  await assert.rejects(revoking, /the store went away/);
  await assert.rejects(turning, (error) => error.code === "forbidden" && /^This server has an API key made for apps/.test(error.message));
  assert.deepEqual(went, [], "and wrote nothing");
  assert.equal(await store.settings.get(CLAUDE_LOGIN_SETTING), undefined, "the login is not on");
  assert.equal(keys.used(`Bearer ${made.api_key}`), made.id, "the key opens still");
});

test("a row whose dates are no dates, or that is no key's at all, is ignored and said; the list still answers, and its id removes it", async (t) => {
  const { open } = await place(t);
  let { store, keys, said, stop } = await open();
  const made = await keys.create({ name: "kept" });
  const row = await store.settings.get(`${API_KEY_SETTING}${made.id}`);
  const damaged = "01a20b30-b53a-7000-9abd-64340ac132cb";
  await store.settings.put(`${API_KEY_SETTING}${damaged}`, { ...row, id: damaged, last_used_at: "not a date" });
  await store.settings.put(`${API_KEY_SETTING}not-a-key`, { v: 7 });
  await stop();

  ({ store, keys, said, stop } = await open());
  t.after(() => stop());
  assert.deepEqual(keys.list().keys.map((one) => one.name), ["kept"], "the list answers with the keys it could read");
  assert.deepEqual(keys.list().unreadable, [damaged, "not-a-key"], "and names the rows it could not, by id");
  assert.equal(keys.count, 1);
  assert.deepEqual(said.map((line) => [line.condition, line.key]).sort(), [["api_key_unreadable", `${API_KEY_SETTING}${damaged}`], ["api_key_unreadable", `${API_KEY_SETTING}not-a-key`]]);
  assert.ok(said.every((line) => /counts toward the limit until DELETE \/v2\/settings\/api-keys\//.test(line.effect)), "each line says how the row is removed");
  for (const id of [damaged, "not-a-key"]) await keys.revoke(id);
  assert.equal("unreadable" in keys.list(), false, "removed, they are named no more");
  assert.deepEqual((await store.settings.all({ prefix: API_KEY_SETTING })).map((one) => one.key), [`${API_KEY_SETTING}${made.id}`], "both rows are gone, and the key's stays");
  await assert.rejects(keys.revoke(damaged), (error) => error.code === "not_found", "a second removal finds nothing");
});

test("while the store refuses the write of a last use, it is tried once a minute and said once a try, not at each use", async (t) => {
  let tries = 0;
  const { open, clock } = await place(t, (settings) => ({ ...settings, replaceIf: async () => (tries++, Promise.reject(new Error("the store is away"))) }));
  const { keys, said, stop } = await open();
  t.after(() => stop());
  const made = await keys.create({ name: "busy" });
  const start = clock.at;
  for (const [at, expected] of [[start, 1], [start + 1, 1], [start + 1000, 1], [start + USED_EVERY_MS - 1, 1], [start + USED_EVERY_MS, 2], [start + USED_EVERY_MS + 5, 2]]) {
    clock.at = at;
    assert.equal(keys.used(`Bearer ${made.api_key}`), made.id, "the key opens whatever the store says");
    await keys.close();
    assert.equal(tries, expected, `${at - start} ms on`);
  }
  assert.deepEqual(said.map((line) => [line.condition, line.id, line.error]), [["api_key_use_not_saved", made.id, "the store is away"], ["api_key_use_not_saved", made.id, "the store is away"]]);
  assert.equal(keys.list().keys[0].last_used_at, new Date(clock.at).toISOString(), "the list still says its last use");
});

test("dormant keys open nothing, and are still listed, counted and revocable", async (t) => {
  const { open } = await place(t);
  let { store, keys, stop } = await open();
  const [kept, gone] = [await keys.create({ name: "kept" }), await keys.create({ name: "gone" })];
  await stop();

  ({ store, keys, stop } = await open({ dormant: true }));
  assert.equal(keys.used(`Bearer ${kept.api_key}`), undefined, "a key opens nothing here");
  assert.deepEqual(keys.list().keys.map((one) => [one.name, one.last_used_at]), [["kept", null], ["gone", null]], "each is listed, and none was used");
  assert.equal(keys.count, 2, "and counted for the one-owner rule");
  await keys.revoke(gone.id);
  assert.equal(await store.settings.get(`${API_KEY_SETTING}${gone.id}`), undefined, "one revoked here is gone from the store");
  await stop();

  ({ store, keys, stop } = await open());
  t.after(() => stop());
  assert.equal(keys.used(`Bearer ${kept.api_key}`), kept.id, "at a start that takes keys the kept one opens again");
  assert.equal(keys.used(`Bearer ${gone.api_key}`), undefined, "and the one revoked while dormant does not");
});

test("a key made under one seal key opens nothing under another", async (t) => {
  const store = await (await storeAt(t))();
  t.after(() => store.close());
  const first = new ApiKeys(store, randomBytes(32));
  const made = await first.create({ name: "sealed" });
  const other = new ApiKeys(store, randomBytes(32));
  await other.load();
  assert.equal(other.list().keys.length, 1, "it is listed, so its owner can revoke it");
  assert.equal(other.used(`Bearer ${made.api_key}`), undefined, "and opens nothing");
});
