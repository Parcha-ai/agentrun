// What removing a server tells the delete route about Composio (McpServersOverStore.remove): the handle of the MCP server
// to delete there comes from the row the checked removal actually removed, never from a row read before it. A removal
// that lands on another credential than the one the request was allowed against (412) answers nothing to send; a preset
// whose key does not open is answered `unusable`, not as no preset at all; a server that is no preset answers nothing.
// The token's removal lands only while the row is still the token's, checked in the removal's own statement: an owner's
// save landing between any read and that statement keeps the row, and nothing is answered to send to Composio. A save
// writes its row and its record in its server's turn, so the token's mark never lands on a row the owner saved between.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { storeOn } from "./store-helpers.mjs";

const { composioMadeKey, storedMade } = await import("../dist/composio-made.js");
const { McpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { saveMcpServer } = await import("../dist/mcp-store.js");
const { credentialMark } = await import("../dist/mcp-secret-writes.js");
const { mcpSourceKey, ownersRecord, storedSource } = await import("../dist/mcp-sources.js");

const KEY = Buffer.from(randomBytes(32));
const SEAL = KEY.toString("base64").replace(/=+$/, "");
const COMPOSIO_KEY = `not-a-secret-${"composio-key"}`;

async function servers(t) {
  const { store } = await storeOn(t);
  return { store, registry: new McpServersOverStore(store, { AGENTRUN_SEAL_KEY: SEAL }, "test") };
}
const plain = (store) => saveMcpServer(store, KEY, { name: "hn", url: "http://127.0.0.1:9/plain", auth: "none", tools: [] });
async function preset(store, id, key = COMPOSIO_KEY) {
  const row = await saveMcpServer(store, KEY, { name: "hn", url: `http://127.0.0.1:9/v3/mcp/${id}/mcp`, auth: "headers", tools: [], credential: { type: "headers", headers: { "x-api-key": key } } });
  await store.settings.put(mcpSourceKey("hn"), storedSource({ source: "composio", toolkit: "hackernews" }, row));
  return row;
}

test("a removal answers the Composio server of the row it removed, with the key that row held", async (t) => {
  const { store, registry } = await servers(t);
  await preset(store, "srv_a");
  const removed = await registry.remove("hn");
  assert.deepEqual(removed, { composio: { id: "srv_a", key: COMPOSIO_KEY } });
  assert.equal(await store.mcp.server("hn"), undefined);
});

test("a row saved as a preset after the request was allowed: the checked removal is refused (412) and answers nothing to send", async (t) => {
  const { store, registry } = await servers(t);
  const mark = credentialMark(await plain(store));
  await preset(store, "srv_new");
  await assert.rejects(registry.remove("hn", mark), (error) => error.code === "precondition_failed");
  assert.equal((await store.mcp.server("hn")).url.includes("srv_new"), true, "the new server is still there");
});

test("a removal that lands answers the handle of the row it removed, not one read earlier", async (t) => {
  const { store, registry } = await servers(t);
  const mark = credentialMark(await preset(store, "srv_old"));
  const removed = await registry.remove("hn", mark);
  assert.deepEqual(removed, { composio: { id: "srv_old", key: COMPOSIO_KEY } });
});

test("the token's removal lands only on a row that is still the token's: one the owner saved over after the gate's check is refused (412) and stays; the token's own goes", async (t) => {
  const { store, registry } = await servers(t);
  const row = await plain(store);
  const tokens = storedSource({ source: "url", toolkit: null }, row, false, true);
  await store.settings.put(mcpSourceKey("hn"), tokens);
  const mark = credentialMark(row);
  // The owner's save over it lands after the gate read it as the token's: its record no longer carries the mark.
  await store.settings.put(mcpSourceKey("hn"), ownersRecord(tokens));
  await assert.rejects(registry.remove("hn", mark, true), (error) => error.code === "precondition_failed");
  assert.ok(await store.mcp.server("hn"), "the owner's server stays");
  await store.settings.put(mcpSourceKey("hn"), tokens);
  assert.deepEqual(await registry.remove("hn", mark, true), {});
  assert.equal(await store.mcp.server("hn"), undefined, "the token's own is removed");
});

/** A seam at the store's checked removal: `between` runs once, after every read the removal makes, right before its
 *  statement. */
function beforeTheStatement(store, between) {
  const real = store.mcp.removeIfCredential;
  const ran = { done: false };
  store.mcp.removeIfCredential = async (...args) => {
    store.mcp.removeIfCredential = real;
    await between();
    ran.done = true;
    return real.apply(store.mcp, args);
  };
  return ran;
}

test("the token's removal is the token's in its own statement: the owner's save landing after every read the removal makes, right before its statement, is never removed (412), and stays as the owner saved it", async (t) => {
  const { store, registry } = await servers(t);
  registry.loopback = true;
  const [fake, owners] = [await startFakeMcp(), await startFakeMcp({ name: "owners-mcp" })];
  t.after(() => Promise.all([fake.close(), owners.close()]));
  // The token's save, then the owner's save over it (another address, no credential either: the credential's mark the
  // removal was let through against is the same after it), each the registry's own.
  await registry.save("hn", { url: fake.url }, undefined, undefined, undefined, undefined, undefined, undefined, true);
  const row = await store.mcp.server("hn");
  let ownerSaved;
  const seam = beforeTheStatement(store, async () => (ownerSaved = await registry.save("hn", { url: owners.url })));
  await assert.rejects(registry.remove("hn", credentialMark(row), true), (error) => error.code === "precondition_failed");
  assert.ok(seam.done && ownerSaved?.name === "hn", "the owner's save landed between");
  assert.equal((await store.mcp.server("hn"))?.url, owners.url, "the owner's server stays, as the owner saved it");
  await assert.rejects(registry.remove("hn", credentialMark(await store.mcp.server("hn")), true), (error) => error.code === "precondition_failed", "and it is the owner's");
});

test("a Composio server the token saved, its key read from COMPOSIO_API_KEY: the owner's save keeping it, landing right before the token's removal statement, is never removed (412), and nothing is answered to send to Composio", async (t) => {
  const was = process.env.COMPOSIO_API_KEY;
  t.after(() => (was === undefined ? delete process.env.COMPOSIO_API_KEY : (process.env.COMPOSIO_API_KEY = was)));
  process.env.COMPOSIO_API_KEY = COMPOSIO_KEY;
  const { store, registry } = await servers(t);
  // As the API-only token's Composio save leaves it: auth headers sealing nothing, its record naming the variable, marked.
  const row = await saveMcpServer(store, KEY, { name: "hn", url: "http://127.0.0.1:9/v3/mcp/srv_a/mcp", auth: "headers", tools: [] });
  const tokens = storedSource({ source: "composio", toolkit: "hackernews" }, row, false, true);
  await store.settings.put(mcpSourceKey("hn"), tokens);
  await store.settings.put(composioMadeKey("hn"), storedMade({ user: "per_run", auth_config: null, accounts: [], per_run: true, key_env: "COMPOSIO_API_KEY" }, row));
  // The owner's save over it, as each one lands: the record's mark dropped first, then its row written (its key kept).
  const seam = beforeTheStatement(store, async () => {
    await store.settings.put(mcpSourceKey("hn"), ownersRecord(tokens));
    assert.ok(await store.mcp.rewrite({ ...row, instructions: "The owner's." }, null));
  });
  let answered;
  await assert.rejects(async () => (answered = await registry.remove("hn", credentialMark(row), true)), (error) => error.code === "precondition_failed");
  assert.ok(seam.done, "the owner's save landed between");
  assert.equal(answered, undefined, "nothing answered to send to Composio");
  assert.equal((await store.mcp.server("hn"))?.instructions, "The owner's.", "the owner's server stays");
  assert.ok(await store.settings.get(composioMadeKey("hn")), "and what it stands on at Composio is still recorded");
});

test("a save writes its row and its record in its server's turn: the owner's save made between the token's row and the token's mark waits for both, so the mark never lands on the owner's row and the token never removes it", async (t) => {
  const { store, registry } = await servers(t);
  registry.loopback = true;
  const [fake, owners] = [await startFakeMcp(), await startFakeMcp({ name: "owners-mcp" })];
  t.after(() => Promise.all([fake.close(), owners.close()]));
  // Once armed: the owner's save asking for the name's turn, or the owner's row written, whichever comes first.
  let armed = false;
  let asked;
  const askedTurn = new Promise((resolve) => (asked = resolve));
  let wrote;
  const ownerWrote = new Promise((resolve) => (wrote = resolve));
  const turn = registry.nameTurn;
  registry.nameTurn = function (name, work) {
    if (armed) asked();
    return turn.call(this, name, work);
  };
  const putIf = store.mcp.putIfCredential;
  store.mcp.putIfCredential = async function (row, expected, tokens, ...owns) {
    const written = await putIf.call(this, row, expected, tokens, ...owns);
    if (armed && !tokens) wrote();
    return written;
  };
  // The seam: the token's mark, right after the token's row is written. The owner's save starts there and the mark waits
  // for it to reach the name's turn (or, with no turn, to write its row).
  let owner;
  const put = store.settings.put;
  store.settings.put = async function (key, value) {
    if (key === mcpSourceKey("hn") && value?.by === "token" && !owner) {
      armed = true;
      owner = registry.save("hn", { url: owners.url });
      await Promise.race([askedTurn, ownerWrote]);
    }
    return put.call(this, key, value);
  };
  await registry.save("hn", { url: fake.url }, undefined, undefined, undefined, undefined, undefined, undefined, true);
  assert.ok(owner, "the owner's save started between the token's row and its mark");
  assert.equal((await owner)?.name, "hn");
  const row = await store.mcp.server("hn");
  assert.equal(row?.url, owners.url, "the owner's save stands");
  await assert.rejects(registry.remove("hn", credentialMark(row), true), (error) => error.code === "precondition_failed", "the token's mark is not on the owner's row");
  assert.equal((await store.mcp.server("hn"))?.url, owners.url);
});

test("the owner's save over the token's server makes it the owner's as its row is written: the token's removal landing right after that write, before anything else of the save, is refused (412), and the owner's server stays", async (t) => {
  const { store, registry } = await servers(t);
  registry.loopback = true;
  const [fake, owners] = [await startFakeMcp(), await startFakeMcp({ name: "owners-mcp" })];
  t.after(() => Promise.all([fake.close(), owners.close()]));
  await registry.save("hn", { url: fake.url }, undefined, undefined, undefined, undefined, undefined, undefined, true);
  // The token's removal, let through against the token's row (the owner's save over it keeps its credential's mark: none).
  const row = await store.mcp.server("hn");
  // The seam: right after the owner's row write returns (a write with no token's mark to compare), the token's removal
  // runs to its end before the owner's save goes on. A delete takes no name's turn, so nothing else orders the two.
  let removal;
  const putIf = store.mcp.putIfCredential;
  store.mcp.putIfCredential = async function (...args) {
    const written = await putIf.apply(this, args);
    if (args[2] === undefined && written && removal === undefined) {
      removal = registry.remove("hn", credentialMark(row), true).then(() => "removed", (error) => error.code);
      await removal;
    }
    return written;
  };
  t.after(() => (store.mcp.putIfCredential = putIf));
  assert.equal((await registry.save("hn", { url: owners.url }))?.name, "hn");
  assert.equal(await removal, "precondition_failed", "the token's removal never takes the row the owner wrote");
  assert.equal((await store.mcp.server("hn"))?.url, owners.url, "the owner's server stays");
});

test("a preset whose key does not open here is `unusable`, and a server that is no preset answers nothing", async (t) => {
  const { store, registry } = await servers(t);
  const row = await preset(store, "srv_a");
  await store.mcp.put({ ...row, url: row.url.replace("127.0.0.1:9", "127.0.0.1:1") });
  assert.deepEqual(await registry.remove("hn"), { composio: { unusable: true } });
  await plain(store);
  assert.deepEqual(await registry.remove("hn"), {});
});
