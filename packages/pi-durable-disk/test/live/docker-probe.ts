// The docker probe: what an Archil claim needs inside a plain Docker container on this host, measured. Phases (argv):
//   mount     which `docker run` flags let `archil mount` work; ownership and permissions as root and as the run user;
//             commit latency; a second container's mount of the held run; unmount, dead-mount cleanup and kill inside a
//             container; freeze (docker pause), revoke, thaw; docker stop on a paused container.
//   drain     instances started through dockerHost and stopped with `docker stop`: is the delegation checked in?
// Run: PDA_LIVE=1 PDA_LIVE_DISK=dsk-... ARCHIL_API_KEY=... node test/live/docker-probe.ts mount|drain
// Every container, token user and run directory goes into the ledger first and is removed in `finally`.
import { readFileSync } from "node:fs";
import { REGION, scratchDiskId } from "./_archil.ts";
import { deletePrefix, delegationsOn, docker, exec, FLEET, fleetContainers, IMAGE as RUNTIME_IMAGE, ledger, makeRunDir, mint, NAME_PREFIX, record, removeContainer, revokeAll, runContainer, RUN_UID, sleep, unmint } from "./_docker.ts";

/** The mount phase needs only node and the archil client in the image; the runtime image has both. */
const IMAGE = process.env.PDA_DOCKER_PROBE_IMAGE ?? RUNTIME_IMAGE;
const MOUNT_ROOT = `/mnt/pda/${FLEET}`;
const stamp = Date.now().toString(36);
const containers: string[] = [];
const tokens: string[] = [];
const out: Record<string, unknown> = { image: IMAGE, docker: docker(["version", "--format", "{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}"]).stdout.trim() };
const tail = (s: string, n = 400) => s.trim().split("\n").slice(-4).join(" | ").slice(-n);

function hostArchilMounts(): string[] {
  return readFileSync("/proc/mounts", "utf8").split("\n").filter((l) => l.includes("fuse.archil") && l.includes(`${FLEET}-probe-`));
}

function start(tag: string, flags: string[], purpose: string): string {
  const name = `${NAME_PREFIX}-probe-${tag}-${stamp}`;
  containers.push(name);
  // The runtime image's entrypoint runs the CLI; a probe container only needs to stay up.
  const r = runContainer(name, purpose, ["--init", "--entrypoint", "sleep", ...flags], IMAGE, ["infinity"]);
  if (r.status !== 0) throw new Error(`docker run ${name}: ${tail(r.stderr)}`);
  return name;
}

/** `archil mount` inside a container, the token on the exec's stdin and only in the environment of that one exec. */
function mountIn(name: string, id: string, token: string) {
  const mp = `${MOUNT_ROOT}/runs/${id}`;
  const script = 'IFS= read -r t; mkdir -p "$1"; ARCHIL_MOUNT_TOKEN="$t" exec archil mount "$2" "$1" --region "$3"';
  const r = exec(name, ["sh", "-c", script, "sh", mp, `${scratchDiskId()}:/runs/${id}`, REGION], { input: `${token}\n`, secret: token, timeoutMs: 120_000 });
  const mounts = exec(name, ["sh", "-c", `grep ' ${mp} ' /proc/mounts || true`]).stdout.trim();
  return { rc: r.status, ms: Math.round(r.ms), mounted: mounts.split(" ")[2] ?? "", options: mounts.split(" ")[3] ?? "", tail: tail(r.stderr + r.stdout) };
}

const sh = (name: string, script: string, user?: string) => {
  const r = exec(name, ["sh", "-c", script], { user });
  return { rc: r.status, out: tail(r.stdout + r.stderr, 1500) };
};

async function waitOrphaned(id: string, timeoutMs = 30_000): Promise<number | null> {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const held = await delegationsOn(id);
    if (held.length && held.every((d) => d.isOrphaned)) return Math.round(performance.now() - t0);
    if (!held.length) return -Math.round(performance.now() - t0);
    await sleep(50);
  }
  return null;
}

