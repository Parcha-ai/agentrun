// Live serve, fork and sleep parking on the scratch disk. This process plays the application backend: it holds the API
// key and calls requestRun and ensureRunning with localHost drivers; the instances are systemd transient units running
// `pi-durable-disk run --app test/fixtures/lifecycle-app.ts --serve 0` on pi-ai's faux model. Two mount roots with separate FUSE clients on this box stand in for host A and host B. The
// wake test's supervisor is a separate `supervise --every` process. Everything lives under runs/p8-<stamp>-*/,
// /mnt/pda/p8/ and units named pda-p8-*; every token user, subdirectory, mount, unit and process is recorded in the
// ledger ($PDA_P8_STATE, else P8-STATE.json in the state directory) and removed in `after`, also on failure.
// Measurements go to P8-live-results.json next to the ledger.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord";
import { getDisk, type Disk } from "disk";
import { KEY_ENV, LIVE, REGION, scratchDisk, scratchDiskId } from "./_archil.ts";
import { ledger, LEDGER } from "./_p8-ledger.ts";
import { createRunDir, findDelegations, removeMountToken, unmountClaim, type RunRef } from "../../src/claim.ts";
import { localHost } from "../../src/hosts/local-host.ts";
import { requestRun, type RunResponse } from "../../src/serve.ts";
import { readRunStatus, type EnsureResult, type HostHandle } from "../../src/supervise.ts";

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const APP = fileURLToPath(new URL("../fixtures/lifecycle-app.ts", import.meta.url));
const BASE = "/mnt/pda/p8";
const A = `${BASE}/a`;
const B = `${BASE}/b`;
const F = `${BASE}/f`;
const STAMP = Date.now().toString(36);
const OUT = fileURLToPath(new URL(`../../.tmp/live-p8-${STAMP}`, import.meta.url));
const RESULTS = join(LEDGER, "..", "P8-live-results.json");
const TOKEN_PREFIX = "pda-p8-";
/** Every instance serves behind a bearer token (optional on loopback, exercised here): the file, and what it holds. */
const SERVE_TOKEN_FILE = join(OUT, "serve.token");
const SERVE_TOKEN = `p8-${STAMP}-${Math.random().toString(36).slice(2)}`;
/** The supervisor's lease and the instances' self-fence: short, so a takeover fits in a test. */
const LEASE = { supervisorMs: 6_000, expiryMs: 6_000, marginMs: 1_500 };

let disk: Disk;
let tokenDirExisted = true;
const runIds: string[] = [];
const tokens = new Set<string>();
const handles: HostHandle[] = [];
const loops = new Set<ChildProcess>();
const stopped = new Set<number>();
const results: Record<string, unknown> = { at: new Date().toISOString(), host: "", client: "" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });

async function newRun(name: string): Promise<RunRef> {
  const id = `p8-${STAMP}-${name}`;
  await createRunDir(disk, id, { uid: 1000, gid: 1000 });
  ledger.subdir(`runs/${id}/`, `live ${name}`);
  runIds.push(id);
  return { disk: disk.id, region: REGION, id };
}

/** Record each token user and unit a start made, the moment the result is seen. */
function noteStart(run: string, r: EnsureResult | Record<string, unknown>): void {
  if (r.action !== "started") return;
  const { token, handle } = r as { token: { identifier: string; nickname: string }; handle: HostHandle };
  if (tokens.has(token.identifier)) return;
  tokens.add(token.identifier);
  ledger.token(token.identifier, token.nickname, `live, minted for ${run}`);
  handles.push(handle);
  ledger.unit(`${handle.unit}.service`, `instance of ${run} (${handle.host})`);
  ledger.mount(String(handle.mountpoint), `${scratchDiskId()}:/runs/${run} (made by instance ${handle.unit})`);
}

/** A localHost for host `name` on `mountRoot`, with the lifecycle app, serve on any port, the short lease. */
const driver = (name: "host-a" | "host-b", mountRoot: string, tag: string, extra: { env?: Record<string, string>; runArgs?: string[]; parkThresholdMs?: number | null } = {}) =>
  localHost({
    hostName: name,
    mountRoot,
    unitPrefix: `pda-p8-${tag}-`,
    stopTimeoutMs: 5_000,
    env: { PDA_TEST_OUT: OUT, ...extra.env },
    runArgs: ["--app", APP, "--serve", "0", "--serve-token-file", SERVE_TOKEN_FILE, "--heartbeat-ms", "1000", "--lease-expiry-ms", String(LEASE.expiryMs), "--lease-margin-ms", String(LEASE.marginMs), ...(extra.runArgs ?? [])],
    ...(extra.parkThresholdMs === undefined ? {} : { parkThresholdMs: extra.parkThresholdMs }),
  });
