// Live claim suite on the shared scratch disk Two mounts with separate FUSE clients on
// this box stand in for two hosts; kill -9 of a FUSE daemon is a host loss. Everything lives under
// runs/p1-<stamp>-*/ and /mnt/pda/p1/; every token user, subdirectory and mount is recorded in P1-STATE.json and removed
// in `after`, also on failure. Measurements go to P1-live-results.json next to the ledger.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delegation, Disk } from "disk";
import { LIVE, REGION, scratchDisk, scratchDiskId } from "./_archil.ts";
import { ledger, LEDGER } from "./_p1-ledger.ts";
import { acquire, ARCHIL_SCOPED, createRunDir, findDelegations, mintMountToken, pathlessResolver, removeMountToken, revoke, revokeBestEffort, takeOver, unmountClaim, type AcquireOptions, type Claim, type ControlApi } from "../../src/claim.ts";
import { ClaimError, exitCodeFor, FencedError, HeldError } from "../../src/errors.ts";

const BASE = "/mnt/pda/p1";
const A = `${BASE}/a`; // user-owned mount root
const B = `${BASE}/b-root`; // root-owned mount root: mountpoints are created and removed through sudo
const C = `${BASE}/c`; // a sibling run's holder
const RESULTS = join(LEDGER, "..", "P1-live-results.json");
const STAMP = Date.now().toString(36);
// The journal window this suite answers for: everything sudo logged from here on.
const SINCE = Math.floor(Date.now() / 1000) - 1;

let disk: Disk;
let control: ControlApi;
const tokens: string[] = [];
const runIds: string[] = [];
const claims = new Set<Claim>();
const results: Record<string, unknown> = { at: new Date().toISOString(), client: "", disk: "" };

const r2 = (x: number) => Math.round(x * 100) / 100;
function stats(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  const rank = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
  return { n: v.length, p50: r2(rank(50)), p95: r2(rank(95)), max: r2(v[v.length - 1]), min: r2(v[0]), mean: r2(v.reduce((a, b) => a + b, 0) / v.length) };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ref = (id: string) => ({ disk: scratchDiskId(), region: REGION, id });

async function newRun(name: string): Promise<string> {
  const id = `p1-${STAMP}-${name}`;
  const t0 = performance.now();
  await createRunDir(control, id, { uid: 1000, gid: 1000 });
  ledger.subdir(`runs/${id}/`, `live ${name}`);
  runIds.push(id);
  ((results.createRunDirMs ??= []) as number[]).push(r2(performance.now() - t0));
  return id;
}

async function token(purpose: string, oneUse = false): Promise<string> {
  const nickname = `pda-p1-${purpose}-${STAMP}`.slice(0, 60);
  const t = await mintMountToken(control, { nickname, ttl: "2h", oneUse });
  ledger.token(t.identifier, nickname, `live ${purpose} (${oneUse ? "oneUse" : "reusable"}, ttl 2h)`);
  tokens.push(t.identifier);
  return t.token;
}

function track(claim: Claim): Claim {
  claims.add(claim);
  if (!claim.reused) ledger.mount(claim.root, `${claim.ref.disk}:/runs/${claim.ref.id}`);
  return claim;
}

async function claimAt(id: string, mountRoot: string, purpose: string, extra: Partial<AcquireOptions> = {}): Promise<Claim> {
  return track(await acquire({ ref: ref(id), token: await token(purpose), mountRoot, ...extra }));
}

async function release(claim: Claim): Promise<string> {
  const { via } = await claim.release();
  claims.delete(claim);
  ledger.unmounted(claim.root, via);
  return via;
}

function archilMounts(): string[] {
  return readFileSync("/proc/self/mounts", "utf8").split("\n").map((l) => l.split(" ")).filter((f) => f[2] === "fuse.archil").map((f) => f[1]);
}

function daemonPid(mountpoint: string): number {
  const rows = (spawnSync("pgrep", ["-a", "-f", "archil mount"], { encoding: "utf8" }).stdout ?? "").split("\n").map((l) => l.trim().split(/\s+/));
  const hit = rows.filter((p) => p[1]?.endsWith("/archil") && p[2] === "mount" && p.includes(mountpoint));
  assert.equal(hit.length, 1, `one daemon serves ${mountpoint}`);
  return Number(hit[0][0]);
}

function errno(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? String(e);
  }
}

function persist(path: string, text: string): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

