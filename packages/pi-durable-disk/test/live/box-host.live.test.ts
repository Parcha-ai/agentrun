// boxHost on Modal's VM, end to end: the instance runs as ROOT under transport's launcher with `toolsUser: "pda"`, mounts
// the scratch disk through FUSE (nosuid,nodev), and every agent command runs as pda with no capabilities. The image is
// built here from this checkout's own package (never a published one), with every setuid/setgid bit and file capability
// stripped. Run A is killed with its VM mid-run; B, a new VM with a new token, resumes with every acknowledged tick and
// completes. While A runs, the test checks from inside the box (as root, through Modal's exec):
//   - the tools process (the e2e app's `sleep 600`, through disk's own spawn) is uid 1500, CapEff 0, NoNewPrivs 1;
//   - as pda, with the exact confinement disk's spawn uses, opening /proc/<pid>/environ and /proc/<pid>/mem of each token
//     holder (the launcher, the instance, the archil daemon) is refused, and so is a ptrace attach (strace), while an
//     attach to pda's own sleep succeeds (the control: the refusals come from the uid separation, not a blanket ban);
//   - no sudo, no setuid/setgid file, no file capability; the run's mount is fuse.archil with nosuid,nodev; the launcher
//     exported PI_TRANSPORT_TOOLS_USER/UID; the instance holds no PI_TRANSPORT_SECRETS_FD; ptrace_scope as found;
//   - `find` exits 0 on every mount the launcher's tools check scans, the archil mount included;
//   - the token at rest: a scan as root of /root, /home, /etc, /var, /tmp and /run (binary files too) and the journal,
//     with the token and a planted non-secret canary on the scanner's stdin. Each tree's canary must be found (a vacuous
//     scan fails); the token's count must be 0. Only counts are printed.
// Every sandbox, image, token and run directory is in the ledger before the call that makes it returns, and is removed in
// `after`, also on failure.
//   PDA_LIVE_MODAL_BOX=1 PDA_LIVE_DISK=dsk-... with-archil -- with-modal -- node --test test/live/box-host.live.test.ts
//   (Node 22.19 or later; `npm install --no-save modal@0.11.0` for the SDK; about $0.30, under $2)
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { modalBoxes, type ModalSdk } from "@parcha/pi-transport/box/modal";
import { boxHost } from "../../src/box-host.ts";
import { findDelegations, removeMountToken, type ControlApi, type RunRef } from "../../src/claim.ts";
import { ensureRunning, readRunStatus, type EnsureOptions, type EnsureResult, type HostHandle } from "../../src/supervise.ts";
import { KEY_ENV, REGION, scratchDisk, scratchDiskId } from "./_archil.ts";
import { statePath } from "./_paths.ts";
import { APP_OUT, ARCHIL_SHA256, ARCHIL_URL, ARCHIL_WRAPPER, deletePrefix, NODE, NODE_SHA256, NODE_URL, PACKAGE_DIR, PACKAGE_INSTALL, PDA_ID, packageTarball } from "./_p9.ts";

const LIVE = process.env.PDA_LIVE_MODAL_BOX === "1" && Boolean(process.env.MODAL_TOKEN_ID) && Boolean(process.env.MODAL_TOKEN_SECRET) && Boolean(process.env[KEY_ENV]) && Boolean(process.env.PDA_LIVE_DISK);
const APP = process.env.PDA_MODAL_APP ?? "pda-live-k2";
const LEDGER = statePath("PDA_K2_STATE", "K2-SMOKE-STATE.jsonl");
const RESULTS = statePath("PDA_K2_RESULTS", "K2-SMOKE-RESULTS.json");
const MOUNT_ROOT = "/mnt/archil";
const APP_MODULE = `${PACKAGE_DIR}/test/fixtures/e2e-app.ts`;
const CLI = `${PACKAGE_DIR}/dist/cli.js`;
/** Each incarnation stops after this long, marks the run done and exits 0: long enough that A is killed before. */
const RUN_MS = 180_000;
/** disk's own confinement of an agent command under --run-as (src/env.ts), as pda. */
const AS_TOOL = `setpriv --reuid=${PDA_ID} --regid=${PDA_ID} --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs --`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, unknown> = { at: new Date().toISOString() };
const tokens: string[] = [];
const sandboxes: { id: string; made: number; terminate: () => Promise<void> }[] = [];
let runId = "";

