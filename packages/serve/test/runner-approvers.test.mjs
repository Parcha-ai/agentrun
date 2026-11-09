// Whether anyone can answer an ask reaches a runner from the store (store.settings, the "approvers" row the server writes
// at its start), read at each claim: a runner on another machine has no server environment to read, and the server's
// accounts setting may change while a runner lives. Accounts off, an asked call is refused at once in words (tool-gate.ts
// noApproverText), never parked; a missing row (a server from before the row) reads as approvers, so an ask parks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adapterRunGate } from "../dist/runner/adapter-run-spec.js";
import { openSqliteStore } from "../dist/store/sqlite/store.js";
import { noApproverText } from "../dist/tool-gate.js";
import { storeOn } from "./store-helpers.mjs";
import { serve } from "./support.mjs";

/** The store row the server writes its approvers fact under (server-approvers.ts APPROVERS_KEY). */
const APPROVERS = "approvers";
const REVISION = { kind: "agentic", body: { harness: "pi", toolSettings: { web_fetch: { permission: "ask" } } } };
const CALL = { tool: "web_fetch", args: { url: "http://public.example/" } };

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), "approvers-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a runner reads whether anyone can answer an ask from the store at each claim: with no row an ask parks; set off, the next claim's ask is refused at once in words; set on again, it parks", async (t) => {
  const { store } = await storeOn(t);
  const root = folder(t);
  const claim = async (runId) => adapterRunGate(store, { runId }, REVISION, root);
  assert.equal(await (await claim("r1"))(CALL), "ask", "no row: a server from before it, so someone can answer");
  await store.settings.put(APPROVERS, { approvers: false });
  assert.deepEqual(await (await claim("r2"))(CALL), { deny: noApproverText("web_fetch", "no") }, "the next claim reads the server's accounts off");
  await store.settings.put(APPROVERS, { approvers: true });
  assert.equal(await (await claim("r3"))(CALL), "ask", "and on again");
});

test("the server writes whether anyone can answer an ask to the store at its start: accounts off, no one; accounts on, its owner", async (t) => {
  for (const accounts of [false, true]) {
    const server = await serve(t, { accounts, runner: false });
    const read = await openSqliteStore({ dataDir: server.data, role: "runner" });
    try {
      assert.deepEqual(await read.settings.get(APPROVERS), { approvers: accounts }, `accounts ${accounts ? "on" : "off"}`);
    } finally {
      await read.close();
    }
  }
});