const LATENCY = String.raw`
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const dir = process.argv[1];
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const db = new DatabaseSync(dir + "/lat.sqlite");
db.exec("PRAGMA locking_mode = EXCLUSIVE"); db.exec("PRAGMA journal_mode = WAL"); db.exec("PRAGMA synchronous = FULL"); db.exec("PRAGMA mmap_size = 0");
db.exec("CREATE TABLE IF NOT EXISTS t (k INTEGER PRIMARY KEY, v BLOB)");
const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
const commits = [];
for (let i = 0; i < 300; i++) { const t0 = performance.now(); db.exec("BEGIN"); ins.run(Buffer.alloc(512, i)); db.exec("COMMIT"); commits.push(performance.now() - t0); }
db.close();
const fsyncs = [];
const fd = fs.openSync(dir + "/lat.bin", "w");
for (let i = 0; i < 100; i++) { fs.writeSync(fd, Buffer.alloc(512, i)); const t0 = performance.now(); fs.fsyncSync(fd); fsyncs.push(performance.now() - t0); }
fs.closeSync(fd);
console.log(JSON.stringify({ commits: { n: commits.length, p50: q(commits, 0.5), p95: q(commits, 0.95), max: q(commits, 1) }, fsync512B: { n: fsyncs.length, p50: q(fsyncs, 0.5), p95: q(fsyncs, 0.95) } }));
`;

