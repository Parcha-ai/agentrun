// A computer provider's own secrets, serve side (workspace/computer-providers.ts providerSecretsOf): a provider whose
// descriptor declares `secrets` (Agent37's, whose SSH key the provider makes itself) is built with the server's store of
// them, one per server store, each sealed under the seal key in store.sealedKeys (AAD sealed_keys|<row>|sealed), so the
// key outlives a restart of the same store and is in no row in the clear. Agent37 then needs AGENT37_API_KEY alone.
import assert from "node:assert/strict";
import { createPrivateKey, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { providerFor } from "@parcha/agentrun-computer";
import { providerOptions } from "../dist/computer-keys.js";
import { getSealedKey } from "../dist/server-keys.js";
import { openSqliteStore } from "../dist/store/index.js";
import { computerDepsFrom } from "../dist/workspace/index.js";
import { fakeWorkspace } from "../../computer/test/fake-agent37.mjs";

const ROW = "computer.agent37.ssh_key";
const CTX = { timeoutMs: 10_000 };
const request = () => ({ name: "computer-0123456789ab", image: "agent37-base", labels: { "agentrun.computer": "1" }, lifetimeMs: 600_000, egress: false });

/** A store on a file of its own, opened again by `reopen` as a restarted server opens it; closed and removed after. */
async function storeFile(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-own-secrets-"));
  const file = join(dir, "store.sqlite");
  const open = [];
  const reopen = async () => {
    const store = await openSqliteStore({ file });
    open.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of open) await store.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  return { reopen };
}

/** Each base64 line of a PEM, the forms of it no stored byte or answer may hold. */
const bodyLines = (pem) => pem.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("-----"));

/** Runs argv on the instance: its exit code. */
async function exitOf(host, id, argv) {
  const proc = await host.exec(id, argv, CTX);
  proc.stdout.resume();
  proc.stderr.resume();
  await proc.end();
  return proc.wait();
}

test("Agent37 needs AGENT37_API_KEY alone: AGENT37_SSH_KEY is an optional override, passed only when saved", () => {
  const alone = providerOptions("agent37", { AGENT37_API_KEY: "fake-test-key" });
  assert.deepEqual(alone, { ok: true, options: { apiKey: "fake-test-key" } });
  const both = providerOptions("agent37", { AGENT37_API_KEY: "fake-test-key", AGENT37_SSH_KEY: "not-a-secret" });
  assert.equal(both.ok && both.options.sshKey, "not-a-secret");
});

test("a provider whose descriptor declares its own secrets is built with the server's sealed store of them; any other gets none, and none without a seal key", async () => {
  const loaded = [];
  const load = async (id, options) => (loaded.push([id, options]), { id });
  const store = { sealedKeys: { get: async () => undefined, put: async () => {}, remove: async () => {}, all: async () => [] }, computerLedger: {} };
  const { computerDeps } = computerDepsFrom({ env: {}, store, sealKey: randomBytes(32), load, daemon: async () => ({ up: true }) });
  await computerDeps.providers.agent37({ apiKey: "fake-test-key" }, { ledger: undefined });
  await computerDeps.providers.e2b({ apiKey: "fake-test-key" }, { ledger: undefined });
  const [[, agent37], [, e2b]] = loaded;
  assert.equal(typeof agent37.secrets?.get, "function");
  assert.equal(typeof agent37.secrets?.put, "function");
  assert.equal(e2b.secrets, undefined, "only a provider that declares it");
  const none = computerDepsFrom({ env: {}, store, sealKey: undefined, load, daemon: async () => ({ up: true }) });
  await none.computerDeps.providers.agent37({ apiKey: "fake-test-key" }, { ledger: undefined });
  assert.equal(loaded.at(-1)[1].secrets, undefined, "no seal key, no store: the provider keeps its key for its process");
});

