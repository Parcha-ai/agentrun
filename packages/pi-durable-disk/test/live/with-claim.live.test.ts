// Live withClaim and readReleased on the scratch disk: two carry backs to one path queue and both commit; a holder lost
// with its host (its process and its archil daemon killed) is revoked by the next carry back, which commits; and
// readReleased reads back a database that opens and holds exactly the committed rows. Everything lives under
// withclaim-live/<stamp>/ and /mnt/pda/p10/, is recorded in P10-STATE.json as it is made (the live check's sweep unmounts a
// mount it lists and reports the directory), and is removed in `after`, also on failure. Skips without PDA_LIVE=1.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { LIVE, REGION, scratchDiskId } from "./_archil.ts";
import { statePath } from "./_paths.ts";
import { archilControl, type ArchilControl } from "../../src/supervise.ts";
import { readReleased } from "../../src/with-claim.ts";

const BASE = "/mnt/pda/p10";
const CHILD = fileURLToPath(new URL("./with-claim-child.ts", import.meta.url));
const STAMP = Date.now().toString(36);
const PATH = `withclaim-live/${STAMP}`;
let control: ArchilControl;
const children: ChildProcess[] = [];

// The ledger: what this suite made, written the moment it exists and stamped when it is gone.
const LEDGER = statePath("PDA_P10_STATE", "P10-STATE.json");
type Entry = Record<string, unknown>;
const ledger: { lane: "P10"; disk: string | null; subpaths: Entry[]; mounts: Entry[] } = { lane: "P10", disk: null, subpaths: [], mounts: [] };
const save = () => {
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
};
const stamp = (entries: Entry[], field: string, match: (e: Entry) => boolean) => {
  for (const e of entries) if (match(e) && e[field] === undefined) e[field] = new Date().toISOString();
  save();
};

/** A carry back in a process of its own; resolves with its exit code and what it printed. */
function carry(label: string, mode: "commit" | "hold", holdMs?: number) {
  const child = spawn(process.execPath, [CHILD, scratchDiskId(), REGION, PATH, BASE, label, mode, ...(holdMs ? [String(holdMs)] : [])], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  const lines: string[] = [];
  let root = "";
  const holding = new Promise<string>((resolve) => createInterface({ input: child.stdout! }).on("line", (line) => {
    lines.push(line);
    if (!line.startsWith("held ")) return;
    root = line.slice("held ".length);
    ledger.mounts.push({ mountpoint: root, label, createdAt: new Date().toISOString() });
    save();
    resolve(root);
  }));
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => {
    if (code === 0 && root) stamp(ledger.mounts, "unmountedAt", (e) => e.mountpoint === root); // withClaim unmounted it
    resolve(code);
  }));
  return { child, lines, holding, exited };
}

/** Delete `prefix` (a directory key, `.../`) over S3: files, then directories deepest first. Returns the objects left. */
async function deleteTree(prefix: string): Promise<number> {
  const keys = (await control.listObjects(prefix, { recursive: true })).objects.map((o) => o.key);
  const dirs = [...new Set([...keys.filter((k) => k.endsWith("/")), prefix])];
  const depth = (k: string) => k.split("/").length;
  await control.deleteObjects(keys.filter((k) => !k.endsWith("/")), { quiet: true });
  for (const d of [...new Set(dirs.map(depth))].sort((x, y) => y - x)) await control.deleteObjects(dirs.filter((k) => depth(k) === d), { quiet: true });
  return (await control.listObjects(prefix, { recursive: true })).objects.length;
}

/** Pids of the archil daemons serving `mountpoint` (a mount names it as an argument), read from /proc. */
function daemonsOf(mountpoint: string): number[] {
  return readdirSync("/proc").filter((n) => /^\d+$/.test(n)).filter((pid) => {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      return argv.some((a) => a.endsWith("archil")) && argv.includes("mount") && argv.includes(mountpoint);
    } catch {
      return false;
    }
  }).map(Number);
}

before(async () => {
  if (!LIVE) return;
  control = await archilControl({ apiKey: process.env.ARCHIL_API_KEY!, disk: scratchDiskId(), region: REGION });
  ledger.disk = scratchDiskId();
  ledger.subpaths.push({ key: PATH, createdAt: new Date().toISOString() });
  save();
});

after(async () => {
  if (!LIVE) return;
  for (const child of children) child.kill("SIGKILL");
  // A mount the lost holder left: dead once its daemon was killed.
  for (const line of readFileSync("/proc/mounts", "utf8").split("\n")) {
    const mountpoint = line.split(" ")[1];
    if (mountpoint?.startsWith(`${BASE}/`)) spawnSync("sudo", ["-n", "fusermount", "-u", mountpoint]);
  }
  const mounted = new Set(readFileSync("/proc/mounts", "utf8").split("\n").map((line) => line.split(" ")[1]));
  stamp(ledger.mounts, "unmountedAt", (e) => !mounted.has(e.mountpoint as string));
  const left = await deleteTree(`${PATH}/`).catch(() => -1);
  if (left === 0) stamp(ledger.subpaths, "deletedAt", (e) => e.key === PATH);
  // withclaim-live/ itself, once nothing else is under it.
  const parent = await control.listObjects("withclaim-live/", { recursive: true }).catch(() => ({ objects: [{ key: "?" }] }));
  if (parent.objects.every((o) => o.key === "withclaim-live/")) await control.deleteObjects(["withclaim-live/"], { quiet: true }).catch(() => undefined);
});

test("two carry backs to one path queue on the claim, and both commit", { skip: !LIVE && "PDA_LIVE=1 runs the live suites", timeout: 300_000 }, async () => {
  const [a, b] = [carry("a", "commit"), carry("b", "commit")];
  assert.deepEqual(await Promise.all([a.exited, b.exited]), [0, 0], `a: ${a.lines.join(" | ")}; b: ${b.lines.join(" | ")}`);
});

test("a holder lost with its host is revoked by the next carry back, which commits", { skip: !LIVE && "PDA_LIVE=1 runs the live suites", timeout: 300_000 }, async () => {
  const lost = carry("lost", "hold");
  const root = await lost.holding;
  lost.child.kill("SIGKILL");
  const pids = daemonsOf(root);
  assert.ok(pids.length > 0, `the lost holder's archil daemon serves ${root}`);
  for (const pid of pids) spawnSync("sudo", ["-n", "kill", "-9", String(pid)]); // the host is gone: its FUSE client too
  const next = carry("next", "commit");
  assert.equal(await next.exited, 0, next.lines.join(" | "));
  assert.equal(await lost.exited, null, "the lost holder never finished");
});

test("readReleased reads back a released database that opens and holds exactly the committed rows", { skip: !LIVE && "PDA_LIVE=1 runs the live suites", timeout: 120_000 }, async () => {
  const read = await readReleased({ control, path: PATH }, "agent.sqlite", { sqlite: true });
  assert.ok(read, "the carry backs released agent.sqlite");
  const dir = mkdtempSync(join(tmpdir(), "pda-released-"));
  try {
    writeFileSync(join(dir, "agent.sqlite"), read.bytes);
    const db = new DatabaseSync(`file:${join(dir, "agent.sqlite")}?immutable=1`, { readOnly: true });
    const rows = (db.prepare("SELECT label FROM carried ORDER BY label").all() as { label: string }[]).map((row) => row.label);
    db.close();
    assert.deepEqual(rows, ["a", "b", "next"], "the lost holder wrote nothing; every committed row is there");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
