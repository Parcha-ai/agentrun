// The Daytona probe, one phase per invocation, with both keys in the environment:
//   PDA_LIVE=1 DAYTONA_API_KEY=... ARCHIL_API_KEY=... PDA_LIVE_DISK=dsk-... node test/live/daytona-probe.ts <phase>
// Phases: egress (create the probe box, capability and egress facts, the org's egress tier), prepare (runtime install),
// claim, deadmount, poweroff, janitor (delete every box of this lane and confirm it gone), spend. Results merge into
// P9-PROBE.json in $PDA_STATE_DIR; every resource goes into P9-STATE.json first. Nothing prints a key or a token.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRunDir, findDelegations, mintMountToken, removeMountToken, revokeBestEffort, type ControlApi } from "../../src/claim.ts";
import { LABEL_FLEET, LABEL_RUN, type DaytonaClient, type SandboxInfo } from "../../src/hosts/daytona.ts";
import { scratchDisk, scratchDiskId } from "./_archil.ts";
import { ARCHIL_WRAPPER, confirmGone, deletePrefix, FLEET, guardedClient, ledger, LIVE_DAYTONA, MOUNT_ROOT, NAME_PREFIX, NODE, PACKAGE_DIR, PDA_ID, prepareBox, record, sh, stageToken } from "./_p9.ts";

const PROBE_STATE = new URL("../../.tmp/p9-probe.json", import.meta.url);
const SNAPSHOT = "daytona-medium";
const TARGET = process.env.DAYTONA_TARGET || "us";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function probeBox(): { id: string; name: string } {
  if (!existsSync(PROBE_STATE)) throw new Error("no probe box: run the egress phase first");
  return JSON.parse(readFileSync(PROBE_STATE, "utf8"));
}

async function current(client: DaytonaClient): Promise<SandboxInfo> {
  const { id } = probeBox();
  const box = await client.get(id);
  if (!box || box.state !== "started") throw new Error(`probe box ${id} is ${box?.state ?? "gone"}`);
  return box;
}

