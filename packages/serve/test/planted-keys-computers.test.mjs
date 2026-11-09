// Rule 5: a vendor's key stays in the server's own calls to that vendor, never in a computer or on the disk. Every plant of
// the planted-secret harness (fixtures/planted-secrets.mjs) saves its value through the server's own route as the owner,
// faux-sandbox's FAUX_SANDBOX_KEY and the Archil account key among them. Then the run's computer is had as the runner's
// claim has it (computerForClaim), on the saved, sealed keys:
// - Mode 1, a sandbox on faux-sandbox: the provider is made with its key (the server's call), and the computer it is
//   asked to create (its spec: image, env, labels, mount, network) holds none, nor does anything the computer is sent;
// - Mode 1, a desktop on faux-desktop (--faux's own launch): it is handed no key;
// - Mode 2, a sandbox that mounts the run's folder from Archil: the mount credential is minted with the account key
//   (the server's call to Archil's control plane, a fetch function here: no port), and the computer's mount carries the
//   minted token alone; the disk's exec (Archil's serverless exec) is sent no key.
// After the claims are released, no file under the server's data dir, the run's scratch or TMPDIR holds a planted value.
// Each value is looked for in every form the harness knows (as is, base64, hex, URL-encoded, JSON-escaped, a 16-character
// piece).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { readBackOf as bindReadBackOf } from "@parcha/agentrun-computer";
import { runHands } from "../dist/workspace/run-tools.js";
import { fauxComputers } from "../dist/faux-computers.js";
import { openSqliteStore } from "../dist/store/index.js";
import { archilClaim, archilWorkspace, computerForClaim, localWorkspace } from "../dist/workspace/index.js";
import { archilControlFetch } from "./archil-control-fake.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { readBackOf as archilReadBackOf } from "./fixtures/archil-readback.mjs";
import { findPlanted, PLANTED_ARCHIL_SETTINGS, plantedOf, registeredPlants } from "./fixtures/planted-secrets.mjs";
import { call, cookieOf, serve, withEnv } from "./support.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";

const json = { "content-type": "application/json" };
const SPEC = () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" });

/** Every file under `dir`, as a source to scan: its path and its bytes as text. */
function filesUnder(dir) {
  const found = [];
  const walk = (path) => {
    let stat;
    try { stat = statSync(path); } catch { return; }
    if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    else if (stat.isFile()) {
      const bytes = readFileSync(path);
      found.push({ where: path, text: `${bytes.toString("utf8")}\n${bytes.toString("latin1")}` });
    }
  };
  walk(dir);
  return found;
}

/** A provider in the computer module's shape over a fake computer on `root`: what it is asked to create, and every call
 *  the computer is sent, recorded. */
function recordingProvider(root, record, groups = ["exec", "files", "processes"]) {
  const computer = fakeComputer(root);
  record.computerCalls = computer.calls;
  return {
    id: "recording", version: "0", capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }), check: () => [],
    list: async () => ({ ok: true, value: [] }),
    create: async (spec) => (record.created.push(spec), { ok: true, value: { id: "c1", name: "c1" } }),
    connect: async () => ({ ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups }, close: async () => {} } }),
    attach: async () => {
      const read = await computer.readBack();
      return { ok: true, value: { id: "c1", name: "c1", spec: { image: "i", user: "1000:1000", network: "none", ...(read.ok ? { mount: read.value } : {}) } } };
    },
    release: async () => ({ ok: true, value: undefined }),
  };
}

/** The harness's server (--faux), every plant's value saved through its own route as the owner; the server's data dir,
 *  its seal key, the planted values and the faux computers. TMPDIR is this test's alone, so a scan of it reads only what
 *  this test could have written there. */
