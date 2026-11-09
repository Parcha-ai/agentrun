// A Daytona sandbox on the runner path with Archil on (Mode 2), through computerForClaim: the provider built by the
// computer package's providerFor("daytona", ...) from the server's key by name (computerProviderMakers); the run's folder
// asked for as an Archil mount with the per-run minted token; the box's spec carrying no vendor key and no database or
// Redis credential; the kinded sandbox RunComputer, its groups from its hello; release removing the token. Every
// boundary is a fake: providerFor is a stand-in, the Archil control API a loopback fake, the disk a fake; no Daytona or
// Archil call leaves this machine. The registry is the agreed stand-in with Daytona taking Archil mounts (D6, which the
// cut's own registry does not have yet: it refuses this run in words, the last case).
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
import { ARCHIL_KINDS } from "./workspace-kinds-fixture.mjs";

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const DAYTONA_KEY = "fake-test-key-daytona-0001";
const ARCHIL_KEY = "fake-test-key-archil-account-0001";
const SETTINGS = { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };

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

/** A Mode 2 Daytona claim on the fakes: the server's Daytona and Archil keys sealed, a fake control API, a fake disk. */
async function daytonaClaim(t, kinds = ARCHIL_KINDS) {
  const control = await archilControlFake();
  t.after(() => control.close());
  const { store } = await storeOn(t);
  const sealKey = randomBytes(32);
  await putSealedKey(store, sealKey, "DAYTONA_API_KEY", DAYTONA_KEY);
  await putSealedKey(store, sealKey, "archil.api_key", ARCHIL_KEY);
  const disk = new FakeArchilDisk();
  const claim = await archilClaim({ settings: SETTINGS, keys: store.sealedKeys, sealKey, signal: new AbortController().signal, makeDisk: () => disk, mount: { runId: "run-1", epoch: 3, ttlMs: 86_400_000, baseUrl: control.baseUrl } });
  const workspace = archilWorkspace(disk, "agents/a/runs/run-1/work", { region: SETTINGS.region, mountToken: () => claim.token() });
  const scratch = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-daytona-")));
  dirs.push(scratch);
  const computer = fakeComputer(scratch);
  const record = { loaded: [], created: [], released: [] };
  const provider = {
    id: "daytona", version: "0", capabilities: () => ({ lifetime: "vendor" }), check: () => [],
    list: async () => ({ ok: true, value: [] }),
    create: async (spec) => (record.created.push(spec), { ok: true, value: { id: "d1", name: "d1" } }),
    connect: async () => ({ ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } }),
    attach: async () => ({ ok: true, value: { id: "d1", name: "d1", spec: { image: "i", user: "1000:1000", network: "none" } } }),
    release: async (ref, how) => (record.released.push([ref.id, how]), { ok: true, value: undefined }),
  };
  const providers = computerProviderMakers({ load: async (id, options) => (record.loaded.push([id, options]), provider) });
  const run = () => computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "sandbox", provider: "daytona" } }, store, {
    mode: 2, kinds, sealKey, providers,
    spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }),
    workspace, check: { readBackOf, epoch: 3 }, revokeMount: () => claim.revoke(),
  });
  return { run, record, control };
}

test("a Mode 2 Daytona sandbox: providerFor with the saved key by name, the Archil mount with the minted token, no key or credential in the box, the kinded sandbox, release removes the token", async (t) => {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL };
  process.env.DATABASE_URL = "postgres://sentinel-db-credential@db.invalid/app";
  process.env.REDIS_URL = "redis://:sentinel-redis-credential@redis.invalid:6379";
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const { run, record, control } = await daytonaClaim(t);
  const answer = await run();
  assert.deepEqual(record.loaded, [["daytona", { apiKey: DAYTONA_KEY }]], "built by providerFor('daytona') from the saved DAYTONA_API_KEY");
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
  for (const secret of [DAYTONA_KEY, ARCHIL_KEY, "sentinel-db-credential", "sentinel-redis-credential"]) assert.ok(!text.includes(secret), `no ${secret} in the box's spec`);
  assert.equal(answer.computer.kind, "sandbox");
  // The mount check reads back under the claim's epoch (readBackOf(mount, epoch)).
  assert.equal(answer.computer.check.epoch, 3);
  assert.deepEqual(answer.computer.check.readBackOf(spec.mount, 3), { kind: "archil", disk: SETTINGS.diskId, region: SETTINGS.region, folder: "agents/a/runs/run-1/work", exclusive: true, epoch: 3 });
  assert.deepEqual([...answer.computer.computer.client ? ["client"] : []], ["client"]);
  assert.equal(control.users.size, 1, "one token user while the run holds its computer");
  await answer.release();
  assert.deepEqual(record.released, [["d1", "delete"]]);
  assert.equal(control.users.size, 0, "the token removed with the computer");
});

test("on the cut's own registry (Daytona takes no Archil mount until D6) a Mode 2 Daytona sandbox is refused in words, nothing made", async (t) => {
  const { run, record } = await daytonaClaim(t, { SETTING_KINDS, PROVIDERS, servingRefusals });
  const error = await run().then(() => undefined, (thrown) => thrown);
  assert.equal(error?.code, "computer_unavailable");
  assert.match(error.message, /A Daytona sandbox can't mount the run's folder from Archil/);
  assert.deepEqual(record.created, []);
});