before(async () => {
  if (!LIVE) return;
  disk = await scratchDisk();
  control = disk;
  ledger.disk(disk.id);
  results.disk = disk.id;
  results.client = spawnSync("/usr/bin/archil", ["--version"], { encoding: "utf8" }).stdout.split("\n")[0];
  assert.deepEqual(archilMounts().filter((m) => m.startsWith(`${BASE}/`)), [], "no P1 mounts left from an earlier run");
  spawnSync("sudo", ["mkdir", "-p", BASE, B]);
  spawnSync("sudo", ["chown", `${process.getuid!()}:${process.getgid!()}`, BASE]);
  mkdirSync(A, { recursive: true });
  mkdirSync(C, { recursive: true });
});

/** Delete everything under `prefix`: files first, then directory markers deepest first (a directory with children
 * refuses), then check the prefix is empty. DeleteObjects reports failures per key instead of throwing. */
async function deletePrefix(prefix: string): Promise<{ objects: number; errors: number; left: number }> {
  const keys = (await disk.listObjects(prefix, { recursive: true })).objects.map((o) => o.key);
  const dirs = [...new Set([...keys.filter((k) => k.endsWith("/")), prefix])];
  const depth = (k: string) => k.split("/").length;
  let errors = (await disk.deleteObjects(keys.filter((k) => !k.endsWith("/")), { quiet: true })).errors.length;
  for (const d of [...new Set(dirs.map(depth))].sort((x, y) => y - x)) {
    errors += (await disk.deleteObjects(dirs.filter((k) => depth(k) === d), { quiet: true })).errors.length;
  }
  const left = (await disk.listObjects(prefix, { recursive: true })).objects.length;
  return { objects: keys.length, errors, left };
}

after(async () => {
  if (!LIVE) return;
  const cleanup: { strayMounts: unknown[]; revokedLeftovers: unknown[]; prefixes: unknown[]; mountsAfter?: string[]; delegationsAfter?: number } = { strayMounts: [], revokedLeftovers: [], prefixes: [] };
  for (const claim of claims) {
    const via = await claim.release().then((r) => r.via, () => unmountClaim(claim.root).catch((e) => `failed: ${e}`));
    ledger.unmounted(claim.root, String(via));
  }
  for (const mp of archilMounts().filter((m) => m.startsWith(`${BASE}/`))) {
    const via = await unmountClaim(mp).catch((e) => `failed: ${e}`);
    ledger.unmounted(mp, String(via));
    cleanup.strayMounts.push({ mp, via });
  }
  for (const id of runIds) {
    const left = await revokeBestEffort(control, id).catch(() => []);
    if (left.length) cleanup.revokedLeftovers.push({ id, n: left.length });
    const del = await deletePrefix(`runs/${id}/`);
    cleanup.prefixes.push({ id, ...del });
    if (del.left === 0) ledger.subdirDeleted(`runs/${id}/`, del.objects);
    else ledger.event("subdirectory not fully deleted", { key: `runs/${id}/`, ...del });
  }
  for (const identifier of tokens) {
    await removeMountToken(control, identifier);
    ledger.tokenRemoved(identifier);
  }
  // Only the .stray directories this run made, by exact path; .stray itself goes with the empty-directory sweep.
  for (const dir of strays) spawnSync("sudo", ["-n", "rm", "-rf", "--", dir]);
  spawnSync("bash", ["-c", `sudo find ${BASE} -mindepth 1 -depth -type d -empty -delete`]);
  cleanup.mountsAfter = archilMounts().filter((m) => m.startsWith(`${BASE}/`));
  cleanup.delegationsAfter = (await Promise.all(runIds.map((id) => findDelegations(control, id)))).flat().length;
  results.cleanup = cleanup;
  writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");
});

test("a second exclusive mount is refused (76); release frees the claim; a refused mount spends its single-use token", { skip: !LIVE }, async () => {
  const id = await newRun("held");
  const a = await claimAt(id, A, "held-a");
  assert.equal(statSync(a.root).uid, 1000, "the S3 marker carried uid/gid");
  const held = await findDelegations(control, id);
  assert.equal(held.length, 1);
  assert.equal(held[0].isOrphaned, false);
  const tokB = await token("held-b", true);
  const t0 = performance.now();
  const err = await acquire({ ref: ref(id), token: tokB, mountRoot: B }).then(() => null, (e: unknown) => e);
  results.heldRefusalMs = r2(performance.now() - t0);
  assert.ok(err instanceof HeldError && err.exitCode === 76, String(err));
  assert.ok(!archilMounts().includes(join(B, "runs", id)));
  assert.deepEqual((await findDelegations(control, id)).map((d) => d.clientId), [held[0].clientId], "the holder is unchanged");
  await assert.rejects(createRunDir(control, id, { uid: 1000, gid: 1000 }), (e: unknown) => e instanceof HeldError, "PutObject on a held directory is 409");

  const t1 = performance.now();
  assert.equal(await release(a), "archil");
  results.releaseMs = r2(performance.now() - t1);
  assert.deepEqual(await findDelegations(control, id), [], "release checked the delegation in");
  await assert.rejects(acquire({ ref: ref(id), token: tokB, mountRoot: B }), (e: unknown) => e instanceof ClaimError && e.code === "MOUNT_FAILED" && /Authentication failed/.test(e.message), "the refused mount consumed the single-use token");
  const b = await claimAt(id, B, "held-b2");
  assert.equal(readFileSync(join(b.root, ".claim"), "utf8").includes(String(process.pid)), true);
  results.mountMs = [r2(a.timings.mountMs), r2(b.timings.mountMs)];
  results.verifyMs = [r2(a.timings.verifyMs), r2(b.timings.verifyMs)];
  await release(b);
});