/** Tab-separated `key<TAB>value` lines from a command's output. */
function facts(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("\t");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

const FACTS = String.raw`
set +e
o() { printf '%s\t%s\n' "$1" "$2"; }
o id "$(id)"
o kernel "$(uname -r)"
o os "$(. /etc/os-release; echo "$PRETTY_NAME")"
o node "$(node --version 2>&1)"
o sudo "$(sudo -n true 2>&1 && echo ok)"
o pid1 "$(cat /proc/1/comm)"
o capeff_user "$(awk '/^CapEff/{print $2}' /proc/self/status)"
o capeff_root "$(sudo -n awk '/^CapEff/{print $2}' /proc/self/status)"
o capbnd_root "$(sudo -n awk '/^CapBnd/{print $2}' /proc/self/status)"
o seccomp "$(awk '/^Seccomp:/{print $2}' /proc/self/status)"
o nonewprivs "$(awk '/^NoNewPrivs/{print $2}' /proc/self/status)"
o devfuse "$(ls -l /dev/fuse 2>&1)"
o uid_map "$(tr -s ' ' < /proc/self/uid_map | tr '\n' ';')"
o mounts_special "$(awk '$3 ~ /sysbox|fuse|cgroup/ || $1 ~ /sysbox/ {print $1":"$2":"$3}' /proc/mounts | tr '\n' ' ')"
o cgroup_self "$(tr '\n' ' ' < /proc/self/cgroup)"
o cgroup_fs "$(stat -fc %T /sys/fs/cgroup)"
o cgroup_controllers "$(cat /sys/fs/cgroup/cgroup.controllers 2>&1)"
o cgroup_subtree "$(cat /sys/fs/cgroup/cgroup.subtree_control 2>&1)"
o cgroup_limits "cpu.max=$(cat /sys/fs/cgroup/cpu.max 2>&1) memory.max=$(cat /sys/fs/cgroup/memory.max 2>&1)"
d=/sys/fs/cgroup/pda-p9-probe
if sudo -n mkdir "$d" 2>/tmp/cg.err; then
  k=no; [ -e "$d/cgroup.kill" ] && k=yes
  sudo -n rmdir "$d"
  o cgroup_mkdir "ok cgroup.kill=$k"
else
  o cgroup_mkdir "refused: $(cat /tmp/cg.err)"
fi
o apparmor "$(cat /proc/self/attr/current 2>&1)"
o fusermount "$(command -v fusermount fusermount3 | tr '\n' ' ')"
o egress_ip "$(curl -fsS -m 10 https://checkip.amazonaws.com 2>&1)"
python3 - <<'PY'
import socket, time
targets = [
  ("mount.green.us-east-1.aws.prod.archil.com", 8100),
  ("control.green.us-east-1.aws.prod.archil.com", 443),
  ("35.172.185.165", 32050),
  ("mount.green.us-west-2.aws.prod.archil.com", 8100),
  ("nodejs.org", 443),
  ("s3.amazonaws.com", 443),
]
for host, port in targets:
  ms, err = [], ""
  for _ in range(5):
    t = time.perf_counter()
    try:
      s = socket.create_connection((host, port), timeout=5)
      s.close()
      ms.append((time.perf_counter() - t) * 1000)
    except Exception as e:
      err = type(e).__name__ + ": " + str(e)[:80]
  print("tcp %s:%d\t%s|%s" % (host, port, ",".join("%.2f" % x for x in ms), err))
PY
`;

/** The org's egress flag and per-sandbox maxima, read through the probe box (only these fields are kept). */
async function orgFacts(id: string): Promise<Record<string, unknown>> {
  const base = (process.env.DAYTONA_API_URL || "https://app.daytona.io/api").replace(/\/+$/, "");
  const res = await fetch(`${base}/sandbox/${encodeURIComponent(id)}/organization`, { headers: { Authorization: `Bearer ${process.env.DAYTONA_API_KEY}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) return { status: res.status };
  const org = (await res.json()) as Record<string, unknown>;
  const keep = ["sandboxLimitedNetworkEgress", "maxCpuPerSandbox", "maxMemoryPerSandbox", "maxDiskPerSandbox", "suspended", "personal"];
  return { status: res.status, ...Object.fromEntries(keep.map((k) => [k, org[k]])) };
}

async function egress(client: DaytonaClient): Promise<void> {
  if (existsSync(PROBE_STATE)) throw new Error(`a probe box is already recorded (${PROBE_STATE.pathname}); run janitor first`);
  const stamp = Date.now().toString(36);
  const name = `${NAME_PREFIX}probe-${stamp}`;
  const labels = { [LABEL_FLEET]: FLEET, [LABEL_RUN]: "probe", "pda-p9": `probe-${stamp}` };
  const t0 = performance.now();
  const created = await client.create({ name, snapshot: SNAPSHOT, target: TARGET, labels, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: 90 });
  const createMs = Math.round(performance.now() - t0);
  writeFileSync(PROBE_STATE, JSON.stringify({ id: created.id, name }));
  let box: SandboxInfo | null = created;
  while (box?.state !== "started") {
    if (!box || ["error", "build_failed", "destroyed", "destroying"].includes(String(box.state))) throw new Error(`probe box went to ${box?.state ?? "deleted"}: ${box?.errorReason ?? ""}`);
    if (performance.now() - t0 > 180_000) throw new Error(`probe box not started after 180 s (${box.state})`);
    await sleep(500);
    box = await client.get(created.id);
  }
  const startedMs = Math.round(performance.now() - t0);
  const r = await client.exec(box, FACTS, 240);
  const firstExecMs = Math.round(performance.now() - t0);
  const f = facts(r.result);
  const tcp = Object.fromEntries(
    Object.entries(f)
      .filter(([k]) => k.startsWith("tcp "))
      .map(([k, v]) => {
        const [ms, err] = v.split("|");
        const list = ms ? ms.split(",").map(Number) : [];
        return [k.slice(4), { ok: list.length, of: 5, ms: list, ...(err ? { error: err } : {}) }];
      }),
  );
  const org = await orgFacts(created.id).catch((e: unknown) => ({ error: (e as Error).message }));
  const facts_ = Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith("tcp ")));
  record("egress", { box: { id: created.id, name, snapshot: box.snapshot ?? SNAPSHOT, target: box.target, labels }, timingsMs: { create: createMs, started: startedMs, firstExec: firstExecMs }, execExit: r.exitCode, facts: facts_, tcp, org });
  ledger.event("egress", { id: created.id });
  const dataPort = tcp["35.172.185.165:32050"] as { ok: number } | undefined;
  const mountPort = tcp["mount.green.us-east-1.aws.prod.archil.com:8100"] as { ok: number } | undefined;
  process.stdout.write(`${JSON.stringify({ created: created.id, timingsMs: { create: createMs, started: startedMs, firstExec: firstExecMs }, mount8100: mountPort?.ok, data32050: dataPort?.ok, org, egressIp: f.egress_ip }, null, 1)}\n`);
}


// ---- prepare, claim, dead mounts, power-off ---------------------------------------------------------------------------

async function prepare(client: DaytonaClient): Promise<void> {
  const box = await current(client);
  const r = await prepareBox(client, box);
  record("prepare", r);
  process.stdout.write(`${JSON.stringify(r, null, 1)}\n`);
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100;
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1), min: q(0) };
};

const LATENCY = String.raw`
import { DatabaseSync } from "node:sqlite";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
const dir = process.argv[2], n = 200, raw = [], full = [];
const fd = openSync(dir + "/fsync.bin", "w");
for (let i = 0; i < n; i++) { const t = performance.now(); writeSync(fd, Buffer.alloc(512, i % 256)); fsyncSync(fd); raw.push(performance.now() - t); }
closeSync(fd);
const db = new DatabaseSync(dir + "/commit.db");
db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA mmap_size=0; CREATE TABLE t(i INTEGER, v BLOB)");
const ins = db.prepare("INSERT INTO t VALUES (?, ?)");
for (let i = 0; i < n; i++) { const t = performance.now(); db.exec("BEGIN"); ins.run(i, Buffer.alloc(256)); db.exec("COMMIT"); full.push(performance.now() - t); }
db.close();
console.log(JSON.stringify({ raw, full }));
`;

/** Root's shell in the box, the script on a here-document (no quoting through sudo). */
const asRoot = (script: string) => `sudo -n bash <<'PDA_ROOT'\nset -u\n${script}\nPDA_ROOT`;

/** archil mount through the wrapper as root, token from its root-only file (deleted after). Output is never kept raw. */
function mountScript(diskId: string, id: string, mp: string, tokenFile: string): string {
  return asRoot(`mkdir -p ${mp} && chown pda:pda ${mp}
t=$(date +%s%N)
out=$(${ARCHIL_WRAPPER} mount ${diskId}:/runs/${id} ${mp} --region aws-us-east-1 < ${tokenFile} 2>&1); rc=$?
rm -f ${tokenFile}
printf 'rc\\t%s\\nms\\t%s\\n' "$rc" $(( ($(date +%s%N) - t) / 1000000 ))
printf 'mounted\\t%s\\n' "$(awk -v m=${mp} '$2==m{print $3}' /proc/mounts)"
printf 'held\\t%s\\n' "$(printf '%s' "$out" | grep -c 'outstanding delegation')"
printf 'tail\\t%s\\n' "$(printf '%s' "$out" | tail -2 | tr '\\n\\t' '  ' | cut -c1-240)"`);
}

const mounted = async (client: DaytonaClient, box: SandboxInfo, mp: string) =>
  (await sh(client, box, `awk -v m=${mp} '$2==m{print $3}' /proc/mounts`)).trim();

/** The cleanup ladder for a mount whose client is revoked or dead; every step is tried only while the mount is listed. */
async function cleanLadder(client: DaytonaClient, box: SandboxInfo, mp: string): Promise<{ step: string; ok: boolean; ms: number; out: string }[]> {
  const steps: [string, string][] = [
    ["archil unmount", `timeout 20 archil unmount ${mp}`],
    ["fusermount -u", `fusermount -u ${mp}`],
    ["umount -l", `umount -l ${mp}`],
    ["mount --move", `mkdir -p /tmp/.fuse-defunct-$$ && mount --move ${mp} /tmp/.fuse-defunct-$$`],
  ];
  const out: { step: string; ok: boolean; ms: number; out: string }[] = [];
  for (const [step, cmd] of steps) {
    if (!(await mounted(client, box, mp))) break;
    const t0 = performance.now();
    const r = await client.exec(box, asRoot(`${cmd} 2>&1 | tail -2 | tr '\\n' ' ' | cut -c1-200`), 60);
    const ms = Math.round(performance.now() - t0);
    out.push({ step, ok: !(await mounted(client, box, mp)), ms, out: r.result.trim() });
  }
  return out;
}

async function claim(client: DaytonaClient): Promise<void> {
  const box = await current(client);
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  const diskId = scratchDiskId();
  const stamp = Date.now().toString(36);
  const id = `p9-probe-${stamp}`;
  const mp = `${MOUNT_ROOT}/runs/${id}`;
  const ids = facts(await sh(client, box, `printf 'uid\\t%s\\ngid\\t%s\\n' "$(id -u pda)" "$(id -g pda)"`));
  const tokens: string[] = [];
  const res: Record<string, unknown> = { run: id, mountpoint: mp };
  const mint = async (tag: string) => {
    const t = await mintMountToken(control, { nickname: `pda-p9-${tag}-${stamp}`, ttl: "1h" });
    ledger.token(t.identifier, t.nickname, `probe ${tag}`);
    tokens.push(t.identifier);
    return t;
  };
  const delegations = async () => (await findDelegations(control, id)).map((d) => ({ clientId: d.clientId, isOrphaned: d.isOrphaned, isPending: d.isPending }));
  const scrub = (v: unknown, secrets: string[]) => JSON.parse(secrets.reduce((acc, sec) => acc.split(sec).join("<token>"), JSON.stringify(v)));
  const secrets: string[] = [];
  try {
    await createRunDir(control, id, { uid: Number(ids.uid), gid: Number(ids.gid) });
    ledger.subdir(`runs/${id}/`, "probe claim");

    // A: the first exclusive mount, as the claim makes it.
    const a = await mint("a");
    secrets.push(a.token);
    res.mountA = facts(await sh(client, box, mountScript(diskId, id, mp, await stageToken(client, box, "probe-a", a.token)), 180));
    res.delegationsAfterA = await delegations();

    // B: a second exclusive mount of the held directory must be refused.
    const b = await mint("b");
    secrets.push(b.token);
    const mpB = `${MOUNT_ROOT}/.check-b/runs/${id}`;
    res.mountB = facts(await sh(client, box, mountScript(diskId, id, mpB, await stageToken(client, box, "probe-b", b.token)), 180));
    if (await mounted(client, box, mpB)) res.mountBCleanup = await cleanLadder(client, box, mpB);

    // Commit latency on A from this region (the exclusive profile's pragmas).
    await client.upload(box, "/tmp/pda-lat.mjs", new TextEncoder().encode(LATENCY));
    const lat = JSON.parse((await sh(client, box, asRoot(`${NODE} /tmp/pda-lat.mjs ${mp}`), 300)).trim().split("\n").at(-1)!) as { raw: number[]; full: number[] };
    res.latencyMs = { fsync512B: stats(lat.raw), sqliteFullCommit: stats(lat.full) };

    // Revoke A from here; its next fsync and its barrier must fail.
    const held = await findDelegations(control, id);
    const t0 = performance.now();
    for (const d of held) await control.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId });
    res.revokeMs = Math.round(performance.now() - t0);
    res.afterRevoke = facts(await sh(client, box, asRoot(`
${NODE} -e 'const fs=require("fs");try{const fd=fs.openSync(process.argv[1]+"/after-revoke","w");fs.writeSync(fd,"x");fs.fsyncSync(fd);console.log("fsync\\tsucceeded")}catch(e){console.log("fsync\\t"+e.code)}' ${mp}
out=$(timeout 30 archil sync ${mp} 2>&1); printf 'sync_rc\\t%s\\nsync\\t%s\\n' "$?" "$(printf '%s' "$out" | tail -1 | cut -c1-200)"`), 90));
    res.revokedCleanup = await cleanLadder(client, box, mp);

    // C: a new mount at the same path takes over; then its daemon is SIGKILLed (a dead client) and the mount cleaned.
    const c = await mint("c");
    secrets.push(c.token);
    res.mountC = facts(await sh(client, box, mountScript(diskId, id, mp, await stageToken(client, box, "probe-c", c.token)), 180));
    res.daemonC = facts(await sh(client, box, asRoot(`pids=$(pgrep -f "archil mount .*${mp}" | tr '\\n' ' '); printf 'pids\\t%s\\n' "$pids"; kill -9 $pids; sleep 1; printf 'stat\\t%s\\n' "$(timeout 5 stat -c %F ${mp} 2>&1 | tail -1)"`)));
    const tDead = performance.now();
    let orphanMs: number | null = null;
    for (; performance.now() - tDead < 30_000; await sleep(200)) {
      const ds = await findDelegations(control, id);
      if (ds.length && ds.every((d) => d.isOrphaned)) {
        orphanMs = Math.round(performance.now() - tDead);
        break;
      }
    }
    res.deadDaemonOrphanedMs = orphanMs;
    res.deadCleanup = await cleanLadder(client, box, mp);
    for (const d of await findDelegations(control, id)) await control.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId });

    // D: the same path once more after the dead mount was cleaned, then a polite unmount.
    const dTok = await mint("d");
    secrets.push(dTok.token);
    res.mountD = facts(await sh(client, box, mountScript(diskId, id, mp, await stageToken(client, box, "probe-d", dTok.token)), 180));
    res.unmountD = await cleanLadder(client, box, mp);
    res.delegationsAtEnd = await delegations();
  } finally {
    await revokeBestEffort(control, id).catch(() => []);
    for (const t of tokens) await removeMountToken(control, t).then(() => ledger.tokenRemoved(t), () => {});
    const del = await deletePrefix(disk as never, `runs/${id}/`).catch((e: unknown) => ({ error: (e as Error).message }));
    ledger.subdirDeleted(`runs/${id}/`, JSON.stringify(del));
    res.cleanup = { prefix: del };
    record("claim", scrub(res, secrets));
    process.stdout.write(`${JSON.stringify(scrub(res, secrets), null, 1)}\n`);
  }
}


/** Which release paths work in a Sysbox box: checkin, unmount, move, kill; and whether a revoked client holds on. */
async function remount(client: DaytonaClient): Promise<void> {
  const box = await current(client);
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  const diskId = scratchDiskId();
  const stamp = Date.now().toString(36);
  const id = `p9-remount-${stamp}`;
  const mp = `${MOUNT_ROOT}/runs/${id}`;
  const ids = facts(await sh(client, box, `printf 'uid\\t%s\\ngid\\t%s\\n' "$(id -u pda)" "$(id -g pda)"`));
  const tokens: string[] = [];
  const secrets: string[] = [];
  const log: Record<string, unknown>[] = [];
  const t0 = performance.now();
  const note = async (step: string, extra: Record<string, unknown> = {}) => {
    const ds = (await findDelegations(control, id)).map((d) => `${d.clientId}:${d.isOrphaned ? "orphaned" : d.isPending ? "pending" : "held"}`);
    const m = await mounted(client, box, mp);
    log.push({ t: Math.round(performance.now() - t0), step, delegations: ds, mounted: m || null, ...extra });
  };
  const mountTagged = async (tag: string) => {
    const t = await mintMountToken(control, { nickname: `pda-p9-${tag}-${stamp}`, ttl: "1h" });
    ledger.token(t.identifier, t.nickname, `remount ${tag}`);
    tokens.push(t.identifier);
    secrets.push(t.token);
    const r = facts(await sh(client, box, mountScript(diskId, id, mp, await stageToken(client, box, `remount-${tag}`, t.token)), 180));
    const pid = (await sh(client, box, `pgrep -n -f 'archil mount' || true`)).trim();
    await note(`mount ${tag}`, { rc: r.rc, ms: r.ms, held: r.held, daemon: pid });
    return pid;
  };
  const root = async (step: string, cmd: string) => {
    const r = await client.exec(box, asRoot(`out=$(${cmd} 2>&1); rc=$?; printf '%s\\t%s\\n' "$rc" "$(printf '%s' "$out" | tail -1 | cut -c1-200)"`), 60);
    const [rc, out] = r.result.trim().split("\t");
    await note(step, { rc, out });
  };
  const kill = async (step: string, pid: string) => {
    await sh(client, box, asRoot(`kill -9 ${pid} 2>/dev/null; true`));
    const t = performance.now();
    let orphanMs: number | null = null;
    for (; performance.now() - t < 15_000; await sleep(200)) {
      const ds = await findDelegations(control, id);
      if (ds.length && ds.every((d) => d.isOrphaned)) {
        orphanMs = Math.round(performance.now() - t);
        break;
      }
      if (!ds.length) break;
    }
    await note(step, { orphanMs });
  };
  try {
    await createRunDir(control, id, { uid: Number(ids.uid), gid: Number(ids.gid) });
    ledger.subdir(`runs/${id}/`, "probe remount");
    // A polite release: checkin, then unmount, then move aside, then kill the daemon; then a new mount at the same path.
    const e = await mountTagged("e");
    await root("archil checkin", `timeout 30 archil checkin ${mp}`);
    await root("archil unmount", `timeout 30 archil unmount ${mp}`);
    await root("mount --move", `mkdir -p /tmp/.fuse-defunct-e && mount --move ${mp} /tmp/.fuse-defunct-e`);
    await kill("kill daemon e", e);
    const f = await mountTagged("f");
    // A revoke with nobody else waiting: does the revoked client hold on, or take the delegation back?
    for (const d of await findDelegations(control, id)) await control.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId });
    await note("revoked f");
    await sleep(1_000);
    await note("revoked f +1 s");
    await sleep(4_000);
    await note("revoked f +5 s");
    await root("write+fsync on revoked f", `${NODE} -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1]+"/x","w");fs.writeSync(fd,"x");fs.fsyncSync(fd)' ${mp}`);
    await note("after the failed write");
    await root("mount --move f", `mkdir -p /tmp/.fuse-defunct-f && mount --move ${mp} /tmp/.fuse-defunct-f`);
    const g = await mountTagged("g");
    await kill("kill daemon f", f);
    for (const d of (await findDelegations(control, id)).filter((d) => d.isOrphaned)) await control.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId });
    await note("revoked orphaned");
    if (!(await mounted(client, box, mp))) await mountTagged("g2");
    await kill("kill daemon g", g);
  } finally {
    await sh(client, box, asRoot(`pkill -9 -f 'archil mount .*${id}' ; true`)).catch(() => {});
    await revokeBestEffort(control, id).catch(() => []);
    for (const t of tokens) await removeMountToken(control, t).then(() => ledger.tokenRemoved(t), () => {});
    const del = await deletePrefix(disk as never, `runs/${id}/`).catch((err: unknown) => ({ error: (err as Error).message }));
    ledger.subdirDeleted(`runs/${id}/`, JSON.stringify(del));
    const out = JSON.parse(secrets.reduce((acc, sec) => acc.split(sec).join("<token>"), JSON.stringify({ run: id, log, cleanup: del })));
    record("remount", out);
    process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
  }
}