async function planted(t) {
  const savedTmp = process.env.TMPDIR;
  const tmp = realpathSync(mkdtempSync(join(savedTmp ?? tmpdir(), "agentrun-planted-tmp-")));
  process.env.TMPDIR = tmp;
  t.after(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    rmSync(tmp, { recursive: true, force: true });
  });
  const sealKey = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey.toString("base64") });
  const server = await serve(t, { runner: false, accounts: true, openSetup: true });
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: `owner-${randomBytes(12).toString("hex")}` } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  const owner = async (method, path, body) => {
    const res = await call(server.port, { method, path, headers: { ...json, cookie, origin }, body: body ?? {} });
    let parsed;
    try { parsed = JSON.parse(res.text); } catch {}
    return { status: res.status, text: res.text, json: parsed };
  };
  const plants = registeredPlants();
  const names = plants.map((plant) => plant.name);
  assert.ok(names.includes("computer key (faux-sandbox)") && names.includes("Archil account key"), `the computer and Archil plants are registered: ${names.join(", ")}`);
  const values = [];
  const byName = {};
  for (const plant of plants) {
    const done = plantedOf(plant, await plant.write({ owner, token: owner, api: server.api, server }));
    values.push(...done.values);
    byName[plant.name] = done.values;
  }
  // The runner's store on the server's data dir, as a runner process opens it beside the server.
  const store = await openSqliteStore({ dataDir: server.data, role: "runner" });
  t.after(() => store.close().catch(() => {}));
  const scratch = join(tmp, "scratch");
  mkdirSync(join(scratch, "work"), { recursive: true });
  return { server, store, sealKey, values, byName, faux: fauxComputers({ viewerBase: origin }), scratch, tmp };
}

/** The planted values' hits in `sources`, none expected: where, which value (cut), in which form. */
const hitsIn = (sources, values) => findPlanted(sources, values);