/** Identifiers only, appended before the call that makes the thing returns. */
const ledger = (op: "open" | "close", kind: string, id: string, note = "") => {
  mkdirSync(dirname(LEDGER), { recursive: true });
  appendFileSync(LEDGER, `${JSON.stringify({ t: Date.now(), op, kind, id, note })}\n`);
};

// The SDK surface this file uses beyond pi-transport's ModalSdk.
type Proc = { stdin: { writeText(t: string): Promise<void>; close(): Promise<void> }; stdout: { readText(): Promise<string> }; stderr: { readText(): Promise<string> }; wait(): Promise<number> };
type Sandbox = {
  sandboxId: string;
  filesystem: { writeBytes(data: Uint8Array, path: string): Promise<void> };
  exec(command: string[], params?: Record<string, unknown>): Promise<Proc>;
  snapshotFilesystem(): Promise<{ imageId: string }>;
  terminate(): Promise<void>;
};
type Modal = {
  apps: ModalSdk["apps"];
  images: { fromRegistry(tag: string): { dockerfileCommands(c: string[]): unknown }; fromId(id: string): Promise<unknown> };
  sandboxes: {
    create(app: { appId: string }, image: unknown, params: Record<string, unknown>): Promise<Sandbox>;
    fromId(id: string): Promise<Sandbox>;
    list(params: { appId: string; tags: Record<string, string> }): AsyncIterable<unknown>;
  };
};

/** A script run as root in a box; its stdout, or a throw with the tail of stderr on a non-zero exit. */
async function root(box: Sandbox, script: string, stdin?: string, what = "a script"): Promise<string> {
  const p = await box.exec(["bash", "-c", script]);
  if (stdin !== undefined) await p.stdin.writeText(stdin);
  await p.stdin.close();
  const [out, err, code] = await Promise.all([p.stdout.readText(), p.stderr.readText(), p.wait()]);
  if (code !== 0) throw new Error(`${what} exited ${code}: ${err.trim().split("\n").slice(-4).join(" | ").slice(0, 600)}`);
  return out;
}

// ---- the image: ubuntu 24.04, Node and archil by sha256, pda without sudo, this checkout's package, nothing setuid ----

const SYSTEM = [
  "RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils util-linux libcap2-bin strace procps >/dev/null && rm -rf /var/lib/apt/lists/*",
  `RUN set -eu; cd /tmp; curl -fsSLo node.tar.xz ${NODE_URL}; echo "${NODE_SHA256}  node.tar.xz" | sha256sum -c - >/dev/null; install -d -m 0755 /opt/node24; tar -xJf node.tar.xz -C /opt/node24 --strip-components=1 --no-same-owner; chmod -R a+rX,go-w /opt/node24; rm -f node.tar.xz`,
  `RUN set -eu; cd /tmp; curl -fsSLo archil.deb ${ARCHIL_URL}; echo "${ARCHIL_SHA256}  archil.deb" | sha256sum -c - >/dev/null; apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends libfuse2t64 /tmp/archil.deb >/dev/null; rm -rf /var/lib/apt/lists/* /tmp/archil.deb`,
  `RUN groupadd --gid ${PDA_ID} pda && useradd --uid ${PDA_ID} --gid ${PDA_ID} --create-home --shell /bin/bash pda`,
];

