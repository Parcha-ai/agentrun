// A remote sandbox on the runner path with Archil on (Mode 2), through computerForClaim, on the computer package's own
// kind registry: since #1994 (D6) Daytona, Modal and E2B take Archil mounts there. Each provider built by the computer
// package's providerFor(<id>, ...) from the server's keys by name (computerProviderMakers); the run's folder asked for as
// an Archil mount with the per-run minted token; the box's spec carrying no vendor key and no database or Redis
// credential; the kinded sandbox RunComputer, its groups from its hello; release removing the token. Every boundary is a
// fake: providerFor is a stand-in, the Archil control API a loopback fake, the disk a fake; no Daytona, Modal, E2B or
// Archil call leaves this machine.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { PROVIDERS, SETTING_KINDS, servingRefusals } from "@parcha/agentrun-computer";
import { putSealedKey } from "../dist/server-keys.js";
import { archilClaim, archilWorkspace, computerForClaim, computerProviderMakers } from "../dist/workspace/index.js";
import { archilControlFake } from "./archil-control-fake.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { readBackOf } from "./fixtures/archil-readback.mjs";
import { storeOn } from "./store-helpers.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

/** The computer package's own kind registry, as the server's composer takes it. */
const REAL_KINDS = { SETTING_KINDS, PROVIDERS, servingRefusals };

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const DAYTONA_KEY = "fake-test-key-daytona-0001";
const MODAL_ID = `fake-test-modal-id-${"0001"}`;
const MODAL_SECRET = `fake-test-modal-secret-${"0001"}`;
const E2B_KEY = `fake-test-key-e2b-${"0001"}`;
const ARCHIL_KEY = "fake-test-key-archil-account-0001";
const SETTINGS = { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };
/** Each remote sandbox's saved keys, and the options providerFor is given from them (computer-keys.ts). */
const PROVIDER_KEYS = {
  daytona: { keys: { DAYTONA_API_KEY: DAYTONA_KEY }, options: { apiKey: DAYTONA_KEY } },
  modal: { keys: { MODAL_TOKEN_ID: MODAL_ID, MODAL_TOKEN_SECRET: MODAL_SECRET }, options: { tokenId: MODAL_ID, tokenSecret: MODAL_SECRET, app: "agentrun" } },
  e2b: { keys: { E2B_API_KEY: E2B_KEY }, options: { apiKey: E2B_KEY } },
};

test("computerProviderMakers builds each provider through the computer package's providerFor, with the options the keys fill", async () => {
  const loaded = [];
  const makers = computerProviderMakers({ load: async (id, options) => (loaded.push([id, options]), { id }) });
  const ledger = { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} };
  const daytona = await makers.daytona({ apiKey: DAYTONA_KEY }, { ledger });
  assert.equal(daytona.id, "daytona");
  assert.deepEqual(loaded, [["daytona", { apiKey: DAYTONA_KEY }]], "providerFor('daytona', its options), and nothing else");
  await makers["phone-harness"]({ apiKey: "pk" }, { ledger });
  assert.deepEqual(loaded[1], ["phone-harness", { apiKey: "pk", ledger }], "the phone provider takes the store's ledger");
  for (const id of ["docker", "daytona", "modal", "e2b", "orgo", "phone-harness", "browserbase", "kernel"]) assert.equal(typeof makers[id], "function", id);
});

/** A Mode 2 claim of a sandbox on `provider` on the fakes, on the real registry: its saved keys and the Archil account key
 *  sealed, a fake control API, a fake disk. */
async function archilSandbox(t, provider = "daytona", { existing = [] } = {}) {
  const control = await archilControlFake({ existing });
  t.after(() => control.close());
  const { store } = await storeOn(t);
  const sealKey = randomBytes(32);
  for (const [name, value] of Object.entries(PROVIDER_KEYS[provider].keys)) await putSealedKey(store, sealKey, name, value);
  await putSealedKey(store, sealKey, "archil.api_key", ARCHIL_KEY);
  const disk = new FakeArchilDisk();
  const controller = new AbortController();
  const claim = await archilClaim({ settings: SETTINGS, keys: store.sealedKeys, sealKey, signal: controller.signal, makeDisk: () => disk, mount: { runId: "run-1", epoch: 3, ttlMs: 86_400_000, baseUrl: control.baseUrl } });
  const workspace = archilWorkspace(disk, "agents/a/runs/run-1/work", { region: SETTINGS.region, mountToken: () => claim.token() });
  const scratch = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-archil-sandbox-")));
  dirs.push(scratch);
  const computer = fakeComputer(scratch);
  const record = { loaded: [], created: [], released: [] };
  const stand = {
    id: provider, version: "0", capabilities: () => ({ lifetime: "vendor", mount: "archil" }), check: () => [],
    list: async () => ({ ok: true, value: [] }),
    create: async (spec) => (record.created.push(spec), { ok: true, value: { id: "d1", name: "d1" } }),
    connect: async () => ({ ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } }),
    attach: async () => ({ ok: true, value: { id: "d1", name: "d1", spec: { image: "i", user: "1000:1000", network: "none" } } }),
    release: async (ref, how) => (record.released.push([ref.id, how]), { ok: true, value: undefined }),
  };
  const providers = computerProviderMakers({ load: async (id, options) => (record.loaded.push([id, options]), stand) });
  const run = () => computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "sandbox", provider } }, store, {
    mode: 2, kinds: REAL_KINDS, sealKey, providers,
    spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }),
    workspace, check: { readBackOf, epoch: 3 }, revokeMount: () => claim.revoke(),
  });
  return { run, record, control, controller };
}