async function phaseMount() {
  const id = `${FLEET}-probe-${stamp}`;
  const mp = `${MOUNT_ROOT}/runs/${id}`;
  await makeRunDir(id, "probe: mount in a container");
  const result: Record<string, unknown> = { run: id, mountpoint: mp, hostMountsBefore: hostArchilMounts() };
  try {
    const tokA = await mint("probe-a");
    tokens.push(tokA.identifier);
    // 1. Flags: the minimum the lead named, then AppArmor unconfined if the first is refused.
    const variants: { tag: string; flags: string[] }[] = [
      { tag: "a1", flags: ["--device", "/dev/fuse", "--cap-add", "SYS_ADMIN"] },
      { tag: "a2", flags: ["--device", "/dev/fuse", "--cap-add", "SYS_ADMIN", "--security-opt", "apparmor=unconfined"] },
    ];
    const tried: Record<string, unknown>[] = [];
    let a = "";
    let flags: string[] = [];
    for (const v of variants) {
      const name = start(v.tag, v.flags, `probe: mount with ${v.flags.join(" ")}`);
      const facts = sh(name, "id; grep -E '^(CapEff|CapBnd|Seccomp|NoNewPrivs)' /proc/self/status; cat /proc/self/attr/current 2>/dev/null; ls -l /dev/fuse; uname -r");
      const m = mountIn(name, id, tokA.token);
      tried.push({ tag: v.tag, flags: v.flags.join(" "), facts: facts.out, mount: m });
      if (m.mounted === "fuse.archil") {
        a = name;
        flags = v.flags;
        break;
      }
      removeContainer(name);
    }
    result.flags = tried;
    if (!a) throw new Error("no flag set let archil mount work");
    result.hostMountsWhileMounted = hostArchilMounts();
    result.delegationsAfterMount = (await delegationsOn(id)).map((d) => ({ isOrphaned: d.isOrphaned, isPending: d.isPending, path: d.path }));
    result.delegationsInBox = sh(a, `archil delegations --json ${mp}`).out;

    // 2. Ownership and permissions: root (the instance) and uid 1500 (the agent's commands).
    const u = `${RUN_UID}:${RUN_UID}`;
    result.perms = {
      rootSetup: sh(a, `cd ${mp} && mkdir -p store work && echo s > store/db && echo r > rootfile && chmod 644 store/db rootfile && chown ${u} work && echo p > work/pifile && chmod 644 work/pifile && ls -lna . store work`),
      userAppendRootFile: sh(a, `echo y >> ${mp}/rootfile && echo appended`, u),
      userWriteRootDir: sh(a, `touch ${mp}/store/x && echo created`, u),
      userTruncateStore: sh(a, `: > ${mp}/store/db && echo truncated`, u),
      userUnlinkStore: sh(a, `rm -f ${mp}/store/db && echo unlinked`, u),
      userWriteWork: sh(a, `echo u > ${mp}/work/u && echo created`, u),
      userAppendRootFileInWork: sh(a, `echo q >> ${mp}/work/pifile && echo appended`, u),
      userSedInPlaceRootFileInWork: sh(a, `sed -i s/p/q/ ${mp}/work/pifile && cat ${mp}/work/pifile && ls -ln ${mp}/work/pifile`, u),
      userCreateInRunRoot: sh(a, `touch ${mp}/byuser && echo created`, u),
      userReadDaemonEnviron: sh(a, `for p in $(pgrep -x archil); do cat /proc/$p/environ >/dev/null 2>&1 && echo "read $p" || echo "denied $p"; done`, u),
      rootChownBack: sh(a, `chown 0:0 ${mp}/work/u && ls -ln ${mp}/work/u`),
      after: sh(a, `ls -lnaR ${mp} | head -40`),
    };

    // 3. Commit latency from inside the container (the exclusive profile's pragmas).
    const lat = exec(a, ["node", "-e", LATENCY, mp], { timeoutMs: 120_000 });
    result.latency = lat.status === 0 ? JSON.parse(lat.stdout.trim()) : { error: tail(lat.stderr) };

    // 4. A second container's mount of the held run is refused.
    const tokB = await mint("probe-b");
    tokens.push(tokB.identifier);
    const b = start("b", flags, "probe: second container, same run");
    result.secondMount = mountIn(b, id, tokB.token);
    result.secondMountRefusedAsHeld = String((result.secondMount as { tail: string }).tail).includes("outstanding delegation");
    removeContainer(b);

    // 5. Unmount inside a live container: archil unmount, then remount and fusermount -u on a dead mount.
    const t0 = performance.now();
    result.archilUnmountLive = { ...sh(a, `archil unmount ${mp}; echo rc=$?; grep -c ' ${mp} ' /proc/mounts || true`), ms: Math.round(performance.now() - t0) };
    result.delegationsAfterUnmount = (await delegationsOn(id)).length;
    result.remount1 = mountIn(a, id, tokA.token);
    result.killDaemon = sh(a, `pkill -KILL -x archil; sleep 0.3; stat ${mp} 2>&1 | tail -1; grep -c ' ${mp} ' /proc/mounts || true`);
    result.orphanedAfterDaemonKillMs = await waitOrphaned(id);
    result.archilUnmountDead = sh(a, `archil unmount ${mp}; echo rc=$?; grep -c ' ${mp} ' /proc/mounts || true`);
    result.fusermountDead = sh(a, `fusermount -u ${mp}; echo rc=$?; grep -c ' ${mp} ' /proc/mounts || true`);
    result.revokedAfterDaemonKill = await revokeAll(id);
    result.remount2 = mountIn(a, id, tokA.token);
    result.remount2Delegations = (await delegationsOn(id)).map((d) => ({ isOrphaned: d.isOrphaned }));

    // 6. docker kill of a container with a live mount: no leftover on the host; how fast the delegation orphans.
    sh(a, `echo before-kill > ${mp}/marker && sync`);
    const k = docker(["kill", a]);
    result.dockerKill = { rc: k.status, ms: Math.round(k.ms) };
    result.orphanedAfterDockerKillMs = await waitOrphaned(id);
    result.hostMountsAfterKill = hostArchilMounts();
    result.killedState = docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}", a]).stdout.trim();
    result.revokedAfterKill = await revokeAll(id);
    removeContainer(a);

    // 7. Freeze: docker pause with a live mount, revoke, thaw: the old holder's fsync fails.
    const tokC = await mint("probe-c");
    tokens.push(tokC.identifier);
    const c = start("c", flags, "probe: freeze, revoke, thaw");
    result.mountC = mountIn(c, id, tokC.token);
    result.markerReadByC = sh(c, `cat ${mp}/marker`).out;
    sh(c, `exec 3>${mp}/frozen.txt; echo one >&3`);
    const p = docker(["pause", c]);
    result.pause = { rc: p.status, ms: Math.round(p.ms) };
    await sleep(1000);
    result.pausedDelegations = (await delegationsOn(id)).map((d) => ({ isOrphaned: d.isOrphaned }));
    const r0 = performance.now();
    result.revokedFrozen = await revokeAll(id);
    result.revokeMs = Math.round(performance.now() - r0);
    const up = docker(["unpause", c]);
    result.unpause = { rc: up.status };
    result.afterThaw = {
      fsync: sh(c, `node -e 'const fs=require("fs");const fd=fs.openSync(process.argv[1],"a");fs.writeSync(fd,"two\\n");try{fs.fsyncSync(fd);console.log("fsync ok")}catch(e){console.log("fsync "+e.code)}' ${mp}/frozen.txt`),
      sync: sh(c, `archil sync ${mp}; echo rc=$?`),
      newFile: sh(c, `touch ${mp}/new-after-revoke && echo created || echo refused`),
    };
    // 8. docker stop on a paused container (what STONITH does to a frozen host).
    docker(["pause", c]);
    const s = docker(["stop", "-t", "2", c], { timeoutMs: 60_000 });
    result.stopPaused = { rc: s.status, ms: Math.round(s.ms), stderr: tail(s.stderr), state: docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", c]).stdout.trim() };
    result.delegationsAtEnd = (await delegationsOn(id)).map((d) => ({ isOrphaned: d.isOrphaned }));
    result.revokedAtEnd = await revokeAll(id);
    removeContainer(c);
    result.hostMountsAtEnd = hostArchilMounts();
  } finally {
    for (const name of containers) removeContainer(name);
    for (const t of tokens) await unmint(t).catch((e: unknown) => ledger.event("unmint-failed", { identifier: t, error: String(e) }));
    await revokeAll(id).catch(() => 0);
    result.cleanup = await deletePrefix(`runs/${id}/`).catch((e: unknown) => ({ error: String(e) }));
    result.fleetLeft = fleetContainers();
    record("mount", { ...out, ...result });
    console.log(JSON.stringify({ ...out, ...result }, null, 2));
  }
}