/** A dead client in a Sysbox box: the archil process tree of one mount, all of it SIGKILLed, then how long until orphaned. */
async function orphan(client: DaytonaClient): Promise<void> {
  const box = await current(client);
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  const diskId = scratchDiskId();
  const stamp = Date.now().toString(36);
  const id = `p9-orphan-${stamp}`;
  const mp = `${MOUNT_ROOT}/runs/${id}`;
  const ids = facts(await sh(client, box, `printf 'uid\\t%s\\ngid\\t%s\\n' "$(id -u pda)" "$(id -g pda)"`));
  let token: { token: string; identifier: string; nickname: string } | null = null;
  const res: Record<string, unknown> = { run: id };
  try {
    await createRunDir(control, id, { uid: Number(ids.uid), gid: Number(ids.gid) });
    ledger.subdir(`runs/${id}/`, "probe orphan");
    token = await mintMountToken(control, { nickname: `pda-p9-orphan-${stamp}`, ttl: "1h" });
    ledger.token(token.identifier, token.nickname, "orphan");
    res.mount = facts(await sh(client, box, mountScript(diskId, id, mp, await stageToken(client, box, "orphan", token.token)), 180));
    res.tree = (await sh(client, box, `ps -eo pid,ppid,pgid,user,args | grep -E 'archil' | grep -v grep | cut -c1-200`)).trim().split("\n");
    res.sockets = (await sh(client, box, asRoot(`ss -tnp 2>/dev/null | grep -i archil | awk '{print $1, $5}' | sort | uniq -c | head`))).trim().split("\n");
    res.kill = (await sh(client, box, asRoot(`pids=$(pgrep -f 'archil mount .*${id}' | tr '\\n' ' '); kill -9 $pids; sleep 0.3; echo "killed $pids; left: $(pgrep -f 'archil mount .*${id}' | tr '\\n' ' ')"`))).trim();
    const t = performance.now();
    const seen: string[] = [];
    let orphanMs: number | null = null;
    for (; performance.now() - t < 120_000; await sleep(500)) {
      const ds = await findDelegations(control, id);
      seen.push(`${Math.round(performance.now() - t)}:${ds.map((d) => (d.isOrphaned ? "orphaned" : "held")).join(",") || "none"}`);
      if (ds.length && ds.every((d) => d.isOrphaned)) {
        orphanMs = Math.round(performance.now() - t);
        break;
      }
    }
    res.orphanMs = orphanMs;
    res.trace = seen.filter((_, i) => i % 10 === 0 || i === seen.length - 1);
    res.socketsAfter = (await sh(client, box, asRoot(`ss -tn 2>/dev/null | awk 'NR>1{print $1, $5}' | grep -E ':(8100|32050|443)$' | sort | uniq -c | head`))).trim().split("\n");
  } finally {
    await revokeBestEffort(control, id).catch(() => []);
    await sh(client, box, asRoot(`mkdir -p /tmp/.fuse-defunct-o && mount --move ${mp} /tmp/.fuse-defunct-o 2>/dev/null; true`)).catch(() => {});
    if (token) await removeMountToken(control, token.identifier).then(() => ledger.tokenRemoved(token!.identifier), () => {});
    const del = await deletePrefix(disk as never, `runs/${id}/`).catch((err: unknown) => ({ error: (err as Error).message }));
    ledger.subdirDeleted(`runs/${id}/`, JSON.stringify(del));
    res.cleanup = del;
    const out = token ? JSON.parse(JSON.stringify(res).split(token.token).join("<token>")) : res;
    record("orphan", out);
    process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
  }
}