/** In the prep box, as root: the package, the wrapper, the directories; then strip and assert what the launcher checks. */
const PREPARE = String.raw`
set -euo pipefail
install -d -m 0755 ${PACKAGE_DIR}
tar -xzf /tmp/pda-pkg.tar.gz -C ${PACKAGE_DIR} --no-same-owner
rm -f /tmp/pda-pkg.tar.gz
env PATH=/opt/node24/bin:/usr/bin:/bin HOME=/root ${PACKAGE_INSTALL.join(" ")} --prefix ${PACKAGE_DIR} >/dev/null
rm -rf /root/.npm
chown -R root:root ${PACKAGE_DIR}
chmod -R a+rX,go-w ${PACKAGE_DIR}
install -o root -g root -m 0755 ${PACKAGE_DIR}/bin/archil-scoped ${ARCHIL_WRAPPER}
install -d -m 0755 ${MOUNT_ROOT} ${APP_OUT}
find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod ug-s {} +
find / -xdev -type f -print0 | xargs -0 -r getcap 2>/dev/null | awk '{print $1}' | while read -r f; do setcap -r "$f"; done
[ -z "$(find / -xdev -type f -perm /6000 2>/dev/null)" ]
[ -z "$(find / -xdev -type f -print0 | xargs -0 -r getcap 2>/dev/null)" ]
! command -v sudo >/dev/null
[ ! -d /etc/sudoers.d ] || [ -z "$(ls -A /etc/sudoers.d)" ]
[ "$(id -u pda):$(id -g pda)" = "${PDA_ID}:${PDA_ID}" ]
command -v setpriv >/dev/null && command -v setcap >/dev/null && command -v getcap >/dev/null && command -v strace >/dev/null
printf 'archil\t%s\n' "$(archil --version 2>&1 | head -1)"
printf 'node\t%s\n' "$(${NODE} --version)"
`;

// ---- what the test asks inside a running box (as root; never a secret on an argv) -------------------------------------

/** One JSON object: the processes, the tools process, the refusals as pda, the box's privileges and the mount. */
const PROBE = (run: string) => String.raw`
set -u
# The instance by its argv (node, the CLI, "run"), never by a substring: this script's own argv holds the same text.
inst=""; for d in /proc/[0-9]*; do a=$(tr '\0' '\n' < $d/cmdline 2>/dev/null | sed -n 2,3p | tr '\n' ' '); [ "$a" = "${CLI} run " ] && { inst=$(basename $d); break; }; done
field() { awk -v k="$2:" '$1==k{print $2}' /proc/$1/status 2>/dev/null; }
launcher=$(field "$inst" PPid)
archild=$(pgrep -x archil | head -1)
tool=$(pgrep -u ${PDA_ID} -x sleep | head -1)
names() { tr '\0' '\n' < /proc/$1/environ 2>/dev/null | cut -d= -f1 | grep -E '^PI_TRANSPORT_' | sort | tr '\n' ' '; }
as_pda() { ${AS_TOOL} /bin/sh -c "$1" 2>&1; }
refused() {
  e=$(as_pda "cat /proc/$1/environ >/dev/null" | tail -1); m=$(as_pda "head -c1 /proc/$1/mem >/dev/null" | tail -1)
  t=$(as_pda "timeout 3 strace -qq -e trace=none -p $1" | grep -oE 'Operation not permitted|Permission denied|attached' | head -1)
  printf '{"environ":"%s","mem":"%s","ptrace":"%s"}' "$(echo "$e" | grep -oE 'Permission denied|Operation not permitted' | head -1)" "$(echo "$m" | grep -oE 'Permission denied|Operation not permitted|Input/output error' | head -1)" "$t"
}
control=$(as_pda "timeout 2 strace -e trace=none -p $tool" | grep -oE 'attached|Operation not permitted' | head -1)
mountline=$(awk -v mp="${MOUNT_ROOT}/runs/${run}" '$5==mp{print $6" "$(NF-2)}' /proc/$inst/mountinfo 2>/dev/null | head -1)
finds=""; while read -r mp; do find "$mp" -xdev -type f -perm /6000 >/dev/null 2>&1; finds="$finds$mp=$? "; done < <(awk '{print $5}' /proc/self/mountinfo | grep -vE '^/(proc|sys|dev)(/|$)')
cat <<EOF
{"pids":{"instance":"$inst","launcher":"$launcher","archil":"$archild","tool":"$tool"},
 "launcherArgv0":"$(tr '\0' '\n' < /proc/$launcher/cmdline 2>/dev/null | head -1)",
 "uids":{"instance":"$(field "$inst" Uid | head -1)","launcher":"$(field "$launcher" Uid | head -1)","archil":"$(field "$archild" Uid | head -1)"},
 "tool":{"uid":"$(field "$tool" Uid)","gid":"$(field "$tool" Gid)","capEff":"$(field "$tool" CapEff)","capBnd":"$(field "$tool" CapBnd)","noNewPrivs":"$(field "$tool" NoNewPrivs)","fds":"$(ls /proc/$tool/fd 2>/dev/null | tr '\n' ' ')","transportVars":"$(names "$tool")"},
 "asPda":{"instance":$(refused "$inst"),"launcher":$(refused "$launcher"),"archil":$(refused "$archild"),"controlAttachOwnSleep":"$control"},
 "instanceTransportVars":"$(names "$inst")",
 "toolsUid":"$(tr '\0' '\n' < /proc/$inst/environ | grep -E '^PI_TRANSPORT_TOOLS_UID=' | cut -d= -f2)",
 "ptraceScope":"$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo absent)",
 "sudo":"$(command -v sudo || echo absent)",
 "setuidFiles":$(find / -xdev -type f -perm /6000 2>/dev/null | wc -l),
 "fileCaps":$(find / -xdev -type f -print0 2>/dev/null | xargs -0 -r getcap 2>/dev/null | wc -l),
 "runMount":"$mountline",
 "findExits":"$finds"}
EOF
`;