test("takeover through the control API: revoke, then a plain mount; the old holder is fenced; a sibling run is untouched", { skip: !LIVE }, async () => {
  const id = await newRun("revoke");
  const sib = await newRun("revoke-sib");
  const a = await claimAt(id, A, "revoke-a");
  const c = await claimAt(sib, C, "revoke-sib");
  const sibHolder = (await findDelegations(control, sib))[0].clientId;
  persist(join(a.root, "synced.txt"), "synced\n");
  const fd = openSync(join(a.root, "synced.txt"), "a");
  const tokB = await token("revoke-b");
  const t0 = performance.now();
  const b = track(await takeOver(control, { ref: ref(id), token: tokB, mountRoot: B }));
  results.takeoverRevokeMs = r2(performance.now() - t0);
  assert.equal(b.forced, false);
  writeSync(fd, "zombie\n");
  assert.equal(errno(() => fsyncSync(fd)), "EIO", "the old holder's fsync fails");
  closeSync(fd);
  await assert.rejects(a.barrier(), (e: unknown) => e instanceof FencedError, "the old holder's barrier reports the fence");
  assert.equal(a.fenced, true);
  assert.equal(await release(a), "archil", "a fenced mount still unmounts cleanly");
  assert.equal(readFileSync(join(b.root, "synced.txt"), "utf8"), "synced\n", "the new holder sees exactly the fsynced prefix");
  writeFileSync(join(c.root, "after.txt"), "sibling\n");
  await c.barrier();
  assert.equal((await findDelegations(control, sib))[0].clientId, sibHolder, "the sibling's delegation survived the revoke");
  await release(b);
  await release(c);
});

test("takeover falls back to mount --force when the control API fails; the force is scoped to the run", { skip: !LIVE }, async () => {
  const id = await newRun("force");
  const sib = await newRun("force-sib");
  const a = await claimAt(id, A, "force-a");
  const c = await claimAt(sib, C, "force-sib");
  const sibHolder = (await findDelegations(control, sib))[0].clientId;
  const broken: ControlApi = { ...wrapControl(), listDelegations: () => Promise.reject(new Error("control API unavailable")) };
  const tokB = await token("force-b");
  const t0 = performance.now();
  const b = track(await takeOver(broken, { ref: ref(id), token: tokB, mountRoot: B }));
  results.takeoverForceMs = r2(performance.now() - t0);
  assert.equal(b.forced, true);
  // A forced-out client either refuses the new file (EROFS) or caches it and fails the barrier; both are the fence.
  const write = errno(() => writeFileSync(join(a.root, "zombie.txt"), "x"));
  if (write === "ok") await assert.rejects(a.barrier(), (e: unknown) => e instanceof FencedError);
  else assert.equal(write, "EROFS");
  a.markFenced(write);
  results.forcedOutNewFile = write;
  writeFileSync(join(c.root, "after-force.txt"), "sibling\n");
  await c.barrier();
  const sibNow = await findDelegations(control, sib);
  assert.deepEqual(sibNow.map((d) => [d.clientId, d.isOrphaned]), [[sibHolder, false]], "the force left the sibling's delegation alone");
  for (const claim of [a, b, c]) await release(claim);
});