/** Power-off: the box SIGKILLed by Daytona (force stop) while it holds a mount; how long until Archil sees it orphaned. */
async function poweroff(client: DaytonaClient): Promise<void> {
  const box = await current(client);
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  const diskId = scratchDiskId();
  const stamp = Date.now().toString(36);
  const id = `p9-poweroff-${stamp}`;
  const mp = `${MOUNT_ROOT}/runs/${id}`;
  const ids = facts(await sh(client, box, `printf 'uid\\t%s\\ngid\\t%s\\n' "$(id -u pda)" "$(id -g pda)"`));
  let token: { token: string; identifier: string; nickname: string } | null = null;
  const res: Record<string, unknown> = { run: id, box: box.id };
  try {
    await createRunDir(control, id, { uid: Number(ids.uid), gid: Number(ids.gid) });
    ledger.subdir(`runs/${id}/`, "probe poweroff");
    token = await mintMountToken(control, { nickname: `pda-p9-poweroff-${stamp}`, ttl: "1h" });
    ledger.token(token.identifier, token.nickname, "poweroff");
    res.mount = facts(await sh(client, box, mountScript(diskId, id, mp, await stageToken(client, box, "poweroff", token.token)), 180));
    res.before = (await findDelegations(control, id)).map((d) => (d.isOrphaned ? "orphaned" : "held"));
    const t = performance.now();
    await client.stop(box.id, true);
    res.forceStopCallMs = Math.round(performance.now() - t);
    let orphanMs: number | null = null;
    const states: string[] = [];
    for (; performance.now() - t < 120_000; await sleep(250)) {
      const ds = await findDelegations(control, id);
      if (orphanMs === null && ds.length && ds.every((d) => d.isOrphaned)) orphanMs = Math.round(performance.now() - t);
      const b = await client.get(box.id);
      const st = b?.state ?? "404";
      if (states.at(-1)?.split(":")[1] !== st) states.push(`${Math.round(performance.now() - t)}:${st}`);
      if (orphanMs !== null && (st === "404" || st === "destroyed")) break;
    }
    res.orphanMs = orphanMs;
    res.boxStates = states;
  } finally {
    await revokeBestEffort(control, id).catch(() => []);
    if (token) await removeMountToken(control, token.identifier).then(() => ledger.tokenRemoved(token!.identifier), () => {});
    const del = await deletePrefix(disk as never, `runs/${id}/`).catch((err: unknown) => ({ error: (err as Error).message }));
    ledger.subdirDeleted(`runs/${id}/`, JSON.stringify(del));
    res.cleanup = del;
    if (!(await client.get(box.id))) ledger.deleted(box.id, "force stop with autoDeleteInterval 0");
    res.stillAlive = await confirmGone(client, 120_000);
    const out = token ? JSON.parse(JSON.stringify(res).split(token.token).join("<token>")) : res;
    record("poweroff", out);
    process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
  }
}