/** As root: a token and canary scan of the trees and the journal. stdin: the token, then the canary, one per line. */
const SCAN = String.raw`
const { readFileSync, writeFileSync, rmSync, lstatSync, readdirSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const [token, canary] = readFileSync(0, "utf8").split("\n");
const T = Buffer.from(token), C = Buffer.from(canary);
const count = (buf, needle) => { let n = 0, i = 0; while ((i = buf.indexOf(needle, i)) !== -1) { n++; i += needle.length; } return n; };
const out = {};
for (const tree of ["/root", "/home", "/etc", "/var", "/tmp", "/run"]) {
  const plant = tree + "/.k2-canary-" + process.pid;
  writeFileSync(plant, Buffer.concat([Buffer.from([0, 1, 2]), C, Buffer.from([0])]), { mode: 0o600 });
  const r = { files: 0, token: 0, canary: 0, skipped: 0 };
  const walk = (dir) => {
    let names; try { names = readdirSync(dir); } catch { r.skipped++; return; }
    for (const name of names) {
      const p = dir + "/" + name; let st; try { st = lstatSync(p); } catch { r.skipped++; continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) { if (st.size > 256 << 20) { r.skipped++; continue; } let b; try { b = readFileSync(p); } catch { r.skipped++; continue; } r.files++; r.token += count(b, T); r.canary += count(b, C); }
    }
  };
  walk(tree);
  rmSync(plant, { force: true });
  out[tree] = r;
}
const j = spawnSync("journalctl", ["-o", "export", "--no-pager"], { maxBuffer: 1 << 30 });
out.journal = j.error ? { absent: true } : { token: count(j.stdout, T), bytes: j.stdout.length };
process.stdout.write(JSON.stringify(out));
`;