test("a killed FUSE daemon: archil unmount refuses the dead mount, fusermount cleans it, the orphan blocks until revoked", { skip: !LIVE }, async () => {
  const id = await newRun("dead");
  const a = await claimAt(id, A, "dead-a");
  spawnSync("sudo", ["kill", "-9", String(daemonPid(a.root))]);
  const tKill = performance.now();
  let orphanedMs: number | null = null;
  while (performance.now() - tKill < 10_000) {
    if ((await findDelegations(control, id)).some((d) => d.isOrphaned)) {
      orphanedMs = r2(performance.now() - tKill);
      break;
    }
    await sleep(100);
  }
  results.orphanedAfterKillMs = orphanedMs;
  assert.equal(errno(() => statSync(a.root)), "ENOTCONN");
  const refused = spawnSync("sudo", ["-n", "/usr/bin/archil", "unmount", a.root], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not appear to be running/);
  await assert.rejects(a.release(), (e: unknown) => e instanceof FencedError, "an undetected dead mount fails its barrier");
  claims.delete(a);
  ledger.unmounted(a.root, "fusermount (daemon SIGKILLed)");
  assert.ok(!archilMounts().includes(a.root), "release cleaned the dead mount");
  await assert.rejects(acquire({ ref: ref(id), token: await token("dead-blocked"), mountRoot: B }), (e: unknown) => e instanceof HeldError, "the orphan blocks a plain mount");
  const orphan = await revoke(control, id);
  assert.deepEqual(orphan.map((d) => d.isOrphaned), [true]);

  // In-place restart onto a dead mount: acquire cleans it, then the orphan refuses the mount (76).
  const a2 = await claimAt(id, A, "dead-a2");
  spawnSync("sudo", ["kill", "-9", String(daemonPid(a2.root))]);
  claims.delete(a2);
  await sleep(300);
  await assert.rejects(acquire({ ref: ref(id), token: await token("dead-a3"), mountRoot: A }), (e: unknown) => e instanceof HeldError);
  ledger.unmounted(a2.root, "fusermount by acquire (daemon SIGKILLed)");
  assert.ok(!archilMounts().includes(a2.root), "acquire cleaned the dead mount first");
  const revoked = await revoke(control, id);
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].isOrphaned, true);
  const b = await claimAt(id, B, "dead-b");
  await release(b);
});

test("an in-place restart reuses its live mount without a token; after a revoke the reused mount is fenced", { skip: !LIVE }, async () => {
  const id = await newRun("reuse");
  const a = await claimAt(id, A, "reuse-a");
  const again = await acquire({ ref: ref(id), token: "spent", mountRoot: A });
  assert.equal(again.reused, true);
  await revoke(control, id);
  const list = spawnSync("sudo", ["-n", "/usr/bin/archil", "delegations", "--json", a.root], { encoding: "utf8" }).stdout;
  results.revokedClientStillListsActive = JSON.parse(list).some((d: { state: string }) => d.state === "Active");
  const fenced = await acquire({ ref: ref(id), token: "spent", mountRoot: A }).then(() => null, (e: unknown) => e);
  assert.ok(fenced instanceof FencedError, `only the probe write sees the revoke: ${fenced}`);
  results.reuseProbeCause = (fenced.cause as { code?: string } | undefined)?.code ?? String(fenced.cause);
  claims.delete(a);
  ledger.unmounted(a.root, "archil (verify failed: fenced)");
  assert.ok(!archilMounts().includes(a.root));
});

// 158 files, 12 MiB: 8 of 1 MiB and 150 of about 27.3 KiB across 10 directories.
function writeWorkspace(dir: string): Map<string, string> {
  const sums = new Map<string, string>();
  const small = Math.floor((4 * 1024 * 1024) / 150);
  for (let i = 0; i < 158; i++) {
    const rel = i < 8 ? `big/blob-${i}.bin` : `src/d${(i - 8) % 10}/f-${i}.dat`;
    const size = i < 8 ? 1024 * 1024 : i === 157 ? 4 * 1024 * 1024 - small * 149 : small;
    const data = randomBytes(size);
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), data);
    sums.set(rel, createHash("sha256").update(data).digest("hex"));
  }
  return sums;
}

test("barrier latency: clean, one small file, and a 12 MiB 158-file workspace (n=20 each)", { skip: !LIVE }, async () => {
  const id = await newRun("barrier");
  const a = await claimAt(id, A, "barrier");
  const clean: number[] = [], small: number[] = [], ws: number[] = [], wsWrite: number[] = [];
  for (let i = 0; i < 20; i++) clean.push((await a.barrier()).ms);
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(a.root, `small-${i}.txt`), randomBytes(4096));
    small.push((await a.barrier()).ms);
  }
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    writeWorkspace(join(a.root, "work", `ws-${i}`));
    wsWrite.push(performance.now() - t0);
    ws.push((await a.barrier()).ms);
  }
  results.barrier = { clean: stats(clean), small4KiB: stats(small), workspace12MiB158Files: stats(ws), workspaceWriteMs: stats(wsWrite) };
  await release(a);
});