const RELEASE_SCRIPT = String.raw`
import { readFileSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
const { acquire } = await import(process.env.PDA_PKG + "/dist/claim.js");
const [phase, disk, id] = process.argv.slice(2);
const ref = { disk, region: "aws-us-east-1", id };
const mountRoot = process.env.PDA_MOUNT_ROOT;
const host = { archil: process.env.PDA_ARCHIL };
const line = readFileSync(0, "utf8").split("\n")[0];
const listed = (mp) => readFileSync("/proc/self/mounts", "utf8").split("\n").some((l) => l.split(" ")[1] === mp);
const out = { phase, uid: process.getuid() };
try {
  if (phase === "first") {
    const c = await acquire({ ref, token: line, mountRoot, host });
    const fd = openSync(join(c.work.replace(/\/work$/, ""), "committed.txt"), "w");
    writeSync(fd, "written before the release\n");
    fsyncSync(fd);
    closeSync(fd);
    out.barrierMs = Math.round((await c.barrier()).ms);
    out.first = { root: c.root, reused: c.reused, timings: c.timings };
  } else if (phase === "release-and-again") {
    const c = await acquire({ ref, token: "spent", mountRoot, host });
    out.reusedBeforeRelease = c.reused;
    const t0 = performance.now();
    out.release = await c.release();
    out.releaseMs = Math.round(performance.now() - t0);
    out.pathFreeAfterRelease = !listed(c.root);
    const c2 = await acquire({ ref, token: line, mountRoot, host });
    out.again = { reused: c2.reused, timings: c2.timings, committed: readFileSync(join(c2.root, "committed.txt"), "utf8").trim() };
  } else if (phase === "final") {
    const c = await acquire({ ref, token: "spent", mountRoot, host });
    out.release = await c.release();
    out.pathFree = !listed(c.root);
  }
} catch (err) {
  out.error = { name: err.name, code: err.code, message: String(err.message).slice(0, 400) };
}
console.log(JSON.stringify(out));
`;

/** A fresh probe box of this lane, started and with the runtime installed; its runner and kernel recorded. */
async function freshBox(client: DaytonaClient, kind: string, stamp: string): Promise<{ box: SandboxInfo; facts: Record<string, unknown> }> {
  const name = `${NAME_PREFIX}${kind}-${stamp}`;
  const labels = { [LABEL_FLEET]: FLEET, [LABEL_RUN]: kind, "pda-p9": `${kind}-${stamp}` };
  const created = await client.create({ name, snapshot: SNAPSHOT, target: TARGET, labels, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: 90 });
  let box: SandboxInfo | null = created;
  for (const t0 = Date.now(); box?.state !== "started"; box = await client.get(created.id)) {
    if (!box || Date.now() - t0 > 180_000) throw new Error(`box ${name} is ${box?.state ?? "gone"}`);
    await sleep(500);
  }
  const raw = box as SandboxInfo & { runnerId?: string; daemonVersion?: string };
  try {
    const prep = await prepareBox(client, box);
    const k = (await sh(client, box, `uname -r; grep -c sysboxfs /proc/mounts || true; grep -m1 -oE 'uid_map|[0-9]+ +[0-9]+ +[0-9]+' /proc/self/uid_map | head -1`)).trim().split("\n");
    return { box, facts: { id: box.id, runnerId: raw.runnerId ?? null, daemonVersion: raw.daemonVersion ?? null, kernel: k[0], sysboxfsMounts: Number(k[1]), uidMap: (k[2] ?? "").replace(/\s+/g, " "), prepareMs: prep.ms } };
  } catch (err) {
    await client.remove(box.id).catch(() => {});
    throw err;
  }
}

/** One mount from a root shell and `archil unmount`: whether this box's runner refuses the unmount with ENOENT. */
async function refusesUnmount(client: DaytonaClient, box: SandboxInfo, control: ControlApi, disk: unknown, stamp: string, tokens: { token: string; identifier: string }[]): Promise<{ refused: boolean; out: string }> {
  const id = `p9-q-${stamp}`;
  const mp = `${MOUNT_ROOT}/runs/${id}`;
  await createRunDir(control, id, { uid: PDA_ID, gid: PDA_ID });
  ledger.subdir(`runs/${id}/`, "unmount check");
  const t = await mintMountToken(control, { nickname: `pda-p9-q-${stamp}`, ttl: "1h" });
  ledger.token(t.identifier, t.nickname, "unmount check");
  tokens.push(t);
  try {
    const tf = await stageToken(client, box, `q-${stamp}`, t.token);
    await sh(client, box, asRoot(`install -d -o pda -g pda ${mp}\n${ARCHIL_WRAPPER} mount ${scratchDiskId()}:/runs/${id} ${mp} --region aws-us-east-1 < ${tf} >/dev/null 2>&1; rm -f ${tf}`), 180);
    const r = await client.exec(box, asRoot(`/usr/bin/archil unmount ${mp} 2>&1 | tail -1`), 60);
    const refused = Boolean(await mounted(client, box, mp));
    if (refused) await sh(client, box, asRoot(`/usr/bin/archil checkin ${mp} >/dev/null 2>&1; mkdir -p /tmp/.q && mount --move ${mp} /tmp/.q; for d in /proc/[0-9]*; do tr '\\0' '\\n' < $d/cmdline 2>/dev/null | grep -qxF ${mp} && kill -9 \${d##*/}; done; true`));
    return { refused, out: r.result.trim() };
  } finally {
    await revokeBestEffort(control, id).catch(() => []);
    ledger.subdirDeleted(`runs/${id}/`, JSON.stringify(await deletePrefix(disk as never, `runs/${id}/`).catch((err: unknown) => ({ error: (err as Error).message }))));
  }
}

