// A saved server's credential goes only to the address of the row it was read with. The registry reads a server's row,
// waits (the address check, the listing), then opens its credential: if the owner saves the server at another address
// with a new credential in that wait, the new credential must never reach the old address. Each path that lists a saved
// server with its credential: the claim's and a first run's pin listing, preview by name, refresh. The store and fakes
// are local; no key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";

const { openSqliteStore, sealMcpCredential } = await import("../dist/store/index.js");
const { mcpServersOverStore } = await import("../dist/mcp-servers-store.js");
const { SEAL_KEY_ENV } = await import("../dist/tool-keys.js");

const OLD_TOKEN = `not-a-secret-${"old-address-token"}`;
const NEW_TOKEN = `not-a-secret-${"new-address-token"}`;

/** A store with "srv" saved at the old fake with its token, whose first read of "srv" returns that row after the owner
 *  has saved "srv" again at the new fake with a new token: the save lands between the registry's read and its open. */
async function raced(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "mcp-credential-race-"));
  const key = randomBytes(32);
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  const seen = [];
  const old = await startFakeMcp({ token: (authorization) => (seen.push(authorization), authorization === `Bearer ${OLD_TOKEN}`) });
  const fresh = await startFakeMcp({ token: NEW_TOKEN });
  t.after(async () => {
    await old.close();
    await fresh.close();
    await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  const row = (url, token) => ({ name: "srv", url, auth: "bearer", tools: [], sealed: sealMcpCredential(key, "srv", { type: "headers", headers: { authorization: `Bearer ${token}` } }, url) });
  await store.mcp.put(row(old.url, OLD_TOKEN));
  let reads = 0;
  const server = store.mcp.server.bind(store.mcp);
  const mcp = new Proxy(store.mcp, {
    get: (target, prop) => prop !== "server" ? (typeof target[prop] === "function" ? target[prop].bind(target) : target[prop]) : async (name) => {
      const read = await server(name);
      if (name === "srv" && reads++ === 0) await store.mcp.put(row(fresh.url, NEW_TOKEN));
      return read;
    },
  });
  const registry = mcpServersOverStore(new Proxy(store, { get: (target, prop) => (prop === "mcp" ? mcp : typeof target[prop] === "function" ? target[prop].bind(target) : target[prop]) }), { [SEAL_KEY_ENV]: key.toString("base64") }, "0.0.0-test");
  registry.attach("", "", true);
  t.after(() => registry.close?.());
  return { registry, seen, old, fresh };
}

const neverNew = (seen) => assert.ok(!seen.includes(`Bearer ${NEW_TOKEN}`), `the old address never got the new credential: ${JSON.stringify(seen.map((value) => value === `Bearer ${NEW_TOKEN}` ? "NEW" : value === `Bearer ${OLD_TOKEN}` ? "OLD" : value))}`);

test("a pin listing sends the credential of the row it read: a save at another address meanwhile never sends its credential to the old one", async (t) => {
  const { registry, seen } = await raced(t);
  await registry.pinListing("srv").catch(() => {});
  assert.ok(seen.length > 0, "the old address was listed");
  neverNew(seen);
});

test("a preview by name sends the credential of the row it read, never a newer one to the old address", async (t) => {
  const { registry, seen } = await raced(t);
  await registry.preview({ name: "srv" }).catch(() => {});
  assert.ok(seen.length > 0, "the old address was listed");
  neverNew(seen);
});

test("a refresh sends the credential of the row it read, never a newer one to the old address", async (t) => {
  const { registry, seen } = await raced(t);
  await registry.refresh("srv").catch(() => {});
  assert.ok(seen.length > 0, "the old address was listed");
  neverNew(seen);
});