test("durability across a daemon kill: no barrier, syncfs, archil sync (3 rounds of a 12 MiB workspace each)", { skip: !LIVE }, async () => {
  const out: Record<string, { files: number; present: number; intact: number; flushMs: number }[]> = { none: [], syncfs: [], barrier: [] };
  for (const [round, mode] of (["none", "syncfs", "barrier"] as const).flatMap((m) => [0, 1, 2].map((i) => [i, m] as const))) {
    const id = await newRun(`durable-${mode}-${round}`);
    const a = await claimAt(id, A, `durable-${mode}-${round}-a`);
    const sums = writeWorkspace(join(a.root, "work"));
    const t0 = performance.now();
    if (mode === "syncfs") assert.equal(spawnSync("sync", ["-f", a.root]).status, 0);
    if (mode === "barrier") await a.barrier();
    const flushMs = r2(performance.now() - t0);
    spawnSync("sudo", ["kill", "-9", String(daemonPid(a.root))]);
    claims.delete(a);
    await unmountClaim(a.root);
    ledger.unmounted(a.root, "fusermount (daemon SIGKILLed)");
    await revoke(control, id);
    const b = await claimAt(id, B, `durable-${mode}-${round}-b`);
    let present = 0, intact = 0;
    for (const [rel, sum] of sums) {
      try {
        const data = readFileSync(join(b.work, rel));
        present++;
        if (createHash("sha256").update(data).digest("hex") === sum) intact++;
      } catch {}
    }
    out[mode].push({ files: sums.size, present, intact, flushMs });
    await release(b);
  }
  results.durability = out;
  assert.deepEqual(out.barrier.map((r) => r.intact), [158, 158, 158], "every file survives after the barrier");
});

test("claim cycle latency: acquire and release (n=20), takeover by revoke and by force (n=10 each)", { skip: !LIVE }, async () => {
  const id = await newRun("cycle");
  const acq: number[] = [], mount: number[] = [], verify: number[] = [], rel: number[] = [];
  for (let i = 0; i < 20; i++) {
    const tok = await token(`cycle-${i}`);
    const t0 = performance.now();
    const c = track(await acquire({ ref: ref(id), token: tok, mountRoot: i % 2 ? B : A }));
    acq.push(performance.now() - t0);
    mount.push(c.timings.mountMs);
    verify.push(c.timings.verifyMs);
    const t1 = performance.now();
    await release(c);
    rel.push(performance.now() - t1);
  }
  const byRevoke: number[] = [], byForce: number[] = [];
  const broken: ControlApi = { ...wrapControl(), listDelegations: () => Promise.reject(new Error("control API unavailable")) };
  for (let i = 0; i < 20; i++) {
    const forced = i >= 10;
    const old = await claimAt(id, A, `cycle-old-${i}`);
    const tok = await token(`cycle-new-${i}`);
    const t0 = performance.now();
    const fresh = track(await takeOver(forced ? broken : control, { ref: ref(id), token: tok, mountRoot: B }));
    (forced ? byForce : byRevoke).push(performance.now() - t0);
    assert.equal(fresh.forced, forced);
    old.markFenced("taken over");
    await release(old);
    await release(fresh);
  }
  results.cycle = { acquire: stats(acq), mount: stats(mount), verify: stats(verify), release: stats(rel), takeoverByRevoke: stats(byRevoke), takeoverByForce: stats(byForce) };
});

function wrapControl(): ControlApi {
  return {
    putObject: (key, body, options) => disk.putObject(key, body, options),
    addUser: (user) => disk.addUser(user),
    removeUser: (type, identifier) => disk.removeUser(type, identifier),
    listDelegations: () => disk.listDelegations(),
    revokeDelegation: (d) => disk.revokeDelegation(d),
    exec: (command) => disk.exec(command),
  };
}