/** An instance started through dockerHost, then `docker stop`: does the drain check the delegation in? */
async function phaseDrain() {
  const { diskKey, dockerHost } = await import("../../src/hosts/docker.ts");
  const { mintMountToken } = await import("../../src/claim.ts");
  const { scratchDisk } = await import("./_archil.ts");
  const { join, dirname } = await import("node:path");
  const { mkdirSync, chmodSync, readFileSync, existsSync, rmSync } = await import("node:fs");
  const repo = join(dirname(new URL(import.meta.url).pathname), "..", "..");
  const id = `${FLEET}-drain-${stamp}`;
  const outDir = join(process.env.TMPDIR ?? "/tmp", `${FLEET}-drain-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  chmodSync(outDir, 0o755);
  await makeRunDir(id, "probe: drain through docker stop", 0);
  const result: Record<string, unknown> = { run: id };
  const driver = dockerHost({
    image: RUNTIME_IMAGE,
    fleet: FLEET,
    namePrefix: `${NAME_PREFIX}-drain-`,
    mountRoot: MOUNT_ROOT,
    app: join(repo, "test/fixtures/docker-app.ts"),
    appRoot: repo,
    runArgs: ["--heartbeat-ms=1000"],
    env: { PDA_TEST_OUT: "/var/tmp/pda-out", NODE_NO_WARNINGS: "1" },
    dockerArgs: ["--mount", `type=bind,source=${outDir},target=/var/tmp/pda-out`],
    stopTimeoutMs: 20_000,
  });
  try {
    const disk = await scratchDisk();
    const t = await mintMountToken(disk as never, { run: { id, attempt: 1 }, prefix: `${NAME_PREFIX}-`, ttl: "1h" });
    tokens.push(t.identifier);
    ledger.token(t.identifier, t.nickname, "probe drain");
    const file = join(outDir, `${id}.jsonl`);
    const ticks = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"tick"')).length : 0);
    const rounds: Record<string, unknown>[] = [];
    for (let round = 1; round <= Number(process.env.PDA_DOCKER_DRAIN_ROUNDS ?? 1); round++) {
      const ref = { disk: scratchDiskId(), region: REGION, id };
      const name = `${NAME_PREFIX}-drain-${id}-${diskKey(ref)}-g${round}`;
      containers.push(name);
      ledger.container(name, "probe: drain");
      const before = ticks();
      await driver.start(ref, t.token, { attempt: round });
      for (let i = 0; i < 200 && ticks() < before + 3; i++) await sleep(250);
      const st = docker(["stop", "-t", "20", name], { timeoutMs: 60_000 });
      // Right after `docker stop` returns, the delegation's state every 50 ms for 3 s.
      const seen: string[] = [];
      for (const t0 = performance.now(); performance.now() - t0 < 3000; await sleep(50)) {
        const d = await delegationsOn(id);
        const word = d.length === 0 ? "none" : d.every((x) => x.isOrphaned) ? "orphaned" : "held";
        if (seen.at(-1)?.split("@")[0] !== word) seen.push(`${word}@${Math.round(performance.now() - t0)}`);
      }
      const logs = docker(["logs", name]).stderr.split("\n").filter(Boolean);
      rounds.push({ round, stop: { rc: st.status, ms: Math.round(st.ms) }, state: docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", name]).stdout.trim(), delegations: seen, release: logs.filter((l) => /released|release failed/.test(l)).map((l) => l.slice(0, 160)) });
      removeContainer(name);
      await revokeAll(id).catch(() => 0);
    }
    result.rounds = rounds;
  } finally {
    for (const name of containers) removeContainer(name);
    for (const t of tokens) await unmint(t).catch(() => {});
    await revokeAll(id).catch(() => 0);
    result.cleanup = await deletePrefix(`runs/${id}/`).catch((e: unknown) => ({ error: String(e) }));
    rmSync(outDir, { recursive: true, force: true });
    record("drain", result);
    console.log(JSON.stringify(result, null, 2));
  }
}

/**
 * The same SQLite FULL commit loop on the same run directory, mounted in a container and then on this host (through the
 * package's wrapper and sudo, at a mount root under /mnt/pda/<fleet>), alternating, so the container's own cost shows.
 */
async function phaseLatency() {
  const { spawnSync } = await import("node:child_process");
  const { ARCHIL_SCOPED } = await import("../../src/claim.ts");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const id = `${FLEET}-lat-${stamp}`;
  const hostMp = `${MOUNT_ROOT}/host/runs/${id}`;
  const rounds = Number(process.env.PDA_DOCKER_LAT_ROUNDS ?? 3);
  await makeRunDir(id, "probe: commit latency, container against host", 0);
  const result: Record<string, unknown> = { run: id, rounds: [] };
  const scriptDir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "lat-"));
  const script = join(scriptDir, "lat.cjs");
  writeFileSync(script, LATENCY.replace('const dir = process.argv[1];', 'const dir = process.argv[2];'));
  try {
    const tok = await mint("lat");
    tokens.push(tok.identifier);
    const c = start("lat", ["--device", "/dev/fuse", "--cap-add", "SYS_ADMIN", "--security-opt", "apparmor=unconfined"], "probe: commit latency in a container");
    for (let i = 1; i <= rounds; i++) {
      const m = mountIn(c, id, tok.token);
      if (m.mounted !== "fuse.archil") throw new Error(`container mount failed: ${m.tail}`);
      const lc = exec(c, ["node", "-e", LATENCY, `${MOUNT_ROOT}/runs/${id}`], { timeoutMs: 180_000 });
      sh(c, `archil unmount ${MOUNT_ROOT}/runs/${id}`);
      spawnSync("sudo", ["-n", "mkdir", "-p", hostMp]);
      const hm = spawnSync("sudo", ["-n", ARCHIL_SCOPED, "mount", `${scratchDiskId()}:/runs/${id}`, hostMp, "--region", REGION], { input: `${tok.token}\n`, encoding: "utf8", timeout: 120_000 });
      if (hm.status !== 0) throw new Error(`host mount failed: ${tail((hm.stderr ?? "").split(tok.token).join("<token>"))}`);
      const lh = spawnSync("sudo", ["-n", "node", script, hostMp], { encoding: "utf8", timeout: 180_000 });
      const hu = spawnSync("sudo", ["-n", "/usr/bin/archil", "unmount", hostMp], { encoding: "utf8", timeout: 120_000 });
      const stillMounted = readFileSync("/proc/mounts", "utf8").includes(` ${hostMp} `);
      (result.rounds as unknown[]).push({
        round: i,
        container: { mountMs: m.ms, ...(lc.status === 0 ? JSON.parse(lc.stdout.trim()) : { error: tail(lc.stderr) }) },
        host: { mount: hm.status, ...(lh.status === 0 ? JSON.parse(lh.stdout.trim()) : { error: tail(lh.stderr ?? "") }), unmount: hu.status, stillMounted },
      });
    }
  } finally {
    for (const name of containers) removeContainer(name);
    if (readFileSync("/proc/mounts", "utf8").includes(` ${hostMp} `)) spawnSync("sudo", ["-n", "fusermount", "-u", hostMp]);
    spawnSync("sudo", ["-n", "rmdir", hostMp]);
    for (const t of tokens) await unmint(t).catch(() => {});
    await revokeAll(id).catch(() => 0);
    result.hostMountsAtEnd = readFileSync("/proc/mounts", "utf8").split("\n").filter((l) => l.includes(id));
    result.cleanup = await deletePrefix(`runs/${id}/`).catch((e: unknown) => ({ error: String(e) }));
    rmSync(scriptDir, { recursive: true, force: true });
    record("latency", result);
    console.log(JSON.stringify(result, null, 2));
  }
}

const phase = process.argv[2] ?? "mount";
if (phase === "mount") await phaseMount();
else if (phase === "drain") await phaseDrain();
else if (phase === "latency") await phaseLatency();
else throw new Error(`unknown phase ${phase}`);
process.exit(0);
