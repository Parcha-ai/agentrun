// AGENTRUN_STORE_POOL_SIZE: the most connections a process's Postgres store holds at once, read by the one store opener the
// server and every runner go through (store/open.ts). Unset or empty it is 10; a whole number from 1 to 1000 is taken; any
// other value is refused in words before a store is opened, on either store, so a server or a runner never starts on a
// pool it was not asked for. The pool it sets on Postgres is held in store-postgres.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sqliteOnly } from "./store-target.mjs";

const { DEFAULT_STORE_POOL_SIZE, MAX_STORE_POOL_SIZE, openStore, storePoolSize } = await import("../dist/store/index.js");

test("the pool size is 10 when AGENTRUN_STORE_POOL_SIZE is unset or empty", () => {
  assert.equal(DEFAULT_STORE_POOL_SIZE, 10);
  assert.equal(storePoolSize({}), 10);
  assert.equal(storePoolSize({ AGENTRUN_STORE_POOL_SIZE: "" }), 10);
  assert.equal(storePoolSize({ AGENTRUN_STORE_POOL_SIZE: "  " }), 10);
});

test("a whole number from 1 to 1000 is the pool size, spaces around it ignored", () => {
  assert.equal(MAX_STORE_POOL_SIZE, 1_000);
  for (const [given, size] of [["1", 1], ["25", 25], [" 40 ", 40], ["1000", 1_000], ["007", 7]]) {
    assert.equal(storePoolSize({ AGENTRUN_STORE_POOL_SIZE: given }), size, JSON.stringify(given));
  }
});

for (const given of ["0", "-1", "1001", "2.5", "1e2", "0x10", "ten", "10 connections", "+5", "99999999999999999999"]) {
  test(`AGENTRUN_STORE_POOL_SIZE=${JSON.stringify(given)} is refused in words naming the setting, its range and the value`, () => {
    assert.throws(() => storePoolSize({ AGENTRUN_STORE_POOL_SIZE: given }), (error) => {
      assert.ok(error instanceof TypeError, `a TypeError: ${error}`);
      assert.match(error.message, /^AGENTRUN_STORE_POOL_SIZE is a whole number from 1 to 1000 /);
      assert.ok(error.message.endsWith(`not ${JSON.stringify(given.trim())}`), error.message);
      return true;
    });
  });
}

test("a store opened with a pool size that is no size is refused before anything is opened or made", sqliteOnly("the SQLite store's data directory"), async (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-pool-size-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const role of ["server", "runner"]) {
    await assert.rejects(openStore({ dataDir: dir, role, url: "", env: { AGENTRUN_STORE_POOL_SIZE: "0" } }), /^TypeError: AGENTRUN_STORE_POOL_SIZE is a whole number/, role);
  }
  assert.deepEqual(readdirSync(dir), [], "no store made in the data directory");
  const store = await openStore({ dataDir: dir, role: "server", url: "", env: { AGENTRUN_STORE_POOL_SIZE: "3" } });
  await store.close();
});