/**
 * The claim's release live, through the package as the run user: claim and commit; release (on a runner that refuses
 * unmounts: checkin, move aside, kill the daemon); a new claim at the same path; then a final release. With `hunt`, boxes
 * whose runner unmounts normally are recorded and deleted until one refuses (at most 5), so the fallback runs for real.
 */
async function release(client: DaytonaClient): Promise<void> {
  const hunt = process.argv[3] === "hunt";
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  const diskId = scratchDiskId();
  const tokens: { token: string; identifier: string }[] = [];
  const res: Record<string, unknown> = { hunt, boxes: [] as unknown[] };
  const ids: string[] = [];
  let current: SandboxInfo | null = null;
  try {
    for (let attempt = 1; attempt <= (hunt ? 5 : 1); attempt++) {
      const stamp = Date.now().toString(36);
      const { box, facts: f } = await freshBox(client, "rel", stamp);
      current = box;
      const q = await refusesUnmount(client, box, control, disk, stamp, tokens);
      (res.boxes as unknown[]).push({ ...f, refusesUnmount: q.refused, unmount: q.out });
      if (!hunt || q.refused) break;
      await client.remove(box.id);
      current = null;
    }
    if (!current) throw new Error("no box whose runner refuses unmounts in 5 tries");
    const box: SandboxInfo = current;
    const stamp = Date.now().toString(36);
    const id = `p9-rel-${stamp}`;
    ids.push(id);
    res.run = id;
    res.box = box.id;
    const delegations = async () => (await findDelegations(control, id)).map((d) => ({ clientId: d.clientId, state: d.isOrphaned ? "orphaned" : d.isPending ? "pending" : "held" }));
    await createRunDir(control, id, { uid: PDA_ID, gid: PDA_ID });
    ledger.subdir(`runs/${id}/`, "claim release live");
    for (const tag of ["rel1", "rel2"]) {
      const t = await mintMountToken(control, { nickname: `pda-p9-${tag}-${stamp}`, ttl: "1h" });
      ledger.token(t.identifier, t.nickname, `release ${tag}`);
      tokens.push(t);
      await stageToken(client, box, `${tag}-${stamp}`, t.token);
    }
    await client.upload(box, "/tmp/pda-rel.mjs", new TextEncoder().encode(RELEASE_SCRIPT));
    const asPda = async (phase: string, tokenFile: string) => {
      const env = `PDA_PKG=${PACKAGE_DIR} PDA_MOUNT_ROOT=${MOUNT_ROOT} PDA_ARCHIL=${ARCHIL_WRAPPER}`;
      const out = await sh(client, box, asRoot(`chmod 0644 /tmp/pda-rel.mjs
env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/pda ${env} setpriv --reuid=pda --regid=pda --init-groups -- ${NODE} /tmp/pda-rel.mjs ${phase} ${diskId} ${id} < ${tokenFile}
rc=$?
[ ${tokenFile} = /dev/null ] || rm -f ${tokenFile}
exit $rc`), 300);
      return JSON.parse(out.trim().split("\n").at(-1)!) as Record<string, unknown>;
    };
    res.first = await asPda("first", `/run/pda/rel1-${stamp}.token`);
    res.delegationsAfterFirst = await delegations();
    res.releaseAndAgain = await asPda("release-and-again", `/run/pda/rel2-${stamp}.token`);
    res.delegationsAfterAgain = await delegations();
    res.boxAfterAgain = (await sh(client, box, asRoot(`awk '$3 == "fuse.archil" {print $2}' /proc/mounts; ls ${MOUNT_ROOT}/.released 2>&1; pgrep -a -f 'archil mount' | cut -c1-160`))).trim().split("\n");
    res.final = await asPda("final", "/dev/null");
    res.delegationsAtEnd = await delegations();
    res.tokenFilesLeft = (await sh(client, box, asRoot(`ls /run/pda /tmp/pda-stage 2>/dev/null | grep -c token || true`))).trim();
  } finally {
    for (const id of ids) await revokeBestEffort(control, id).catch(() => []);
    for (const t of tokens) await removeMountToken(control, t.identifier).then(() => ledger.tokenRemoved(t.identifier), () => {});
    for (const id of ids) ledger.subdirDeleted(`runs/${id}/`, JSON.stringify(await deletePrefix(disk as never, `runs/${id}/`).catch((err: unknown) => ({ error: (err as Error).message }))));
    if (current) await client.remove(current.id).catch(() => {});
    res.stillAlive = await confirmGone(client, 120_000);
    const out = JSON.parse(tokens.reduce((acc, t) => acc.split(t.token).join("<token>"), JSON.stringify(res)));
    record(hunt ? "release-hunt" : "release", out);
    process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
  }
}

/** Why `archil unmount` failed with ENOENT in the first box and worked through the claim in the second: one fresh box,
 * four mounts made the probe's way, each unmounted a different way; the binaries and mountinfo recorded. */
