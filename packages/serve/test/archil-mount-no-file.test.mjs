// The run's Archil mount credential is never in a file: after a mint (at a loopback fake of Archil's control API) and a
// mount (a Mode 2 sandbox started by computerForClaim on a fake provider, the run's folder an Archil Workspace over a fake
// disk), no file under the server's data dir, the run's scratch or TMPDIR holds the token. The token is a sentinel the
// fake control API mints, so a hit anywhere is this run's.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { putSealedKey } from "../dist/server-keys.js";
import { archilClaim, archilWorkspace, computerForClaim } from "../dist/workspace/index.js";
import { archilControlFake } from "./archil-control-fake.mjs";
import { FakeArchilDisk } from "./fixtures/archil-fake.mjs";
import { readBackOf } from "./fixtures/archil-readback.mjs";
import { storeOn } from "./store-helpers.mjs";
import { fakeComputer } from "./workspace-fake-computer.mjs";
import { ARCHIL_KINDS } from "./workspace-kinds-fixture.mjs";

const SENTINEL = `sentinel-archil-mount-token-${randomBytes(12).toString("hex")}`;
const SETTINGS = { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.green.us-east-1.aws.prod.archil.com" };

/** Every file under `dir` whose bytes hold `needle`, by path. */
function filesHolding(dir, needle) {
  const hits = [];
  const walk = (path) => {
    let stat;
    try { stat = statSync(path); } catch { return; }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (stat.isFile() && readFileSync(path).includes(needle)) {
      hits.push(path);
    }
  };
  walk(dir);
  return hits;
}

/** A Mode 2 run's claim on the fakes, its sandbox started by computerForClaim with the run's folder mounted: the claim's
 *  signal's controller, the started computer, what the provider was asked to create, the fake control API, and the
 *  three places to scan. `existing`: token users the disk holds already (an earlier claim's). */
async function mountedRun(t, { existing = [] } = {}) {
  // TMPDIR for this test alone, so the scan reads only what this run could have written there.
  const savedTmp = process.env.TMPDIR;
  const tmp = realpathSync(mkdtempSync(join(savedTmp ?? tmpdir(), "agentrun-mount-tmp-")));
  process.env.TMPDIR = tmp;
  t.after(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    rmSync(tmp, { recursive: true, force: true });
  });
  const control = await archilControlFake({ tokenOf: () => SENTINEL, existing });
  t.after(() => control.close());
  const { store, dir: dataDir } = await storeOn(t);
  const sealKey = randomBytes(32);
  await putSealedKey(store, sealKey, "archil.api_key", "fake-test-key-archil-account-0001");
  await putSealedKey(store, sealKey, "DAYTONA_API_KEY", "fake-test-key-daytona-0001");
  const scratch = join(tmp, "scratch");
  mkdirSync(scratch);

  const disk = new FakeArchilDisk();
  const controller = new AbortController();
  const claim = await archilClaim({
    settings: SETTINGS, keys: store.sealedKeys, sealKey, signal: controller.signal, makeDisk: () => disk,
    mount: { runId: "run-1", epoch: 3, ttlMs: 86_400_000, baseUrl: control.baseUrl },
  });
  const workspace = archilWorkspace(disk, "agents/a/runs/run-1/work", { region: SETTINGS.region, mountToken: () => claim.token() });
  const created = [];
  const computer = fakeComputer(scratch);
  const provider = {
    id: "fake", version: "0", capabilities: () => ({ lifetime: "janitor", maxLifetimeMs: 86_400_000 }), check: () => [],
    list: async () => ({ ok: true, value: [] }),
    create: async (spec) => (created.push(spec), { ok: true, value: { id: "c1", name: "c1" } }),
    connect: async () => ({ ok: true, value: { client: computer.client, hello: { version: "0", os: "linux", kind: "linux", arch: "amd64", groups: ["exec", "files", "processes"] }, close: async () => {} } }),
    attach: async () => ({ ok: true, value: { id: "c1", name: "c1", spec: { image: "i", user: "1000:1000", network: "none" } } }),
    release: async () => ({ ok: true, value: undefined }),
  };
  const answer = await computerForClaim({ runId: "run-1", epoch: 3, computer: { kind: "sandbox", provider: "daytona" } }, store, {
    mode: 2, kinds: ARCHIL_KINDS, sealKey, providers: { daytona: () => provider },
    spec: () => ({ image: "agentrun/computer:test", lifetimeMs: 60_000, network: "none" }),
    workspace, check: { readBackOf, epoch: 3 }, revokeMount: () => claim.revoke(),
  });
  assert.equal(answer.computer?.kind, "sandbox");
  assert.equal(created[0].mount?.kind, "archil", "the run's folder was mounted");
  assert.equal(created[0].mount.token, SENTINEL, "with the minted token, in memory");
  return { controller, answer, control, places: [["the server's data dir", dataDir], ["the run's scratch", scratch], ["TMPDIR", tmp]] };
}

/** No file under any of `places` holds the token. */
function noFileHolds(places) {
  for (const [where, root] of places) assert.deepEqual(filesHolding(root, SENTINEL), [], `no file under ${where} holds the token`);
}

/** Waits (bounded) for a request on its way to land: the fake's users to come to `size`. */
async function usersAt(control, size) {
  for (let tries = 0; control.users.size !== size && tries < 2000; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  return control.users.size;
}

test("after a mint, a mount and the release, the credential is removed and no file under the data dir, the run's scratch or TMPDIR holds it", async (t) => {
  const { answer, control, places } = await mountedRun(t);
  await answer.release();
  assert.equal(control.users.size, 0, "the credential was removed at the release");
  noFileHolds(places);
});

test("a lost claim removes the credential at once, and no file holds it", async (t) => {
  const { controller, control, places } = await mountedRun(t);
  controller.abort(new Error("the claim was fenced"));
  assert.equal(await usersAt(control, 0), 0, "removed when the claim was lost, not left for its ttl");
  noFileHolds(places);
});

test("a reclaim removes an earlier claim's credential before it mints its own, and no file holds either", async (t) => {
  const { answer, control, places } = await mountedRun(t, { existing: [{ identifier: "tok-epoch-2", nickname: "agentrun:run-1:2" }] });
  assert.ok(!control.users.has("tok-epoch-2"), "epoch 2's credential removed before epoch 3's was minted");
  const order = control.requests.map((one) => one.method);
  assert.ok(order.indexOf("DELETE") < order.indexOf("POST"), `removed before the mint: ${order.join(", ")}`);
  await answer.release();
  assert.equal(control.users.size, 0);
  noFileHolds(places);
});