test("a non-exclusive mount at the claim's mountpoint fails verification and is unmounted (--shared, --conditional)", { skip: !LIVE }, async () => {
  const out: Record<string, unknown> = {};
  for (const flag of ["--shared", "--conditional"]) {
    const id = await newRun(`mode${flag.replace(/-/g, "")}`);
    const mp = join(A, "runs", id);
    mkdirSync(mp, { recursive: true });
    const tok = await token(`mode${flag}`);
    const m = spawnSync("sudo", ["-n", ARCHIL_SCOPED, "mount", flag, `${scratchDiskId()}:/runs/${id}`, mp, "--region", REGION], {
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
      input: `${tok}\n`,
      encoding: "utf8",
    });
    assert.equal(m.status, 0, `${flag} mount`);
    ledger.mount(mp, `${scratchDiskId()}:/runs/${id} ${flag}`);
    out[flag] = {
      clientDelegations: JSON.parse(spawnSync("sudo", ["-n", "/usr/bin/archil", "delegations", "--json", mp], { encoding: "utf8" }).stdout),
      controlDelegations: (await findDelegations(control, id)).length,
    };
    await assert.rejects(acquire({ ref: ref(id), token: "unused", mountRoot: A }), (e: unknown) => e instanceof ClaimError && e.code === "CLAIM_NOT_VERIFIED", flag);
    ledger.unmounted(mp, "archil (verify failed: not exclusive)");
    assert.ok(!archilMounts().includes(mp), `${flag} mount was unmounted`);
  }
  results.nonExclusive = out;
});

/**
 * Lines in a log matching an extended regex, counted by grep: the matching lines are never read into this process. The
 * pattern goes on stdin, since sudo logs its command line and a pattern there would match itself.
 */
function countLines(source: "journal" | "auth.log", pattern: string): number {
  const cmd = source === "journal"
    ? `journalctl --since @${SINCE} --no-pager -q | grep -c -E -- "$p"`
    : `grep -c -E -- "$p" /var/log/auth.log`;
  const r = spawnSync("sudo", ["-n", "bash", "-c", `IFS= read -r p; ${cmd} || true`], { input: `${pattern}\n`, encoding: "utf8" });
  const n = Number(r.stdout.trim());
  assert.ok(Number.isInteger(n), `counting ${source} lines failed: ${r.stderr.trim().slice(0, 200)}`);
  return n;
}

// ---- a run's mountpoint holding files written while it was not mounted -------------------------------------------------

/** process.stderr lines written while `fn` runs. */
async function stderrLines<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => (lines.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    return { value: await fn(), lines };
  } finally {
    process.stderr.write = write;
  }
}

/** What root sees at a path under a root-only .stray: `<uid> <mode>` of the directory, or whether a file is there. */
const rootStat = (path: string) => spawnSync("sudo", ["-n", "stat", "-c", "%u %a", path], { encoding: "utf8" }).stdout.trim();
const rootHas = (path: string) => spawnSync("sudo", ["-n", "test", "-f", path]).status === 0;
const strays: string[] = [];

async function seededAcquire(id: string, mountRoot: string, seed: (mp: string) => void) {
  const mp = `${mountRoot}/runs/${id}`;
  seed(mp);
  const { value: claim, lines } = await stderrLines(() => claimAt(id, mountRoot, `stray-${id.slice(-6)}`));
  if (claim.stray) strays.push(claim.stray.to);
  const seen = readdirSync(claim.root).sort();
  const logged = lines.filter((l) => l.includes("stray entries moved aside")).map((l) => JSON.parse(l));
  await release(claim);
  const objects = (await disk.listObjects(`runs/${id}/`, { recursive: true })).objects.map((o) => o.key.slice(`runs/${id}/`.length));
  return { claim, seen, logged, objects };
}

test("P6's control as a test: archil refuses a mountpoint holding one unrelated file; acquire moves it to .stray, mounts, and the run stays clean", { skip: !LIVE }, async () => {
  const id = await newRun("stray-a");
  const mp = `${A}/runs/${id}`;
  mkdirSync(mp, { recursive: true });
  writeFileSync(join(mp, "unrelated.txt"), "x\n");
  // The control: archil itself over the seeded directory, through the wrapper as the claim calls it.
  const direct = spawnSync("sudo", ["-n", ARCHIL_SCOPED, "mount", `${scratchDiskId()}:/runs/${id}`, mp, "--region", REGION], { input: `${await token("stray-control")}\n`, encoding: "utf8", timeout: 120_000 });
  const refusal = (direct.stderr + direct.stdout).split(/[\r\n]+/).find((l) => l.includes("✗")) ?? "";
  assert.notEqual(direct.status, 0, "archil does not mount over a directory with an entry");
  assert.match(refusal, /os error 115|Unspecified Error|is not empty/);
  assert.equal(archilMounts().includes(mp), false);
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && (await findDelegations(control, id)).length; ) await sleep(250);

  const r = await seededAcquire(id, A, () => {});
  assert.equal(r.claim.stray?.entries, 1);
  assert.equal(r.claim.stray?.to.startsWith(`${A}/.stray/${id}-`), true);
  assert.equal(rootHas(join(r.claim.stray!.to, "unrelated.txt")), true, ".stray holds the file");
  assert.equal(rootStat(`${A}/.stray`), "0 700", ".stray is root's, 0700");
  assert.deepEqual(r.seen, [".claim"], "through the mount the run holds only its own probe");
  assert.equal(r.objects.some((k) => k.includes("unrelated")), false, "the run on the disk never got the file");
  assert.equal(r.logged.length, 1);
  assert.deepEqual([r.logged[0].run, r.logged[0].entries], [id, 1]);
  results.stray = { control: { exit: direct.status, refusal: refusal.replace(mp, "<mp>").slice(0, 200) }, userOwnedRoot: { entries: r.claim.stray?.entries, mountMs: r2(r.claim.timings.mountMs), seen: r.seen, objects: r.objects } };
});