async function unmountab(client: DaytonaClient): Promise<void> {
  const stamp = Date.now().toString(36);
  const name = `${NAME_PREFIX}ab-${stamp}`;
  const labels = { [LABEL_FLEET]: FLEET, [LABEL_RUN]: "unmountab", "pda-p9": `ab-${stamp}` };
  const created = await client.create({ name, snapshot: SNAPSHOT, target: TARGET, labels, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: 90 });
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  const diskId = scratchDiskId();
  const tokens: { token: string; identifier: string }[] = [];
  const ids: string[] = [];
  const res: Record<string, unknown> = { box: created.id };
  try {
    let box: SandboxInfo | null = created;
    for (const t0 = Date.now(); box?.state !== "started"; box = await client.get(created.id)) {
      if (!box || Date.now() - t0 > 180_000) throw new Error(`ab box is ${box?.state ?? "gone"}`);
      await sleep(500);
    }
    res.prepare = (await prepareBox(client, box)).ms;
    res.binaries = (await sh(client, box, `command -v archil; ls -l /usr/local/bin/archil /usr/bin/archil 2>&1; sudo -n sh -c 'command -v archil; echo HOME=$HOME'`)).trim().split("\n");
    const which = process.argv[3] ?? "first";
    const cases: [string, string][] = which === "access" ? [
      ["never accessed: stat after a failed unmount", "/usr/bin/archil unmount MP; stat -c %F MP"],
      ["stat first, then unmount", "stat -c %F MP && /usr/bin/archil unmount MP"],
      ["ls first, then unmount", "ls -a MP >/dev/null && /usr/bin/archil unmount MP"],
      ["a write and fsync first, then unmount", "dd if=/dev/zero of=MP/.x bs=1 count=1 conv=fsync status=none && /usr/bin/archil unmount MP"],
    ] : [
      ["root shell, archil on PATH", "archil unmount MP"],
      ["root shell, /usr/bin/archil", "/usr/bin/archil unmount MP"],
      ["root shell, sync then /usr/bin/archil", "/usr/bin/archil sync MP && /usr/bin/archil unmount MP"],
      ["as pda through sudo archil-scoped (the claim's way)", `setpriv --reuid=pda --regid=pda --init-groups -- sudo -n ${ARCHIL_WRAPPER} unmount MP`],
    ];
    res.which = which;
    const out: Record<string, unknown>[] = [];
    for (const [i, [label, cmd]] of cases.entries()) {
      const id = `p9-ab${i}-${stamp}`;
      const mp = `${MOUNT_ROOT}/runs/${id}`;
      await createRunDir(control, id, { uid: PDA_ID, gid: PDA_ID });
      ledger.subdir(`runs/${id}/`, "unmount A/B");
      ids.push(id);
      const t = await mintMountToken(control, { nickname: `pda-p9-ab${i}-${stamp}`, ttl: "1h" });
      ledger.token(t.identifier, t.nickname, "unmount A/B");
      tokens.push(t);
      const m = facts(await sh(client, box, mountScript(diskId, id, mp, await stageToken(client, box, `ab${i}-${stamp}`, t.token)), 180));
      const info = (await sh(client, box, `grep ' ${mp} ' /proc/self/mountinfo | cut -c1-220`)).trim();
      const r = await client.exec(box, asRoot(`${cmd.replaceAll("MP", mp)} 2>&1 | tail -2 | tr '\\n' ' '; echo; echo "rc=\${PIPESTATUS[0]}"`), 60);
      const still = await mounted(client, box, mp);
      out.push({ label, mount: m.rc, mountinfo: info, result: r.result.trim().split("\n"), stillMounted: Boolean(still) });
      if (still) {
        await sh(client, box, asRoot(`/usr/bin/archil checkin ${mp} >/dev/null 2>&1; mkdir -p /tmp/.ab-${i} && mount --move ${mp} /tmp/.ab-${i}; for d in /proc/[0-9]*; do tr '\\0' ' ' < $d/cmdline 2>/dev/null | grep -qF " ${mp} " && kill -9 \${d##*/}; done; true`));
      }
    }
    res.cases = out;
  } finally {
    for (const id of ids) await revokeBestEffort(control, id).catch(() => []);
    for (const t of tokens) await removeMountToken(control, t.identifier).then(() => ledger.tokenRemoved(t.identifier), () => {});
    for (const id of ids) {
      const del = await deletePrefix(disk as never, `runs/${id}/`).catch((err: unknown) => ({ error: (err as Error).message }));
      ledger.subdirDeleted(`runs/${id}/`, JSON.stringify(del));
    }
    await client.remove(created.id).catch(() => {});
    res.stillAlive = await confirmGone(client, 120_000);
    const outj = JSON.parse(tokens.reduce((acc, t) => acc.split(t.token).join("<token>"), JSON.stringify(res)));
    record(`unmountab-${process.argv[3] ?? "first"}`, outj);
    process.stdout.write(`${JSON.stringify(outj, null, 1)}\n`);
  }
}


/** Which way of starting `archil mount` in a box leaves a mount that `archil unmount` (and, dead, fusermount) can remove. */
async function mountways(client: DaytonaClient): Promise<void> {
  const stamp = Date.now().toString(36);
  const name = `${NAME_PREFIX}mw-${stamp}`;
  const labels = { [LABEL_FLEET]: FLEET, [LABEL_RUN]: "mountways", "pda-p9": `mw-${stamp}` };
  const created = await client.create({ name, snapshot: SNAPSHOT, target: TARGET, labels, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: 90 });
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  const diskId = scratchDiskId();
  const tokens: { token: string; identifier: string }[] = [];
  const ids: string[] = [];
  const res: Record<string, unknown> = { box: created.id };
  const W = ARCHIL_WRAPPER;
  // T = token file (root-only), S = disk:/runs/<id>, M = mountpoint
  const E = "env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root LANG=C.UTF-8";
  const ways: [string, string, "unmount" | "dead" | "unmount-env-i" | "dead-env-i"][] = process.argv[3] === "env" ? [
    ["mount with the shell's environment, unmount under env -i", "W mount S M --region aws-us-east-1 < T >/dev/null 2>&1; echo $?", "unmount-env-i"],
    ["mount under env -i, unmount with the shell's environment", `${E} W mount S M --region aws-us-east-1 < T >/dev/null 2>&1; echo $?`, "unmount"],
    ["mount under env -i, unmount under env -i", `${E} W mount S M --region aws-us-east-1 < T >/dev/null 2>&1; echo $?`, "unmount-env-i"],
    ["mount under env -i, daemon SIGKILLed, fusermount under env -i", `${E} W mount S M --region aws-us-east-1 < T >/dev/null 2>&1; echo $?`, "dead-env-i"],
  ] : [
    ["root bash, $(...) capture, file stdin (the probe's way)", "out=$(W mount S M --region aws-us-east-1 < T 2>&1); echo $?", "unmount"],
    ["root bash, file stdin, output to /dev/null", "W mount S M --region aws-us-east-1 < T >/dev/null 2>&1; echo $?", "unmount"],
    ["root bash, pipe stdin", "cat T | W mount S M --region aws-us-east-1 >/dev/null 2>&1; echo $?", "unmount"],
    ["root bash, setsid, file stdin", "setsid W mount S M --region aws-us-east-1 < T >/dev/null 2>&1; echo $?", "unmount"],
    ["as pda through sudo (the claim's hop), file stdin", "setpriv --reuid=pda --regid=pda --init-groups -- sudo -n W mount S M --region aws-us-east-1 < T >/dev/null 2>&1; echo $?", "unmount"],
    ["as pda through sudo, then the daemon SIGKILLed (dead mount)", "setpriv --reuid=pda --regid=pda --init-groups -- sudo -n W mount S M --region aws-us-east-1 < T >/dev/null 2>&1; echo $?", "dead"],
    ["root bash, $(...) capture, then the daemon SIGKILLed (dead mount)", "out=$(W mount S M --region aws-us-east-1 < T 2>&1); echo $?", "dead"],
  ];
  try {
    let box: SandboxInfo | null = created;
    for (const t0 = Date.now(); box?.state !== "started"; box = await client.get(created.id)) {
      if (!box || Date.now() - t0 > 180_000) throw new Error(`box is ${box?.state ?? "gone"}`);
      await sleep(500);
    }
    res.prepare = (await prepareBox(client, box)).ms;
    res.sudoDefaults = (await sh(client, box, asRoot(`sudo -V 2>/dev/null | grep -iE 'use_pty|Sudo version' | head -3`))).trim().split("\n");
    res.rootShellEnvNames = (await sh(client, box, asRoot(`env | cut -d= -f1 | sort | tr '\n' ' '`))).trim();
    res.toolboxEnvNames = (await sh(client, box, `env | cut -d= -f1 | sort | tr '\n' ' '`)).trim();
    const out: Record<string, unknown>[] = [];
    for (const [i, [label, cmd, after]] of ways.entries()) {
      const id = `p9-mw${i}-${stamp}`;
      const mp = `${MOUNT_ROOT}/runs/${id}`;
      await createRunDir(control, id, { uid: PDA_ID, gid: PDA_ID });
      ledger.subdir(`runs/${id}/`, "mount ways");
      ids.push(id);
      const t = await mintMountToken(control, { nickname: `pda-p9-mw${i}-${stamp}`, ttl: "1h" });
      ledger.token(t.identifier, t.nickname, "mount ways");
      tokens.push(t);
      const tf = await stageToken(client, box, `mw${i}-${stamp}`, t.token);
      const mountRc = (await sh(client, box, asRoot(`install -d -o pda -g pda ${mp}\n${cmd.replaceAll("W", W).replaceAll("S", `${diskId}:/runs/${id}`).replaceAll("M", mp).replaceAll("T", tf)}\nrm -f ${tf}`), 180)).trim();
      const daemon = (await sh(client, box, asRoot(`for d in /proc/[0-9]*; do tr '\\0' '\\n' < $d/cmdline 2>/dev/null | grep -qxF ${mp} && echo "\${d##*/} $(cat /proc/\${d##*/}/stat | cut -d' ' -f5-8)"; done; true`))).trim();
      const row: Record<string, unknown> = { label, mountRc, mounted: Boolean(await mounted(client, box, mp)), daemon };
      const pre = after.endsWith("env-i") ? `${E} ` : "";
      if (after.startsWith("unmount")) {
        const r = await client.exec(box, asRoot(`${pre}/usr/bin/archil unmount ${mp} 2>&1 | tail -1; echo "rc=\${PIPESTATUS[0]}"`), 60);
        row.unmount = r.result.trim().split("\n");
      } else {
        const pid = daemon.split(" ")[0];
        await sh(client, box, asRoot(`kill -9 ${pid}; sleep 0.5`));
        row.statDead = (await client.exec(box, asRoot(`stat -c %F ${mp} 2>&1 | tail -1`), 20)).result.trim();
        const f = await client.exec(box, asRoot(`${pre}fusermount -u ${mp} 2>&1 | tail -1; echo "rc=\${PIPESTATUS[0]}"`), 30);
        row.fusermount = f.result.trim().split("\n");
        if (await mounted(client, box, mp)) {
          const u = await client.exec(box, asRoot(`${pre}umount -l ${mp} 2>&1 | tail -1; echo "rc=\${PIPESTATUS[0]}"`), 30);
          row.umountLazy = u.result.trim().split("\n");
        }
      }
      row.stillMounted = Boolean(await mounted(client, box, mp));
      if (row.stillMounted) await sh(client, box, asRoot(`/usr/bin/archil checkin ${mp} >/dev/null 2>&1; mkdir -p /tmp/.mw-${i} && mount --move ${mp} /tmp/.mw-${i}; for d in /proc/[0-9]*; do tr '\\0' '\\n' < $d/cmdline 2>/dev/null | grep -qxF ${mp} && kill -9 \${d##*/}; done; true`));
      out.push(row);
    }
    res.ways = out;
  } finally {
    for (const id of ids) await revokeBestEffort(control, id).catch(() => []);
    for (const t of tokens) await removeMountToken(control, t.identifier).then(() => ledger.tokenRemoved(t.identifier), () => {});
    for (const id of ids) ledger.subdirDeleted(`runs/${id}/`, JSON.stringify(await deletePrefix(disk as never, `runs/${id}/`).catch((err: unknown) => ({ error: (err as Error).message }))));
    await client.remove(created.id).catch(() => {});
    res.stillAlive = await confirmGone(client, 120_000);
    const outj = JSON.parse(tokens.reduce((acc, t) => acc.split(t.token).join("<token>"), JSON.stringify(res)));
    record(`mountways-${process.argv[3] ?? "first"}`, outj);
    process.stdout.write(`${JSON.stringify(outj, null, 1)}\n`);
  }
}


