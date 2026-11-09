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

test("after a mint and a mount, no file under the server's data dir, the run's scratch or TMPDIR holds the mount token", async (t) => {
  // TMPDIR for this test alone, so the scan reads only what this run could have written there.
  const savedTmp = process.env.TMPDIR;
  const tmp = realpathSync(mkdtempSync(join(savedTmp ?? tmpdir(), "agentrun-mount-tmp-")));
  process.env.TMPDIR = tmp;
  t.after(() => {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    rmSync(tmp, { recursive: true, force: true });
  });
  const control = await archilControlFake({ tokenOf: () => SENTINEL });
  t.after(() => control.close());
  const { store, dir: dataDir } = await storeOn(t);
  const sealKey = randomBytes(32);
  await putSealedKey(store, sealKey, "archil.api_key", "fake-test-key-archil-account-0001");
  await putSealedKey(store, sealKey, "DAYTONA_API_KEY", "fake-test-key-daytona-0001");
  const scratch = join(tmp, "scratch");
  mkdirSync(scratch);

  const disk = new FakeArchilDisk();
  const claim = await archilClaim({
    settings: SETTINGS, keys: store.sealedKeys, sealKey, signal: new AbortController().signal, makeDisk: () => disk,
    mount: { nickname: "agentrun run-1", ttlMs: 86_400_000, baseUrl: control.baseUrl },
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
  await answer.release();
  assert.equal(control.users.size, 0, "the credential was removed at the release");

  for (const [where, root] of [["the server's data dir", dataDir], ["the run's scratch", scratch], ["TMPDIR", tmp]]) {
    assert.deepEqual(filesHolding(root, SENTINEL), [], `no file under ${where} holds the token`);
  }
});