type Driver = ReturnType<typeof driver>;

const ensureOptions = () => ({ control: disk, leaseExpiryMs: LEASE.supervisorMs, tokenPrefix: TOKEN_PREFIX, tokenTtl: "2h" });

/** POST /submit through the client; every start on the way is recorded. */
async function submit(ref: RunRef, host: Driver, body: Record<string, JsonValue>, timeoutMs = 60_000): Promise<RunResponse & { ms: number }> {
  const t0 = Date.now();
  try {
    const r = await requestRun(ref, { method: "POST", path: "/submit", body }, { host, ensure: ensureOptions(), timeoutMs, token: SERVE_TOKEN });
    r.ensured.forEach((e) => noteStart(ref.id, e));
    return { ...r, ms: Date.now() - t0 };
  } catch (err) {
    ((err as { ensured?: EnsureResult[] }).ensured ?? []).forEach((e) => noteStart(ref.id, e));
    throw err;
  }
}

/** The active transcript of a conversation through the instance's event stream (its first event, the snapshot). */
async function transcript(url: string): Promise<{ kind: string; model?: { role: string; content: unknown; toolName?: string; isError?: boolean }[] }[]> {
  const ctl = new AbortController();
  const res = await fetch(new URL("/events", url), { signal: ctl.signal, headers: { authorization: `Bearer ${SERVE_TOKEN}` } });
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
  ctl.abort();
  const data = text.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
  return (JSON.parse(data) as { entries: never[] }).entries;
}
const userTexts = (entries: Awaited<ReturnType<typeof transcript>>) =>
  entries.flatMap((e) => (e.model ?? []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));

const show = (unit: string) =>
  Object.fromEntries(
    sh("systemctl", ["show", `${unit}.service`, "--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,MainPID,NRestarts"])
      .stdout.split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  ) as Record<string, string>;
const journal = (unit: string) => sh("journalctl", ["-u", `${unit}.service`, "--no-pager", "-o", "cat"]).stdout.split("\n");
const journalEvents = (unit: string) => journal(unit).filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown> & { event: string; at: string });
/** The main process's exit status from the unit's journal: systemd logs a clean exit as "Deactivated successfully". */
function journalExit(unit: string): string | null {
  const line = journal(unit).findLast((l) => l.includes("Main process exited") || l.includes("Deactivated successfully"));
  if (!line) return null;
  return line.includes("Deactivated successfully") ? "0" : (/status=(\d+)/.exec(line)?.[1] ?? null);
}
/** The instance a submit started (the client starts exactly one). */
const startedBy = (r: RunResponse): HostHandle => {
  assert.deepEqual(r.ensured.map((e) => e.action), ["started"]);
  return (r.ensured[0] as Extract<EnsureResult, { action: "started" }>).handle;
};
const archilMounts = () =>
  readFileSync("/proc/self/mounts", "utf8").split("\n").map((l) => l.split(" ")).filter((f) => f[2] === "fuse.archil" && f[1]?.startsWith(`${BASE}/`)).map((f) => f[1]);