/** Which boxes refuse unmounts: N fresh boxes at once, each with its runner id, kernel and one root-shell unmount. */
async function runners(client: DaytonaClient): Promise<void> {
  const n = Number(process.argv[3] ?? 4);
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  const tokens: { token: string; identifier: string }[] = [];
  const made: string[] = [];
  const rows = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const stamp = `${Date.now().toString(36)}${i}`;
      try {
        const { box, facts: f } = await freshBox(client, "rn", stamp);
        made.push(box.id);
        const q = await refusesUnmount(client, box, control, disk, stamp, tokens);
        await client.remove(box.id);
        return { ...f, refusesUnmount: q.refused, unmount: q.out };
      } catch (err) {
        return { error: (err as Error).message };
      }
    }),
  );
  for (const t of tokens) await removeMountToken(control, t.identifier).then(() => ledger.tokenRemoved(t.identifier), () => {});
  for (const id of made) await client.remove(id).catch(() => {});
  const stillAlive = await confirmGone(client, 120_000);
  const out = JSON.parse(tokens.reduce((acc, t) => acc.split(t.token).join("<token>"), JSON.stringify({ rows, stillAlive })));
  record("runners", out);
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
}

async function janitor(client: DaytonaClient): Promise<void> {
  const found = await client.list({ [LABEL_FLEET]: FLEET });
  const known = ledger.ids();
  const strangers = found.filter((b) => !known.has(b.id));
  for (const b of found.filter((b) => known.has(b.id))) await client.remove(b.id);
  const alive = await confirmGone(client);
  const after = await client.list({ [LABEL_FLEET]: FLEET });
  if (existsSync(PROBE_STATE) && !after.some((b) => b.id === probeBox().id)) renameSync(PROBE_STATE, `${PROBE_STATE.pathname}.done`);
  const out = { deleted: found.filter((b) => known.has(b.id)).map((b) => b.id), strangers: strangers.map((b) => ({ id: b.id, name: b.name })), stillAlive: alive, labeledAfter: after.map((b) => ({ id: b.id, state: b.state })), spendUsd: Math.round(ledger.spend() * 10000) / 10000 };
  record("janitor", out);
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
}

async function main(): Promise<void> {
  if (!LIVE_DAYTONA) throw new Error("set PDA_LIVE=1 and run under with-daytona");
  const client = guardedClient();
  const phase = process.argv[2];
  switch (phase) {
    case "egress":
      return egress(client);
    case "janitor":
      return janitor(client);
    case "prepare":
      return prepare(client);
    case "claim":
      return claim(client);
    case "remount":
      return remount(client);
    case "orphan":
      return orphan(client);
    case "poweroff":
      return poweroff(client);
    case "release":
      return release(client);
    case "unmountab":
      return unmountab(client);
    case "mountways":
      return mountways(client);
    case "runners":
      return runners(client);
    case "spend":
      process.stdout.write(`${JSON.stringify({ spendUsd: Math.round(ledger.spend() * 10000) / 10000 })}\n`);
      return;
    case "box":
      process.stdout.write(`${JSON.stringify(await current(client))}\n`);
      return;
    default:
      throw new Error(`unknown phase ${phase}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`probe failed: ${(err as Error).message}\n`);
  process.exit(1);
});