test("Rule 5: with every key planted, a Mode 1 sandbox's computer, a faux desktop and a Mode 2 mounting sandbox are sent no key, and no file holds one", { timeout: 240_000 }, async (t) => {
  const world = await planted(t);
  const { store, sealKey, values, faux, scratch } = world;
  const [sandboxKey] = world.byName["computer key (faux-sandbox)"];
  const [archilKey] = world.byName["Archil account key"];

  // Mode 1, a sandbox on faux-sandbox: the provider is made with its key; the computer is sent none.
  const record = { created: [], options: [] };
  const sandbox = await computerForClaim({ runId: "run-1", epoch: 1, computer: { kind: "sandbox", provider: "faux-sandbox" } }, store, {
    mode: 1, kinds: faux.kinds, keyTable: faux.keyTable, sealKey, spec: SPEC,
    providers: { "faux-sandbox": (options) => (record.options.push(options), recordingProvider(join(scratch, "work"), record)) },
    workspace: localWorkspace(join(scratch, "work")), check: { readBackOf: bindReadBackOf, epoch: 1 },
  });
  assert.equal(sandbox.computer?.kind, "sandbox");
  assert.deepEqual(record.options, [{ apiKey: sandboxKey }], "the provider, the server's own call to its vendor, is made with the saved key");
  await sandbox.computer.computer.client.call("exec.run", { argv: ["true"] }).catch(() => undefined);
  await sandbox.release();

  // Mode 1, a desktop on faux-desktop: --faux's own launch, handed no key (it declares none).
  const launched = [];
  const desktop = await computerForClaim({ runId: "run-2", epoch: 1, computer: { kind: "desktop", provider: "faux-desktop" } }, store, {
    mode: 1, kinds: faux.kinds, keyTable: faux.keyTable, sealKey, spec: SPEC, providers: {},
    launch: async (entry, spec) => (launched.push({ provider: entry.id, spec }), faux.launch(entry, spec)),
    workspace: localWorkspace(join(scratch, "work")), check: { readBackOf: bindReadBackOf, epoch: 1 },
  });
  assert.equal(desktop.computer?.kind, "desktop");
  assert.equal(launched.length, 1);
  await desktop.release();

  // Mode 2, a sandbox that mounts the run's folder from Archil: minted with the account key; the computer gets the token.
  const control = archilControlFetch({ tokenOf: () => "fake-minted-mount-token-0001" });
  const disk = new FakeArchilDisk();
  const claim = await archilClaim({
    settings: PLANTED_ARCHIL_SETTINGS, keys: store.sealedKeys, sealKey, signal: new AbortController().signal, makeDisk: () => disk,
    mount: { runId: "run-3", epoch: 1, ttlMs: 86_400_000, baseUrl: control.baseUrl, fetch: control.fetch },
  });
  const workspace = archilWorkspace(disk, "agents/a/runs/run-3/work", { region: PLANTED_ARCHIL_SETTINGS.region, mountToken: () => claim.token() });
  const mounted = { created: [], options: [] };
  const archilKinds = { ...faux.kinds, PROVIDERS: faux.kinds.PROVIDERS.map((one) => (one.id === "faux-sandbox" ? { ...one, mounts: ["archil"] } : one)) };
  const remote = await computerForClaim({ runId: "run-3", epoch: 1, computer: { kind: "sandbox", provider: "faux-sandbox" } }, store, {
    mode: 2, kinds: archilKinds, keyTable: faux.keyTable, sealKey, spec: SPEC,
    providers: { "faux-sandbox": (options) => (mounted.options.push(options), recordingProvider(join(scratch, "work"), mounted)) },
    workspace, check: { readBackOf: archilReadBackOf, epoch: 1 }, revokeMount: () => claim.revoke(),
  });
  assert.equal(mounted.created[0]?.mount?.kind, "archil", "the run's folder is mounted from Archil");
  assert.equal(mounted.created[0].mount.token, "fake-minted-mount-token-0001", "with the token minted for the run");
  const mint = control.requests.find((request) => request.method === "POST");
  assert.equal(mint?.authorization, `Bearer ${archilKey}`, "the mint, the server's own call to Archil, is made with the account key");
  // The disk's serverless exec (Mode 2 with no computer runs the run's shell there, as runHands gives it): sent no key.
  const shell = await runHands(workspace, undefined, { mode: 2, context: ctx });
  const ran = await shell.hands.exec("printf hi", { timeoutS: 5 });
  assert.equal(ran.exitCode, 0, `the disk's exec ran: ${JSON.stringify(ran)}`);
  await remote.release();
  claim.release();

  // Nothing any computer or the disk was sent holds a planted value; nor does any file this test's server and claims had.
  const sources = [
    { where: "the Mode 1 sandbox's create spec", text: JSON.stringify(record.created) },
    { where: "the calls the Mode 1 sandbox was sent", text: JSON.stringify(record.computerCalls) },
    { where: "the faux desktop's launch", text: JSON.stringify(launched.map(({ spec }) => spec)) },
    { where: "the Mode 2 sandbox's create spec", text: JSON.stringify(mounted.created) },
    { where: "the calls the Mode 2 sandbox was sent", text: JSON.stringify(mounted.computerCalls) },
    { where: "what the Archil disk was sent (its exec among it)", text: JSON.stringify(disk.calls) },
    ...filesUnder(world.server.data).map((one) => ({ ...one, where: `the data dir: ${one.where}` })),
    ...filesUnder(scratch).map((one) => ({ ...one, where: `the run's scratch: ${one.where}` })),
    ...filesUnder(world.tmp).filter((one) => !one.where.startsWith(scratch)).map((one) => ({ ...one, where: `TMPDIR: ${one.where}` })),
  ];
  assert.ok(disk.calls.some((one) => one.op === "exec"), "the disk's exec ran");
  // The scan sees the values where they belong (the server's own calls), so a miss below is no blind spot.
  assert.ok(hitsIn([{ where: "the provider's options", text: JSON.stringify(record.options) }], values).length > 0, "the scan finds the faux-sandbox key in the server's own call");
  assert.ok(hitsIn([{ where: "the mint's request", text: JSON.stringify(control.requests) }], values).length > 0, "and the Archil key in the server's own call to Archil");
  assert.deepEqual(hitsIn(sources, values), [], "a planted key reached a computer, the disk or a file");
});
