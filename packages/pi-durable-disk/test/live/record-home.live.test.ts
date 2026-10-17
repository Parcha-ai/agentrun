// Live recordHome on the shared scratch disk: a claim on this box stands in for a runner on a box of its own. It writes a
// recording into its run's record directory through the mount, fsyncing per batch as the runner's recorder does, and
// archilPlace.recordHome brings it home over S3 while the claim is held; then the delegation is revoked (a takeover
// after the box is lost) and the final call still brings home everything that was fsynced. Everything lives under
// runs/rh-<stamp>/ and /mnt/pda/p1/rh; the token user, the run directory and the mount are in P1-STATE.json and removed
// in `after`, also on failure.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_ENV, LIVE, REGION, RUN_OWNER, scratchDiskId } from "./_archil.ts";
import { ledger } from "./_p1-ledger.ts";
import { acquire, createRunDir, mintMountToken, removeMountToken, revoke, unmountClaim, type Claim } from "../../src/claim.ts";
import { archilPlace } from "../../src/place.ts";
import { archilControl, deleteRunTree, type ArchilControl, type HostDriver } from "../../src/supervise.ts";

const BASE = "/mnt/pda/p1/rh";
const STAMP = Date.now().toString(36);
const ID = `rh-${STAMP}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let control: ArchilControl;
let claim: Claim | undefined;
let token: string | undefined;
let made = false;
const scratch: string[] = [];

/** A driver the place never starts anything with: this check uses recordHome alone. */
const inert: HostDriver = {
  start: async () => {
    throw new Error("not used");
  },
  status: async () => "unknown",
  stop: async () => {},
};

/** Through the mount, as the runner's recorder does: whole lines appended and fsynced, a new file's directory fsynced too. */
function append(file: string, text: string): void {
  const created = !existsSync(file);
  const fd = openSync(file, "a");
  writeSync(fd, text);
  fsyncSync(fd);
  closeSync(fd);
  if (created) syncDir(join(file, ".."));
}
function writeWhole(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  writeSync(fd, text);
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, file);
  syncDir(join(file, ".."));
}
function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  fsyncSync(fd);
  closeSync(fd);
}
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;

/** `bringHome` until `done` holds of what is home (S3 sees an fsynced write within moments), at most 20 s. */
async function carryUntil(bring: () => Promise<void>, done: () => boolean): Promise<number> {
  const t0 = performance.now();
  for (;;) {
    await bring();
    if (done()) return Math.round(performance.now() - t0);
    if (performance.now() - t0 > 20_000) throw new Error("the recording did not come home within 20 s");
    await sleep(500);
  }
}

before(async () => {
  if (!LIVE) return;
  control = await archilControl({ apiKey: process.env[KEY_ENV]!, disk: scratchDiskId(), region: REGION });
  ledger.disk(scratchDiskId());
});

after(async () => {
  if (!LIVE) return;
  if (claim) {
    const via = await claim.release().then((r) => r.via, () => unmountClaim(claim!.root).catch((e: unknown) => `failed: ${e}`));
    ledger.unmounted(claim.root, String(via));
  }
  if (made) {
    const del = await deleteRunTree(control, ID);
    ledger.subdirDeleted(`runs/${ID}/`, del.objects);
  }
  if (token) {
    await removeMountToken(control, token);
    ledger.tokenRemoved(token);
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

test("recordHome brings a mount's recording home over S3 while the claim is held, and all of it after the holder is revoked", { skip: !LIVE, timeout: 180_000 }, async () => {
  await createRunDir(control, ID, RUN_OWNER);
  made = true;
  ledger.subdir(`runs/${ID}/`, "live recordHome");
  const minted = await mintMountToken(control, { nickname: `pda-p1-rh-${STAMP}`, ttl: "2h" });
  token = minted.identifier;
  ledger.token(minted.identifier, minted.nickname, "live recordHome (reusable, ttl 2h)");
  mkdirSync(BASE, { recursive: true });
  claim = await acquire({ ref: { disk: scratchDiskId(), region: REGION, id: ID }, token: minted.token, mountRoot: BASE });
  ledger.mount(claim.root, `runs/${ID}`);

  const place = archilPlace({ disk: scratchDiskId(), region: REGION, control, host: inert, mountRoot: BASE })({ paths: { id: ID, root: "/x", work: "/x/work", store: "/x/store" } });
  const dir = place.recordHome!.dir(1);
  assert.equal(dir, join(claim.root, "record", "1"), "the attempt's directory is in the claimed run");
  mkdirSync(join(dir, ".spool"), { recursive: true });
  mkdirSync(join(dir, "blobs"), { recursive: true });
  syncDir(dir);
  const frame = "a frame the runner kept";
  const hash = createHash("sha256").update(frame).digest("hex");
  writeWhole(join(dir, "blobs", `${hash}.png`), frame);
  append(join(dir, ".spool", "child-1.1.jsonl"), `${line({ seq: 0, blobs: [hash] })}${line({ seq: 1 })}{"seq":`);

  const into = mkdtempSync(join(tmpdir(), "pda-rh-home-"));
  scratch.push(into);
  const home = (name: string) => (existsSync(join(into, ".spool", name)) ? readFileSync(join(into, ".spool", name), "utf8") : "");
  const firstMs = await carryUntil(() => place.recordHome!.bringHome(into), () => home("child-1.1.jsonl") === `${line({ seq: 0, blobs: [hash] })}${line({ seq: 1 })}`);
  assert.equal(readFileSync(join(into, "blobs", `${hash}.png`), "utf8"), frame, "the blob came home with its line");

  // More lines, the partial one finished, and a rotated segment; then the holder is revoked, as after a lost box.
  append(join(dir, ".spool", "child-1.1.jsonl"), `2}\n`);
  append(join(dir, ".spool", "child-1.2.jsonl"), line({ seq: 3 }));
  const revoked = await revoke(control, ID);
  const finalMs = await carryUntil(() => place.recordHome!.bringHome(into, { final: true }), () => home("child-1.2.jsonl") === line({ seq: 3 }));
  assert.equal(home("child-1.1.jsonl"), [0, 1, 2].map((seq) => line(seq === 0 ? { seq, blobs: [hash] } : { seq })).join(""));
  await place.recordHome!.bringHome(into, { final: true });
  assert.equal(home("child-1.1.jsonl").split("\n").length - 1, 3, "a second final call brings nothing twice");
  process.stdout.write(`# recordHome live: first carry ${firstMs} ms, final after revoke ${finalMs} ms, revoked ${revoked.length} delegation(s)\n`);
});