test("the server's Agent37 key is made once, sealed in the store under computer.agent37.ssh_key, registered once, and reused after a restart of the same store", async (t) => {
  const fake = await fakeWorkspace();
  t.after(() => fake.sshd.close());
  const sealKey = randomBytes(32);
  const { reopen } = await storeFile(t);
  const depsOn = (store) => computerDepsFrom({ env: {}, store, sealKey, load: (id, options) => providerFor(id, options), daemon: async () => ({ up: true }) }).computerDeps;
  const first = await reopen();
  const provider = await depsOn(first).providers.agent37({ ...fake.options }, { ledger: undefined });
  const { id } = await provider.host.create(request(), CTX);
  assert.equal(await exitOf(provider.host, id, ["true"]), 0);
  const pem = await getSealedKey(first, sealKey, ROW);
  assert.equal(typeof pem, "string", "sealed under the server's seal key, at its own row");
  assert.equal(createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }), pem, "an ed25519 key's private half, PKCS#8 PEM");
  assert.equal(createPrivateKey(pem).asymmetricKeyType, "ed25519");
  const bytes = Buffer.from(await first.sealedKeys.get(ROW)).toString("latin1");
  for (const line of bodyLines(pem)) assert.ok(!bytes.includes(line), "the row holds sealed bytes, never the key");
  assert.equal(await getSealedKey(first, randomBytes(32), ROW), undefined, "another seal key opens none of it");
  assert.deepEqual((await first.sealedKeys.all()).map((row) => row.name), [ROW], "one row, the server's");
  const registered = fake.rest.calls.filter((call) => call.method === "POST" && call.path === "/v1/ssh-keys").length;
  assert.equal(registered, 1);
  await first.close();
  // The server restarts on the same store: the same key, read back, already on the workspace.
  const second = await reopen();
  const again = await depsOn(second).providers.agent37({ ...fake.options }, { ledger: undefined });
  assert.equal(await exitOf(again.host, id, ["true"]), 0);
  assert.equal(fake.rest.calls.filter((call) => call.method === "POST" && call.path === "/v1/ssh-keys").length, 1, "nothing registered again");
  assert.equal(await getSealedKey(second, sealKey, ROW), pem, "the same key");
  assert.equal(fake.rest.sshKeys.length, 1);
  assert.equal(fake.sshd.state.denied, 0);
  for (const line of bodyLines(pem)) assert.ok(!JSON.stringify(fake.rest.calls).includes(line), "no call to Agent37 carries the private key");
});

test("sealedKeys.putIfAbsent writes a row only where none is, in one statement: the first writer's bytes are kept", async (t) => {
  const { reopen } = await storeFile(t);
  const store = await reopen();
  assert.equal(await store.sealedKeys.putIfAbsent("x", Uint8Array.of(1, 2, 3)), true, "written");
  assert.equal(await store.sealedKeys.putIfAbsent("x", Uint8Array.of(4, 5, 6)), false, "a row is there: nothing written");
  assert.deepEqual([...(await store.sealedKeys.get("x"))], [1, 2, 3]);
});

/** Each of `providers` makes an instance and runs `true` on it, all at once: their exit codes. */
async function firstUseTogether(providers) {
  const made = await Promise.all(providers.map((provider) => provider.host.create(request(), CTX)));
  return Promise.all(providers.map((provider, i) => exitOf(provider.host, made[i].id, ["true"])));
}

test("five claims at once on one sealed store make one key: one row, one POST /v1/ssh-keys, one key on the workspace, every claim reaching its instance", async (t) => {
  const fake = await fakeWorkspace();
  t.after(() => fake.sshd.close());
  const sealKey = randomBytes(32);
  const { reopen } = await storeFile(t);
  const store = await reopen();
  const { computerDeps } = computerDepsFrom({ env: {}, store, sealKey, load: (id, options) => providerFor(id, options), daemon: async () => ({ up: true }) });
  const providers = await Promise.all(Array.from({ length: 5 }, () => computerDeps.providers.agent37({ ...fake.options }, { ledger: undefined })));
  assert.deepEqual(await firstUseTogether(providers), [0, 0, 0, 0, 0]);
  assert.deepEqual((await store.sealedKeys.all()).map((row) => row.name), [ROW], "one row");
  assert.equal(fake.rest.calls.filter((call) => call.method === "POST" && call.path === "/v1/ssh-keys").length, 1, "registered once");
  assert.equal(fake.rest.sshKeys.length, 1, "one key on the workspace");
  assert.equal(fake.sshd.state.denied, 0);
});

test("two servers on one database at their first use together keep one key: the row's, the one both register", async (t) => {
  const fake = await fakeWorkspace();
  t.after(() => fake.sshd.close());
  const sealKey = randomBytes(32);
  const { reopen } = await storeFile(t);
  const stores = [await reopen(), await reopen()];
  const providers = await Promise.all(
    stores.flatMap((store) => {
      const { computerDeps } = computerDepsFrom({ env: {}, store, sealKey, load: (id, options) => providerFor(id, options), daemon: async () => ({ up: true }) });
      return Array.from({ length: 3 }, () => computerDeps.providers.agent37({ ...fake.options }, { ledger: undefined }));
    }),
  );
  assert.deepEqual(await firstUseTogether(providers), [0, 0, 0, 0, 0, 0]);
  const kept = await getSealedKey(stores[0], sealKey, ROW);
  assert.equal(await getSealedKey(stores[1], sealKey, ROW), kept, "both read the one row");
  assert.equal(fake.rest.sshKeys.length, 1, "one key on the workspace: the loser's was never registered");
  assert.equal(fake.sshd.state.denied, 0);
});