const s3 = (id: string) => readRunStatus(disk, id);
type AppLine = { ev: string; field?: string; value?: number; generation?: number; pid: number; t: number; serve?: string; unit?: string };
const appLines = (id: string): AppLine[] => {
  const file = join(OUT, `${id}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AppLine) : [];
};
const counter = (id: string, field: string) => appLines(id).filter((l) => l.ev === "count" && l.field === field).at(-1)?.value ?? 0;

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 60_000, everyMs = 200): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** Stop an instance through a driver for its host and close its ledger rows. */
async function stopInstance(h: HostHandle, how = "driver stop"): Promise<void> {
  const host = h.host === "host-b" ? "host-b" : "host-a";
  await driver(host, String(h.mountpoint).replace(/\/runs\/[^/]+$/, ""), "stop").stop(h);
  ledger.unitGone(`${h.unit}.service`, how);
  if (!archilMounts().includes(String(h.mountpoint))) ledger.unmounted(String(h.mountpoint), "released by the instance or the driver");
  const i = handles.indexOf(h);
  if (i >= 0) handles.splice(i, 1);
}

/** S3 sha256 of every object under the run, except the claim probe every mount rewrites. */
async function objectHashes(id: string): Promise<Record<string, string>> {
  const keys = (await disk.listObjects(`runs/${id}/`, { recursive: true })).objects.map((o) => o.key).filter((k) => !k.endsWith("/") && !k.endsWith("/.claim")).sort();
  const out: Record<string, string> = {};
  for (const k of keys) {
    out[k.slice(`runs/${id}/`.length)] = await disk.getObject(k).then(
      (bytes) => createHash("sha256").update(bytes).digest("hex"),
      (e: unknown) => `unreadable over S3: ${(e as Error).message}`,
    );
  }
  return out;
}

const supervisorEnv = () => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, [KEY_ENV]: process.env[KEY_ENV]! });

/** A `supervise --every` process for one run on one host; its decisions fill `lines`. */
function superviseLoop(ref: RunRef, flags: string[], every = "10s") {
  const args = [CLI, "supervise", "--disk", scratchDiskId(), "--region", REGION, "--id", ref.id, "--api-key-env", KEY_ENV, "--token-prefix", TOKEN_PREFIX, "--token-ttl", "2h", "--every", every, ...flags];
  const child = spawn(process.execPath, args, { env: supervisorEnv(), stdio: ["ignore", "pipe", "pipe"] });
  loops.add(child);
  ledger.event("supervise loop started", { pid: child.pid, run: ref.id });
  const lines: (Record<string, unknown> & { seenAt: number })[] = [];
  let buf = "";
  child.stdout!.setEncoding("utf8").on("data", (c: string) => {
    buf += c;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.startsWith("{")) continue;
      const line: Record<string, unknown> & { seenAt: number } = { ...(JSON.parse(l) as Record<string, unknown>), seenAt: Date.now() };
      if (line.run) noteStart(String(line.run), line);
      lines.push(line);
    }
  });
  child.stderr!.setEncoding("utf8").resume();
  return {
    lines,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
      loops.delete(child);
      ledger.event("supervise loop stopped", { pid: child.pid });
    },
  };
}

before(async () => {
  if (!LIVE) return;
  disk = await scratchDisk();
  ledger.disk(disk.id);
  results.host = sh("hostname", []).stdout.trim();
  results.client = sh("/usr/bin/archil", ["--version"]).stdout.split("\n")[0];
  assert.deepEqual(archilMounts(), [], "no P8 mounts left from an earlier run");
  assert.equal(sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "pda-p8-*"]).stdout.trim(), "", "no pda-p8 units left from an earlier run");
  sh("sudo", ["-n", "mkdir", "-p", BASE]);
  sh("sudo", ["-n", "chown", "ubuntu:ubuntu", BASE]);
  for (const d of [A, B, F, OUT]) mkdirSync(d, { recursive: true, mode: 0o755 });
  sh("chmod", ["755", OUT]);
  writeFileSync(SERVE_TOKEN_FILE, `${SERVE_TOKEN}\n`, { mode: 0o600 });
  tokenDirExisted = sh("sudo", ["-n", "test", "-d", "/run/pi-durable-disk"]).status === 0;
  if (!tokenDirExisted) ledger.file("/run/pi-durable-disk", "the token directory localHost creates on demand (root 0700, tmpfs); removed in after if empty");
});

after(async () => {
  if (!LIVE) return;
  const cleanup: Record<string, unknown> = { stoppedResumed: [...stopped], loops: loops.size, units: [], mounts: [], prefixes: [], tokens: [] };
  for (const pid of stopped) sh("sudo", ["-n", "kill", "-CONT", String(pid)]);
  for (const l of loops) (l.kill("SIGTERM"), ledger.event("supervise loop stopped in after", { pid: l.pid }));
  await sleep(500);
  for (const h of [...handles]) {
    const r = await stopInstance(h, "stopped in after").then(() => "stopped", (e: unknown) => `stop failed: ${(e as Error).message}`);
    (cleanup.units as unknown[]).push({ unit: h.unit, r });
  }
  for (const line of sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "pda-p8-*"]).stdout.trim().split("\n").filter(Boolean)) {
    const unit = line.split(/\s+/)[0];
    sh("sudo", ["-n", "systemctl", "stop", unit]);
    sh("sudo", ["-n", "systemctl", "reset-failed", unit]);
    (cleanup.units as unknown[]).push({ unit, r: "stray, stopped" });
    ledger.unitGone(unit, "stray, stopped in after");
  }
  for (const mp of archilMounts()) {
    const via = await unmountClaim(mp).catch((e: unknown) => `failed: ${(e as Error).message}`);
    (cleanup.mounts as unknown[]).push({ mp, via });
    ledger.unmounted(mp, String(via));
  }
  for (const id of runIds) {
    for (const d of await findDelegations(disk, id).catch(() => [])) await disk.revokeDelegation(d).catch(() => {});
    const keys = (await disk.listObjects(`runs/${id}/`, { recursive: true })).objects.map((o) => o.key);
    const dirs = [...new Set([...keys.filter((k) => k.endsWith("/")), `runs/${id}/`])];
    const depth = (k: string) => k.split("/").length;
    let errors = (await disk.deleteObjects(keys.filter((k) => !k.endsWith("/")), { quiet: true })).errors.length;
    for (const d of [...new Set(dirs.map(depth))].sort((x, y) => y - x)) errors += (await disk.deleteObjects(dirs.filter((k) => depth(k) === d), { quiet: true })).errors.length;
    const left = (await disk.listObjects(`runs/${id}/`, { recursive: true })).objects.length;
    (cleanup.prefixes as unknown[]).push({ id, objects: keys.length, errors, left });
    if (left === 0) ledger.subdirDeleted(`runs/${id}/`, keys.length);
    else ledger.event("subdirectory not fully deleted", { id, left, errors });
  }
  for (const identifier of tokens) {
    const r = await removeMountToken(disk, identifier).then(() => "removed", (e: unknown) => `failed: ${(e as Error).message}`);
    (cleanup.tokens as unknown[]).push({ identifier, r });
    if (r === "removed") ledger.tokenRemoved(identifier);
  }
  const fresh = await getDisk(disk.id);
  const strays = (fresh.authorizedUsers ?? []).filter((u) => u.nickname?.startsWith(TOKEN_PREFIX) && u.identifier);
  for (const u of strays) {
    await disk.removeUser("token", u.identifier!).catch(() => {});
    ledger.tokenRemoved(u.identifier!, "sweep by nickname in after");
  }
  cleanup.strayTokens = strays.length;
  sh("bash", ["-c", `sudo -n find ${BASE} -mindepth 1 -depth -type d -empty -delete`]);
  cleanup.mountsAfter = archilMounts();
  cleanup.unitsAfter = sh("systemctl", ["list-units", "--all", "--plain", "--no-legend", "pda-p8-*"]).stdout.trim();
  cleanup.tokenFilesWithContent = sh("sudo", ["-n", "find", "/run/pi-durable-disk", "-name", "pda-p8-*", "-size", "+0"]).stdout.trim();
  sh("sudo", ["-n", "find", "/run/pi-durable-disk", "-name", "pda-p8-*", "-delete"]);
  if (!tokenDirExisted) {
    sh("sudo", ["-n", "rmdir", "/run/pi-durable-disk"]);
    if (sh("sudo", ["-n", "test", "-e", "/run/pi-durable-disk"]).status !== 0) ledger.fileRemoved("/run/pi-durable-disk");
  }
  cleanup.delegationsAfter = (await Promise.all(runIds.map((id) => findDelegations(disk, id)))).flat().length;
  results.cleanup = cleanup;
  writeFileSync(RESULTS, JSON.stringify(results, null, 2) + "\n");
});

// ---- serve ------------------------------------------------------------------------------------------------------------

test("serve: a request to a released run starts it and gets the answer; a repeated requestId is one submission, also across a takeover to host B", { skip: !LIVE, timeout: 180_000 }, async () => {
  const ref = await newRun("serve");
  const hostA = driver("host-a", A, "sv-a");
  const hostB = driver("host-b", B, "sv-b");
  const r: Record<string, unknown> = {};
  results.serve = r;

  // Never started: no run.json, no delegation. The request starts it on A and gets the answer.
  assert.equal(await s3(ref.id), null);
  const first = await submit(ref, hostA, { requestId: "q1", content: "hello", wait: true });
  r.coldStart = { ms: first.ms, ensured: first.ensured.map((e) => e.action === "started" ? { action: e.action, reason: e.reason, startMs: e.startMs } : e) };
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const body = first.body as { generation: number; submission: { id: number; status: string }; answer: { text: string } };
  assert.equal(body.answer.text, "echo: hello");
  assert.equal(body.generation, 1);
  const handleA = startedBy(first);
  const recordA = (await s3(ref.id))!;
  assert.equal(recordA.holder?.serve, first.url, "the instance's address is in run.json's holder");

  const unauthorized = await fetch(new URL("/status", first.url));
  assert.equal(unauthorized.status, 401, "the instance refuses a request without its token");
  r.unauthorizedStatus = unauthorized.status;
  const again = await submit(ref, hostA, { requestId: "q1", content: "hello", wait: true });
  assert.deepEqual([again.ensured.length, (again.body as typeof body).submission.id], [0, body.submission.id], "same submission, straight to the running instance");

  // q2 is admitted on A, and its run blocks in the gate tool. Then A freezes.
  const placed = await submit(ref, hostA, { requestId: "q2", content: "gate" });
  const q2 = (placed.body as typeof body).submission;
  assert.equal(q2.status, "placed");
  await waitFor("the gate tool on A", () => counter(ref.id, "gate") === 1);
  const pid = Number(show(String(handleA.unit)).MainPID);
  assert.ok(pid > 0);
  sh("kill", ["-STOP", String(pid)]);
  stopped.add(pid);
  ledger.event("instance SIGSTOPped", { unit: handleA.unit, pid });
  const frozeAt = Date.now();
  await waitFor("A's lease to expire", async () => {
    const rec = await s3(ref.id);
    return rec?.heartbeatAt && Date.now() - Date.parse(rec.heartbeatAt) > LEASE.supervisorMs;
  }, 30_000, 250);

  // The retry reaches host B through the supervisor: B takes over, and pi in B's store finds q2 by its requestId.
  const retried = await submit(ref, hostB, { requestId: "q2", content: "gate", wait: true }, 90_000);
  const rb = retried.body as typeof body;
  r.takeover = { freezeToAnswerMs: Date.now() - frozeAt, requestMs: retried.ms, ensured: retried.ensured.map((e) => e.action === "started" ? { action: e.action, reason: e.reason, stonith: e.stonith, startMs: e.startMs } : e) };
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(rb.submission.id, q2.id, "the same submission");
  assert.equal(rb.generation, 2);
  assert.equal(rb.answer.text, "finished");
  assert.ok(retried.ensured.some((e) => e.action === "started" && e.reason === "lease-expired"));
  assert.notEqual(retried.url, first.url, "B answered");
  assert.equal(counter(ref.id, "gate"), 1, "the unsafe gate tool ran once, on A; B reported it interrupted");
  const entries = await transcript(retried.url);
  assert.deepEqual(userTexts(entries).filter((t) => t === "gate").length, 1, "one user entry for q2");
  assert.deepEqual(userTexts(entries).filter((t) => t === "hello").length, 1, "one user entry for q1");
  const interrupted = entries.flatMap((e) => e.model ?? []).find((m) => m.role === "toolResult" && m.toolName === "gate_tool");
  assert.equal(interrupted?.isError, true);
  assert.match(JSON.stringify(interrupted?.content), /interrupted/);

  // A thaws: its next heartbeat or commit is refused, it exits 75 and is not restarted.
  sh("kill", ["-CONT", String(pid)]);
  stopped.delete(pid);
  await waitFor("A to exit", () => journalExit(String(handleA.unit)), 30_000);
  r.frozenExit = { status: journalExit(String(handleA.unit)), restarts: show(String(handleA.unit)).NRestarts };
  assert.equal(journalExit(String(handleA.unit)), "75");
  assert.equal(show(String(handleA.unit)).NRestarts, "0");
  for (const h of [...handles].filter((x) => String(x.unit).startsWith("pda-p8-sv-"))) await stopInstance(h);
});

// ---- fork -------------------------------------------------------------------------------------------------------------

test("fork: a released run copied to a new run that opens at generation 1, with the source's store byte for byte", { skip: !LIVE, timeout: 180_000 }, async () => {
  const ref = await newRun("fork-src");
  const hostA = driver("host-a", A, "fk-a");
  const r: Record<string, unknown> = {};
  results.fork = r;
  const first = await submit(ref, hostA, { requestId: "f1", content: "hello from the source", wait: true });
  assert.equal(first.status, 200);
  // Stopped: it drains, writes itself sleeping (idle, woken by a request) and seals.
  for (const h of [...handles].filter((x) => String(x.unit).startsWith("pda-p8-fk-a-"))) await stopInstance(h, "stopped before the fork");
  const source = (await s3(ref.id))!;
  assert.equal(source.status, "sleeping");
  assert.ok(source.sealedSeq !== null);
  const before = await objectHashes(ref.id);
  for (const k of ["store/run.sqlite", "work/notes/opened-g1.txt"]) assert.ok(Object.keys(before).includes(k), Object.keys(before).join(", "));

  const newId = `p8-${STAMP}-fork-new`;
  runIds.push(newId);
  const t0 = Date.now();
  const cli = spawnSync(process.execPath, [CLI, "fork", "--disk", scratchDiskId(), "--region", REGION, "--id", ref.id, "--new-id", newId, "--mount-root", F, "--api-key-env", KEY_ENV, "--token-prefix", TOKEN_PREFIX], { env: supervisorEnv(), encoding: "utf8", timeout: 120_000 });
  const lines = cli.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const l of lines.filter((x) => x.event === "fork-resource")) {
    const { kind, id, detail } = l as { kind: string; id: string; detail?: string };
    if (kind === "token") (tokens.add(id), ledger.token(id, String(detail), "live fork"));
    if (kind === "token-removed") (tokens.delete(id), ledger.tokenRemoved(id));
    if (kind === "subdir") ledger.subdir(id, "live fork target");
    if (kind === "mount") ledger.mount(id, String(detail));
    if (kind === "unmount") ledger.unmounted(id, String(detail));
  }
  const forked = lines.find((l) => l.event === "forked");
  r.cli = { ms: Date.now() - t0, code: cli.status, result: forked ?? null, stderr: cli.stderr.slice(-500) };
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(forked?.sealedSeq, source.sealedSeq);

  const after = await objectHashes(ref.id);
  r.source = { files: Object.keys(before).length, identical: JSON.stringify(after) === JSON.stringify(before) };
  assert.deepEqual(after, before, "the source's store, run.json and workspace are byte for byte the same");
  assert.deepEqual((await findDelegations(disk, ref.id)).length + (await findDelegations(disk, newId)).length, 0);
  const copy = (await s3(newId))!;
  assert.deepEqual([copy.status, copy.generation, copy.sealedSeq], ["paused", 0, source.sealedSeq]);
  const copied = await objectHashes(newId);
  r.copied = Object.keys(copied);
  for (const k of ["store/run.sqlite", "work/notes/opened-g1.txt"]) assert.equal(copied[k], before[k], `${k} came along byte for byte`);
  assert.equal(copied["owner.lock"], undefined, "the lifecycle files are the fork's own");

  // The fork opens on request at generation 1, with the source's transcript.
  const forkRef = { ...ref, id: newId };
  const answer = await submit(forkRef, hostA, { requestId: "f2", content: "hello from the fork", wait: true });
  const fb = answer.body as { generation: number; answer: { text: string } };
  r.forkOpen = { ms: answer.ms, generation: fb.generation };
  assert.equal(fb.generation, 1);
  assert.equal(fb.answer.text, "echo: hello from the fork");
  const texts = userTexts(await transcript(answer.url));
  assert.deepEqual(texts, ["hello from the source", "hello from the fork"]);
  for (const h of [...handles].filter((x) => String(x.unit).startsWith("pda-p8-fk-a-"))) await stopInstance(h);
  assert.deepEqual(await objectHashes(ref.id), before, "running the fork leaves the source alone");
});

// ---- drain ------------------------------------------------------------------------------------------------------------

test("drain: a run stopped at the drain deadline resumes on host B, safe tools rerun and unsafe tools interrupted", { skip: !LIVE, timeout: 180_000 }, async () => {
  const ref = await newRun("drain");
  const hostA = driver("host-a", A, "dr-a");
  const hostB = driver("host-b", B, "dr-b");
  const r: Record<string, unknown> = {};
  results.drain = r;
  const placed = await submit(ref, hostA, { requestId: "d1", content: "use both tools" });
  const id = (placed.body as { submission: { id: number } }).submission.id;
  await waitFor("both tools running on A", () => counter(ref.id, "safe") === 1 && counter(ref.id, "unsafe") === 1);
  const handleA = startedBy(placed);
  const t0 = Date.now();
  await stopInstance(handleA, "stopped mid-tools (drain)");
  const stopMs = Date.now() - t0;
  const ev = journalEvents(String(handleA.unit));
  const draining = ev.find((e) => e.event === "draining");
  const released = ev.find((e) => e.event === "released");
  r.stop = { stopMs, drainMs: draining?.drainMs, drainedFor: released && draining ? Date.parse(released.at) - Date.parse(draining.at) : null, drained: released?.drained };
  assert.equal(released?.drained, "busy", "the deadline passed with both tools still running");
  assert.ok(Date.parse(released!.at) - Date.parse(draining!.at) >= 2_400, "it waited for the drain deadline (2.5 s)");
  const rec = (await s3(ref.id))!;
  assert.equal(rec.status, "sleeping");
  assert.ok(rec.wakeAt !== null && Date.parse(rec.wakeAt) <= Date.now(), "woken at once by the next supervisor pass");
  assert.equal(journalExit(String(handleA.unit)), "0");

  const resumed = await submit(ref, hostB, { requestId: "d1", content: "use both tools", wait: true }, 90_000);
  const rb = resumed.body as { generation: number; submission: { id: number; status: string }; answer: { text: string } };
  r.resume = { ms: resumed.ms, generation: rb.generation, safe: counter(ref.id, "safe"), unsafe: counter(ref.id, "unsafe") };
  assert.equal(rb.submission.id, id);
  assert.equal(rb.answer.text, "finished");
  assert.equal(rb.generation, 2);
  assert.deepEqual([counter(ref.id, "safe"), counter(ref.id, "unsafe")], [2, 1], "the safe tool reran, the unsafe one did not");
  const results_ = (await transcript(resumed.url)).flatMap((e) => e.model ?? []).filter((m) => m.role === "toolResult");
  assert.equal(results_.find((m) => m.toolName === "safe_tool")?.isError, false);
  const unsafe = results_.find((m) => m.toolName === "unsafe_tool");
  assert.equal(unsafe?.isError, true);
  assert.match(JSON.stringify(unsafe?.content), /interrupted/);
  for (const h of [...handles].filter((x) => String(x.unit).startsWith("pda-p8-dr-"))) await stopInstance(h);
});

// ---- parking ----------------------------------------------------------------------------------------------------------

test("parking: a wait whose wake cannot be recorded keeps the instance up, and pi's own timer finishes the run there", { skip: !LIVE, timeout: 180_000 }, async () => {
  const ref = await newRun("nowake");
  const hostA = driver("host-a", A, "nw-a", { env: { PDA_TEST_WAKE: "refuse", PDA_TEST_RETRY_MS: "20000" }, parkThresholdMs: 5_000 });
  const r: Record<string, unknown> = {};
  results.noWake = r;
  const placed = await submit(ref, hostA, { requestId: "n1", content: "flaky" });
  const id = (placed.body as { submission: { id: number } }).submission.id;
  const handle = startedBy(placed);
  await waitFor("the failed request", () => counter(ref.id, "requests") === 1);
  const erroredAt = Date.now();
  await waitFor("the refused wake in the journal", () => journalEvents(String(handle.unit)).some((e) => e.event === "wake not recorded; staying up through the wait"), 20_000);
  await sleep(5_000);
  const mid = (await s3(ref.id))!;
  r.midWait = { status: mid.status, heartbeatAgeMs: Date.now() - Date.parse(mid.heartbeatAt!), unit: show(String(handle.unit)).ActiveState };
  assert.equal(mid.status, "running", "never written sleeping");
  assert.ok(Date.now() - Date.parse(mid.heartbeatAt!) < 3_000, "the instance kept its lease");
  assert.equal(show(String(handle.unit)).ActiveState, "active");
  const answered = await submit(ref, hostA, { requestId: "n1", content: "flaky", wait: true }, 60_000);
  const ab = answered.body as { generation: number; submission: { id: number }; answer: { text: string } };
  r.answer = { afterErrorMs: Date.now() - erroredAt, generation: ab.generation, requests: counter(ref.id, "requests"), ensured: answered.ensured.length };
  assert.deepEqual([ab.submission.id, ab.answer.text, ab.generation, answered.ensured.length], [id, "recovered", 1, 0], "the same instance answered");
  assert.equal(counter(ref.id, "requests"), 2);
  assert.equal(appLines(ref.id).filter((l) => l.ev === "opened").length, 1, "one incarnation");
  assert.equal(journalEvents(String(handle.unit)).some((e) => e.event === "parked"), false);
  for (const h of [...handles].filter((x) => String(x.unit).startsWith("pda-p8-nw-"))) await stopInstance(h);
});

test("parking: a run with a 5 minute retry wait releases its host and resumes at the deadline on host B", { skip: !LIVE, timeout: 600_000 }, async () => {
  const ref = await newRun("wait");
  const hostA = driver("host-a", A, "wk-a", { env: { PDA_TEST_RETRY_MS: "300000" } });
  const r: Record<string, unknown> = {};
  results.wait = r;
  const placed = await submit(ref, hostA, { requestId: "w1", content: "flaky" });
  const id = (placed.body as { submission: { id: number } }).submission.id;
  const handleA = startedBy(placed);
  await waitFor("the failed request", () => counter(ref.id, "requests") === 1);
  const erroredAt = appLines(ref.id).find((l) => l.ev === "count" && l.field === "requests")!.t;
  const exitA = await waitFor("A to park and exit", () => journalExit(String(handleA.unit)), 30_000);
  const parked = journalEvents(String(handleA.unit)).find((e) => e.event === "parked");
  const rec = (await s3(ref.id))!;
  const wakeAt = Date.parse(rec.wakeAt!);
  r.park = { exit: exitA, errorToParkedMs: parked ? Date.parse(parked.at) - erroredAt : null, wakeAt: rec.wakeAt, waitMs: wakeAt - erroredAt, status: rec.status, sealedSeq: rec.sealedSeq, restarts: show(String(handleA.unit)).NRestarts };
  assert.equal(exitA, "0");
  assert.equal(rec.status, "sleeping");
  assert.ok(wakeAt - erroredAt >= 299_000 && wakeAt - erroredAt <= 301_000, `wakeAt is the retry deadline (${wakeAt - erroredAt} ms after the error)`);
  assert.ok(rec.sealedSeq !== null);
  assert.equal((await findDelegations(disk, ref.id)).length, 0, "the host is released");
  assert.equal(archilMounts().includes(String(handleA.mountpoint)), false);
  ledger.unitGone(`${handleA.unit}.service`, "parked and exited 0");
  ledger.unmounted(String(handleA.mountpoint), "released by the parking instance");
  handles.splice(handles.indexOf(handleA), 1);

  // A supervisor on host B ticks every 10 s; it leaves the run sleeping until wakeAt, then starts it there.
  const loop = superviseLoop(ref, ["--mount-root", B, "--host-name", "host-b", "--unit-prefix", "pda-p8-wk-b-", "--lease-expiry", "6s", "--stop-timeout", "5s",
    "--env", `PDA_TEST_OUT=${OUT}`, "--env", "PDA_TEST_RETRY_MS=300000", `--run-arg=--app=${APP}`, "--run-arg=--serve=0", "--run-arg=--heartbeat-ms=1000",
    `--run-arg=--lease-expiry-ms=${LEASE.expiryMs}`, `--run-arg=--lease-margin-ms=${LEASE.marginMs}`]);
  try {
    const started = await waitFor("B's start", () => loop.lines.find((l) => l.action === "started"), 360_000, 1_000);
    const sleepingTicks = loop.lines.filter((l) => l.action === "sleeping" && l.seenAt < started.seenAt).length;
    await waitFor("the retried request on B", () => counter(ref.id, "requests") === 2, 60_000);
    const retriedAt = appLines(ref.id).filter((l) => l.ev === "count" && l.field === "requests").at(-1)!.t;
    const opened = appLines(ref.id).find((l) => l.ev === "opened" && l.generation === 2)!;
    const hostB = driver("host-b", B, "wk-b");
    const done = await submit(ref, hostB, { requestId: "w1", content: "flaky", wait: true }, 60_000);
    const db = done.body as { generation: number; submission: { id: number }; answer: { text: string } };
    r.wake = {
      sleepingTicks,
      startedAfterWakeMs: started.seenAt - wakeAt,
      openedAfterWakeMs: opened.t - wakeAt,
      retriedAfterWakeMs: retriedAt - wakeAt,
      woke: started.woke,
      generation: db.generation,
      requests: counter(ref.id, "requests"),
    };
    assert.ok(sleepingTicks >= 20, `the supervisor left it sleeping until the deadline (${sleepingTicks} ticks)`);
    assert.equal(started.woke, true);
    assert.ok(started.seenAt >= wakeAt, "not started before its wake");
    assert.ok(retriedAt >= wakeAt, "pi's timer held the retry until the deadline");
    assert.deepEqual([db.submission.id, db.answer.text, db.generation], [id, "recovered", 2]);
    assert.equal(counter(ref.id, "requests"), 2);
  } finally {
    await loop.stop();
  }
  for (const h of [...handles].filter((x) => String(x.unit).startsWith("pda-p8-wk-"))) await stopInstance(h);
});