test("the same under a root-owned mount root: the mountpoint made through sudo, its leftovers moved aside as root", { skip: !LIVE }, async () => {
  const id = await newRun("stray-b");
  const r = await seededAcquire(id, B, (mp) => {
    const made = spawnSync("sudo", ["-n", "bash", "-c", 'mkdir -p "$1" && mkdir -p "$1/jobs" && echo x > "$1/run.json" && echo y > "$1/jobs/a.json"', "bash", mp]);
    assert.equal(made.status, 0);
  });
  assert.equal(r.claim.stray?.entries, 2);
  assert.equal(rootHas(join(r.claim.stray!.to, "jobs", "a.json")), true);
  assert.equal(rootStat(`${B}/.stray`), "0 700");
  assert.deepEqual(r.seen, [".claim"]);
  assert.equal(r.objects.some((k) => k.includes("run.json") || k.includes("jobs")), false);
  (results.stray as Record<string, unknown>).rootOwnedRoot = { entries: r.claim.stray?.entries, seen: r.seen, objects: r.objects };
});

// ---- an archil daemon left on a run's mountpoint with no mount -----------------------------------------------------------

/** The pids whose argument vector is /usr/bin/archil's `mount` naming exactly `mountpoint`. */
function archilDaemonsOf(mountpoint: string): number[] {
  return readdirSync("/proc").filter((n) => /^\d+$/.test(n)).filter((pid) => {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      return argv[0] === "/usr/bin/archil" && argv[1] === "mount" && argv.slice(2).includes(mountpoint);
    } catch {
      return false;
    }
  }).map(Number);
}

test("a daemon outliving its mount (lazily unmounted under a held reference): archil refuses the next mount as 'an older Archil process' (MOUNT_FAILED, exit 1, never 76); acquire kills it through the wrapper and mounts", { skip: !LIVE }, async () => {
  const id = await newRun("stale");
  const a = await claimAt(id, A, "stale-a");
  persist(join(a.root, "before.txt"), "kept\n");
  const old = daemonPid(a.root);
  // A process whose cwd is in the mount keeps the FUSE connection, so the daemon serves on after the mount leaves the table.
  const holder = spawn("sleep", ["600"], { cwd: a.root, stdio: "ignore" });
  const blind = mkdtempSync(join(tmpdir(), "pda-noproc-"));
  try {
    await sleep(300);
    assert.equal(spawnSync("sudo", ["-n", "umount", "-l", a.root], { timeout: 30_000 }).status, 0);
    claims.delete(a);
    ledger.unmounted(a.root, "umount -l under a held reference (its daemon kept running)");
    await sleep(2_000);
    assert.equal(archilMounts().includes(a.root), false);
    assert.deepEqual(archilDaemonsOf(a.root), [old], "the daemon outlives its mount");

    // archil's own refusal, with the claim blind to the daemon (an empty process table): exit 1, not held.
    const t0 = performance.now();
    const refused = await acquire({ ref: ref(id), token: await token("stale-blind"), mountRoot: A, host: { proc: blind, timeoutMs: { mount: 60_000 } } }).then(() => null, (e: unknown) => e);
    const refusedMs = r2(performance.now() - t0);
    assert.ok(refused instanceof ClaimError && refused.code === "MOUNT_FAILED", String(refused));
    assert.ok(!(refused instanceof HeldError));
    assert.equal(exitCodeFor(refused), 1);
    assert.match(refused.message, /an older Archil process is still running/);

    // The stale daemon still holds the run's delegation: the takeover a supervisor makes when the lease has expired.
    const revoked = await revoke(control, id);
    assert.equal(revoked.length, 1);
    const { value: b, lines } = await stderrLines(() => claimAt(id, A, "stale-b", { host: { timeoutMs: { staleGrace: 2_000 } } }));
    const logged = lines.filter((l) => l.includes("stale archil daemon killed")).map((l) => JSON.parse(l));
    assert.deepEqual(logged.map((l) => [l.run, l.pids]), [[id, [old]]]);
    assert.equal(existsSync(`/proc/${old}`), false, "the stale daemon is gone");
    assert.deepEqual(archilDaemonsOf(b.root), [daemonPid(b.root)], "only the new mount's daemon");
    assert.equal(readFileSync(join(b.root, "before.txt"), "utf8"), "kept\n");
    results.staleDaemon = { refusal: { code: refused.code, exit: exitCodeFor(refused), ms: refusedMs }, revokedBeforeAcquire: revoked.length, acquireMountMs: r2(b.timings.mountMs), graceMs: 2_000 };
    await release(b);
  } finally {
    holder.kill("SIGKILL");
    // By exact argument vector only: the old daemon, if a failure above left it.
    const left = archilDaemonsOf(a.root).filter((pid) => pid === old);
    if (left.length) spawnSync("sudo", ["-n", "kill", "-9", ...left.map(String)]);
    rmSync(blind, { recursive: true, force: true });
  }
});