/** Waits (bounded) for the remove on its way to land: the fake's users to come to `size`. */
async function usersAt(control, size) {
  for (let tries = 0; control.users.size !== size && tries < 2000; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  return control.users.size;
}

/** The full Archil path of a Mode 2 sandbox on `provider`, on the real registry: built by providerFor from its saved keys,
 *  the Archil mount with the minted token (there alone), the run's labels, no key or credential in the box, the kinded
 *  sandbox, the read-back under the claim's epoch, and the token removed with the computer. */
async function fullArchilPath(t, provider) {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL };
  process.env.DATABASE_URL = "postgres://sentinel-db-credential@db.invalid/app";
  process.env.REDIS_URL = "redis://:sentinel-redis-credential@redis.invalid:6379";
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const { run, record, control } = await archilSandbox(t, provider);
  const answer = await run();
  assert.deepEqual(record.loaded, [[provider, PROVIDER_KEYS[provider].options]], `built by providerFor('${provider}') from its saved keys`);
  const spec = record.created[0];
  // The mount's exact shape (the computer package's archil mount, #1994): the per-run minted token goes only here.
  assert.deepEqual(spec.mount, { kind: "archil", disk: SETTINGS.diskId, region: SETTINGS.region, folder: "agents/a/runs/run-1/work", token: "fake-minted-token-1" });
  // The labels are the run's and the claim epoch's (runLabels), and never agentrun.mount, which the provider writes itself.
  assert.deepEqual(spec.labels, { "agentrun.run": "run-1", "agentrun.epoch": "3" });
  assert.ok(!Object.hasOwn(spec.labels, "agentrun.mount"), "agentrun.mount is the provider's own label");
  assert.equal(spec.env, undefined, "the box is given no environment of ours");
  const outsideMount = JSON.stringify({ ...spec, mount: undefined });
  assert.ok(!outsideMount.includes("fake-minted-token-1"), "the token is in the mount alone: not in labels, env or anything else");
  const text = JSON.stringify(spec);
  for (const secret of [...Object.values(PROVIDER_KEYS[provider].keys), ARCHIL_KEY, "sentinel-db-credential", "sentinel-redis-credential"]) assert.ok(!text.includes(secret), `no ${secret} in the box's spec`);
  assert.equal(answer.computer.kind, "sandbox");
  // The mount check reads back under the claim's epoch (readBackOf(mount, epoch)).
  assert.equal(answer.computer.check.epoch, 3);
  assert.deepEqual(answer.computer.check.readBackOf(spec.mount, 3), { kind: "archil", disk: SETTINGS.diskId, region: SETTINGS.region, folder: "agents/a/runs/run-1/work", exclusive: true, epoch: 3 });
  assert.ok(answer.computer.computer.client, "its computerd client");
  assert.equal(control.users.size, 1, "one token user while the run holds its computer");
  await answer.release();
  assert.deepEqual(record.released, [["d1", "delete"]]);
  assert.equal(control.users.size, 0, "the token removed with the computer");
}

test("a Daytona run's lost claim removes its token at once; a reclaim removes an earlier claim's before it mints", async (t) => {
  const lost = await archilSandbox(t);
  await lost.run();
  assert.equal(lost.control.users.size, 1);
  lost.controller.abort(new Error("the claim was fenced"));
  assert.equal(await usersAt(lost.control, 0), 0, "removed when the claim was lost");
  const reclaim = await archilSandbox(t, "daytona", { existing: [{ identifier: "tok-epoch-2", nickname: "agentrun:run-1:2" }] });
  const answer = await reclaim.run();
  const order = reclaim.control.requests.map((one) => one.method);
  assert.ok(order.indexOf("DELETE") < order.indexOf("POST"), `epoch 2's removed before epoch 3's mint: ${order.join(", ")}`);
  assert.ok(!reclaim.control.users.has("tok-epoch-2"));
  await answer.release();
  assert.equal(reclaim.control.users.size, 0);
});

test("Settings → Computers' factories are built from the same makers: one place builds a provider", async () => {
  const { computerProviderFactories } = await import("../dist/workspace/index.js");
  const loaded = [];
  const ledgers = [];
  const factories = computerProviderFactories(computerProviderMakers({ load: async (id, options) => (loaded.push([id, options]), { id }) }), (id) => (ledgers.push(id), { id }));
  assert.equal((await factories.daytona({ apiKey: DAYTONA_KEY })).id, "daytona");
  await factories["phone-harness"]({ apiKey: "pk" });
  assert.deepEqual(loaded, [["daytona", { apiKey: DAYTONA_KEY }], ["phone-harness", { apiKey: "pk", ledger: { id: "phone-harness" } }]]);
  assert.deepEqual(ledgers, ["daytona", "phone-harness"]);
});

test("the computer package's registry gives Daytona, Modal and E2B Archil mounts (#1994): the remote sandboxes Mode 2 runs on", () => {
  for (const id of ["daytona", "modal", "e2b"]) assert.deepEqual(PROVIDERS.find((one) => one.id === id)?.mounts, ["archil"], id);
});

test("a Mode 2 Daytona sandbox on the real registry: providerFor with the saved key by name, the Archil mount with the minted token, no key or credential in the box, the kinded sandbox, release removes the token", async (t) => {
  await fullArchilPath(t, "daytona");
});

test("a Mode 2 Modal sandbox on the real registry takes the same Archil path, built from its saved token pair", async (t) => {
  await fullArchilPath(t, "modal");
});

test("a Mode 2 E2B sandbox on the real registry takes the same Archil path, built from its saved key", async (t) => {
  await fullArchilPath(t, "e2b");
});