after(async () => {
  if (!LIVE) return;
  const cleanup: Record<string, unknown> = {};
  for (const s of sandboxes) {
    await s.terminate().then(() => ledger("close", "sandbox", s.id), (e: unknown) => ((cleanup.terminateErrors ??= []) as unknown[]).push(String(e)));
  }
  results.sandboxSeconds = sandboxes.map((s) => ({ id: s.id, seconds: Math.round((Date.now() - s.made) / 1000) }));
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  for (const t of tokens) await removeMountToken(control, t).then(() => ledger("close", "token", t), (e: unknown) => ((cleanup.tokenErrors ??= []) as unknown[]).push(String(e)));
  if (runId) {
    for (const d of (await control.listDelegations()).filter((d) => d.path?.replace(/^\/+/, "").startsWith(`runs/${runId}`))) {
      await control.revokeDelegation({ clientId: d.clientId, inodeId: d.inodeId }).catch(() => {});
    }
    cleanup.prefix = await deletePrefix(disk as never, `runs/${runId}/`).catch((e: unknown) => ({ error: (e as Error).message }));
    ledger("close", "subdir", `runs/${runId}/`, JSON.stringify(cleanup.prefix));
  }
  results.cleanup = cleanup;
  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`);
});

test("boxHost on Modal's VM: root instance with toolsUser pda, conditions 4 and 5 live, kill A and resume on B with every acknowledged tick", { skip: !LIVE, timeout: 25 * 60_000 }, async () => {
  const { ModalClient } = (await import("modal" as string)) as { ModalClient: new () => Modal };
  const modal = new ModalClient();
  const stamp = Date.now().toString(36);
  const tags = { "pda-k2": stamp };
  const made = (box: Sandbox, name: string) => {
    ledger("open", "sandbox", box.sandboxId, name);
    sandboxes.push({ id: box.sandboxId, made: Date.now(), terminate: () => box.terminate() });
    return box;
  };
  const app = await modal.apps.fromName(APP, { createIfMissing: true });

  // The image, from a prep box: this checkout's package installed, then stripped and asserted; a filesystem snapshot.
  const t0 = Date.now();
  ledger("open", "sandbox", `${APP}-prep-${stamp}`, "create");
  const prep = made(await modal.sandboxes.create(app, modal.images.fromRegistry("ubuntu:24.04").dockerfileCommands(SYSTEM), { name: `${APP}-prep-${stamp}`, tags, timeoutMs: 20 * 60_000, cpu: 2, memoryMiB: 4096 }), "prep");
  ledger("close", "sandbox", `${APP}-prep-${stamp}`, `recorded as ${prep.sandboxId}`);
  await prep.filesystem.writeBytes(packageTarball(), "/tmp/pda-pkg.tar.gz");
  const prepared = await root(prep, PREPARE, undefined, "preparing the image");
  const image = await prep.snapshotFilesystem();
  ledger("open", "image", image.imageId, "snapshot of the prep box");
  await prep.terminate();
  ledger("close", "sandbox", prep.sandboxId, "prep done");
  sandboxes.splice(sandboxes.findIndex((s) => s.id === prep.sandboxId), 1);
  results.image = { id: image.imageId, buildMs: Date.now() - t0, versions: Object.fromEntries(prepared.trim().split("\n").map((l) => l.split("\t"))) };

  // The provider records each VM in the ledger the moment the SDK returns it.
  const sdk: ModalSdk = {
    apps: modal.apps,
    images: modal.images as unknown as ModalSdk["images"],
    sandboxes: {
      create: async (a, i, params) => {
        ledger("open", "sandbox", String((params as { name?: string }).name ?? "unnamed"), "create");
        const box = made(await modal.sandboxes.create(a, i, params as unknown as Record<string, unknown>), "vm");
        return box as never;
      },
      fromId: (id) => modal.sandboxes.fromId(id) as never,
      list: (p) => modal.sandboxes.list(p) as never,
    },
  };
  const host = boxHost({
    provider: modalBoxes(sdk, { appName: APP, image: image.imageId }),
    spec: { maxLifetimeMs: 20 * 60_000, cpus: 2, memoryMb: 4096, labels: tags },
    app: APP_MODULE,
    command: [NODE, CLI],
    mountRoot: MOUNT_ROOT,
    archil: ARCHIL_WRAPPER,
    runArgs: ["--heartbeat-ms=1000", "--lease-expiry-ms=600000", "--lease-margin-ms=0"],
    runAs: "pda",
    env: { PDA_TEST_OUT: APP_OUT, PDA_TEST_RUN_MS: String(RUN_MS) },
    startTimeoutMs: 300_000,
    stopGraceMs: 10_000,
  });
  // The test keeps the token a start was given, in memory only, for the at-rest scan; boxHost never sees the wrapper.
  let lastToken = "";
  const driver: typeof host = { ...host, start: (r, t, at) => ((lastToken = t), host.start(r, t, at)) };
  const disk = await scratchDisk();
  const control = disk as unknown as ControlApi;
  runId = `k2-live-${stamp}`;
  const ref: RunRef = { disk: scratchDiskId(), region: REGION, id: runId };
  const opts: EnsureOptions = { control: disk as never, leaseExpiryMs: 6_000, stonithTimeoutMs: 30_000, tokenTtl: "1h", tokenPrefix: "pda-k2-", create: { uid: PDA_ID, gid: PDA_ID } };
  const boxOf = (h: HostHandle) => modal.sandboxes.fromId(String(h.box));
  type AppEvent = { ev: string; generation: number; n?: number; resumedFrom?: number; duplicates?: number };
  const events = async (h: HostHandle): Promise<AppEvent[]> => {
    const out = await root(await boxOf(h), `cat ${APP_OUT}/${runId}.jsonl 2>/dev/null || true`).catch(() => "");
    return out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as AppEvent);
  };
  const acked = (evs: AppEvent[]) => evs.filter((e) => e.ev === "tick").map((e) => e.n!);
  const waitFor = async <T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1_000): Promise<T> => {
    for (const s = Date.now(); Date.now() - s < timeoutMs; await sleep(everyMs)) {
      const v = await fn();
      if (v) return v;
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const started = async (what: string) => {
    const s = Date.now();
    const r = await waitFor(what, async () => {
      const x = await ensureRunning(ref, driver, opts);
      if (x.action !== "started") return null;
      tokens.push(x.token.identifier);
      ledger("open", "token", x.token.identifier, what);
      if (x.created) ledger("open", "subdir", `runs/${runId}/`, "created by ensureRunning");
      return x as Extract<EnsureResult, { action: "started" }>;
    }, 360_000, 2_000);
    return { r, decidedMs: Date.now() - s };
  };

  // A: start, tick, then everything the conditions ask, from inside the box.
  const a = await started("start on A");
  const hA = a.r.handle;
  const tokenOfA = lastToken;
  results.startA = { reason: a.r.reason, decidedMs: a.decidedMs, receipt: await driver.box(hA) };
  assert.equal(await driver.status(hA), "running");
  await waitFor("A to commit 8 ticks", async () => acked(await events(hA)).length >= 8, 240_000, 2_000);
  const boxA = await boxOf(hA);
  const probe = JSON.parse(await root(boxA, PROBE(runId), undefined, "the probe")) as Record<string, any>;
  results.probe = probe;
  const canary = randomBytes(24).toString("hex");
  // The token reaches the scanner on its stdin only; the scanner prints counts.
  const secret = tokenOfA;
  assert.ok(secret.length > 0, "A's mount token is in hand for the scan");
  const scan = JSON.parse(await root(boxA, `${NODE} -e '${SCAN.replace(/'/g, "'\\''")}'`, `${secret}\n${canary}\n`, "the at-rest scan")) as Record<string, any>;
  results.scan = scan;

  // Condition 4: the tools process is pda with nothing to escalate with, and every token holder refuses it.
  assert.equal(probe.uids.instance.split(/\s+/)[0], "0", "the instance runs as root");
  assert.ok(probe.tool.uid.startsWith(String(PDA_ID)), `the tools process is uid ${PDA_ID}: ${probe.tool.uid}`);
  assert.equal(probe.tool.capEff, "0000000000000000", "the tools process has no effective capability");
  assert.equal(probe.tool.capBnd, "0000000000000000", "nor any in its bounding set");
  assert.equal(probe.tool.noNewPrivs, "1");
  for (const holder of ["instance", "launcher", "archil"]) {
    const r = probe.asPda[holder];
    assert.ok(r.environ !== "", `pda opening ${holder}'s environ is refused: ${JSON.stringify(r)}`);
    assert.ok(r.mem === "Permission denied" || r.mem === "Operation not permitted", `pda opening ${holder}'s mem is refused: ${JSON.stringify(r)}`);
    assert.equal(r.ptrace, "Operation not permitted", `pda attaching to ${holder} is EPERM: ${JSON.stringify(r)}`);
  }
  // The control holds only where Yama allows a same-uid attach (absent, or 0); with Yama 1 pda's strace is no ancestor.
  if (probe.ptraceScope === "absent" || probe.ptraceScope === "0") {
    assert.equal(probe.asPda.controlAttachOwnSleep, "attached", "the control: pda can attach to its own process, so the refusals are the uid separation");
  }
  // Condition 3, live: nothing pda could escalate with.
  assert.equal(probe.sudo, "absent");
  assert.equal(probe.setuidFiles, 0);
  assert.equal(probe.fileCaps, 0);
  // The launcher's tools user, the instance's frame, the mount.
  assert.match(probe.instanceTransportVars, /PI_TRANSPORT_TOOLS_UID PI_TRANSPORT_TOOLS_USER/);
  assert.doesNotMatch(probe.instanceTransportVars, /PI_TRANSPORT_SECRETS_FD/, "the instance dropped the secrets descriptor's name");
  assert.equal(probe.toolsUid, String(PDA_ID));
  assert.match(probe.runMount, /^\S*\bnosuid\b\S*\bnodev\b\S* fuse\.archil$|^\S*\bnodev\b\S*\bnosuid\b\S* fuse\.archil$/, `the run's mount: ${probe.runMount}`);
  for (const pair of String(probe.findExits).trim().split(/\s+/)) assert.match(pair, /=0$/, `find misfires on a scanned mount: ${pair}`);
  // The token at rest: every canary found, the token nowhere.
  for (const tree of ["/root", "/home", "/etc", "/var", "/tmp", "/run"]) {
    assert.ok(scan[tree].canary >= 1, `the scan of ${tree} found its canary (not vacuous): ${JSON.stringify(scan[tree])}`);
    assert.equal(scan[tree].token, 0, `the token at rest in ${tree}`);
  }
  if (!scan.journal.absent) assert.equal(scan.journal.token, 0, "the token in the journal");

  // Kill A with its VM; B is a new VM with a new token, and resumes with every acknowledged tick.
  const ackedA = acked(await events(hA));
  const tKill = Date.now();
  await driver.kill(hA);
  ledger("close", "sandbox", String(hA.box), "killed");
  const b = await started("takeover on B");
  const hB = b.r.handle;
  assert.notEqual(hB.box, hA.box, "a new VM, never a relaunch on A");
  const openedB = await waitFor("B to open and tick", async () => {
    const evs = await events(hB);
    return evs.some((e) => e.ev === "tick") ? evs : null;
  }, 300_000, 2_000);
  const oB = openedB.find((e) => e.ev === "opened")!;
  results.takeoverB = { reason: b.r.reason, decidedMs: b.decidedMs, killToFirstTickMs: Date.now() - tKill, ackedOnA: ackedA.length, lastAckedOnA: Math.max(...ackedA), opened: oB };
  assert.equal(oB.duplicates, 0, "no tick committed twice");
  assert.ok(oB.resumedFrom! >= Math.max(...ackedA), `B resumed from ${oB.resumedFrom}, A had acknowledged ${Math.max(...ackedA)}`);

  // B completes: the app marks the run done and exits 0, so boxHost reports stopped.
  await waitFor("B to complete", async () => (await driver.status(hB)) === "stopped", RUN_MS + 180_000, 5_000);
  const record = await readRunStatus(control as never, runId);
  results.end = { status: record?.status, delegations: (await findDelegations(control, runId)).length };
  assert.equal(record?.status, "done");
  await driver.stop(hB);
});