test("a run id reused three times, its third holder killed: the orphan is found by path, or with every path hidden by the run's inode, and revoked", { skip: !LIVE }, async () => {
  const id = await newRun("reuse3");
  let a: Claim | null = null;
  for (const k of [1, 2, 3]) {
    if (k > 1) await createRunDir(control, id, { uid: 1000, gid: 1000 });
    a = await claimAt(id, A, `reuse3-${k}`);
    if (k < 3) {
      await release(a);
      assert.equal((await deletePrefix(`runs/${id}/`)).left, 0, `incarnation ${k} deleted, then recreated at once`);
    }
  }
  spawnSync("sudo", ["kill", "-9", String(daemonPid(a!.root))]);
  let orphan: Delegation | undefined;
  const t = performance.now();
  while (!orphan && performance.now() - t < 10_000) {
    orphan = (await findDelegations(control, id)).find((d) => d.isOrphaned);
    if (!orphan) await sleep(100);
  }
  assert.ok(orphan, "the killed holder's delegation is found");
  assert.equal((await pathlessResolver(control)([orphan])).get(orphan.inodeId), id, "exec find names the delegation's inode as runs/<id>");
  // The control API lists a path best-effort; here every path is withheld, as when it lists none.
  const hidden: ControlApi = { ...wrapControl(), listDelegations: async () => (await disk.listDelegations()).map((d) => ({ ...d, path: undefined })) };
  const found = await findDelegations(hidden, id);
  assert.deepEqual(found.map((d) => [d.clientId, d.inodeId]), [[orphan.clientId, orphan.inodeId]], "exactly this run's delegation, never another run's");
  results.reuseInode = { pathListed: orphan.path ?? null, inodeId: orphan.inodeId, matchedWithPathsHidden: found.length };
  await assert.rejects(acquire({ ref: ref(id), token: await token("reuse3-blocked"), mountRoot: B }), (e: unknown) => e instanceof HeldError, "the orphan blocks a plain mount");
  assert.equal((await revoke(hidden, id)).length, 1);
  await assert.rejects(a!.release(), (e: unknown) => e instanceof FencedError);
  claims.delete(a!);
  ledger.unmounted(a!.root, "fusermount (daemon SIGKILLed)");
  await release(await claimAt(id, B, "reuse3-b"));
});

test("no mount token reaches sudo's log: zero ARCHIL_MOUNT_TOKEN= lines for this run's mounts", { skip: !LIVE }, async () => {
  // Runs last: every mount above went through the wrapper. A fresh one makes the check stand on its own.
  const id = await newRun("journal");
  await release(await claimAt(id, A, "journal"));
  const mine = `p1-${STAMP}-`;
  const logged = countLines("journal", `COMMAND=.*archil-scoped mount .*${mine}`);
  assert.ok(logged > 0, "sudo logged this run's wrapper mounts, so a zero below means something");
  const journal = countLines("journal", `ARCHIL_MOUNT_TOKEN=.*${mine}`);
  const authLog = countLines("auth.log", `ARCHIL_MOUNT_TOKEN=.*${mine}`);
  results.tokenLog = { since: SINCE, wrapperMountsLogged: logged, journalTokenLines: journal, authLogTokenLines: authLog, anyLaneJournalTokenLines: countLines("journal", "ARCHIL_MOUNT_TOKEN=") };
  assert.equal(journal, 0, "no journal line carries a mount token for this run");
  assert.equal(authLog, 0, "no auth.log line carries a mount token for this run");
});
