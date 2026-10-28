// bin/archil-scoped, run for real with its archil, systemd-run, cgroup file and mount table pointed at stubs: root runs
// archil only in the shapes the claim uses, each with exact arguments, and refuses anything else with exit 2 before
// archil runs. `mount` takes its token as one line on stdin and puts it only in the environment of the exec; no token
// refuses the mount; the other verbs leave stdin unread. No Archil, no root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIL_SCOPED } from "../src/claim.ts";
import { disposeAfter } from "./_dispose.ts";

const TOKEN = `tok-${"5".repeat(40)}`;
const REGION = "aws-us-east-1";

/**
 * The wrapper over a real <root>/runs/r1 (listed as a fuse.archil mount) and an unlisted <root>/runs/r2. `rootLink`:
 * the root is reached through a link; `mpLink`: runs/r1 is a link to a directory elsewhere.
 */
function wrapper(cgroup: string, opts: { rootLink?: boolean; mpLink?: boolean; untrusted?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pda-scoped-"));
  const out = join(dir, "seen");
  const real = join(dir, "mnt");
  mkdirSync(join(real, "runs", "r2"), { recursive: true });
  if (opts.mpLink) {
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(real, "runs", "r1"));
  } else mkdirSync(join(real, "runs", "r1"));
  if (opts.rootLink) symlinkSync(real, join(dir, "link"));
  for (const d of [real, join(real, "runs")]) chmodSync(d, 0o755);
  const root = opts.rootLink ? join(dir, "link") : real;
  const mp = join(root, "runs", "r1");
  const stub = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  // The stub archil records its argv, the token it was given, its environment's names and any stdin left for it.
  const archil = stub("archil", `{ echo "argv=$*"; echo "token=\${ARCHIL_MOUNT_TOKEN-<unset>}"; echo "env=$(env | cut -d= -f1 | sort | tr '\\n' ' ')"; IFS= read -r rest || true; echo "stdin=$rest"; } > '${out}'`);
  // The stub systemd-run records its own argv, then runs the command after "--" as a real --scope would.
  const systemdRun = stub("systemd-run", `echo "scope=$*" > '${out}.scope'; while [ "$1" != -- ]; do shift; done; shift; exec "$@"`);
  const cgroupFile = join(dir, "cgroup");
  writeFileSync(cgroupFile, `${cgroup}\n`);
  const mounts = join(dir, "mounts");
  writeFileSync(mounts, `dsk-1:/runs/r1[${REGION}] ${mp} fuse.archil rw,allow_other 0 0\nproc /proc proc rw 0 0\n`);
  const source = readFileSync(ARCHIL_SCOPED, "utf8");
  const script = source
    .replace("ARCHIL=/usr/bin/archil", `ARCHIL='${archil}'`)
    .replace("MOUNTS=/proc/self/mounts", `MOUNTS='${mounts}'`)
    // This user stands in for root as the owner of the mount root, unless the test wants a root that is not root's.
    .replace("TRUST=0", `TRUST=${opts.untrusted ? 0 : process.getuid!()}`)
    .replace("/usr/bin/systemd-run", systemdRun)
    .replace("/proc/self/cgroup", cgroupFile);
  assert.notEqual(script, source);
  const path = stub("archil-scoped", script.replace(/^#!\/bin\/sh\n/, ""));
  const run = (args: string[], input: string, env: Record<string, string> = {}) => {
    const r = spawnSync(path, args, { input, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", ...env } });
    const seen = existsSync(out) ? Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) : null;
    const scope = existsSync(`${out}.scope`) ? readFileSync(`${out}.scope`, "utf8").trim() : null;
    rmSync(out, { force: true });
    rmSync(`${out}.scope`, { force: true });
    return { status: r.status, stderr: r.stderr, seen, scope };
  };
  return { run, archil, dir, real, root, mp, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
}

const OUTSIDE = "0::/user.slice/user-1000.slice/session-3.scope";
const SERVICE = "0::/system.slice/pda-r1.service";
const mountOf = (mp: string, target = "dsk-1:/runs/r1") => ["mount", target, mp, "--region", REGION];

test("mount takes the token from the first line of stdin and gives it only to archil", () => {
  const w = disposeAfter(wrapper(OUTSIDE));
  for (const [input, expect] of [[`${TOKEN}\n`, TOKEN], [TOKEN, TOKEN], [`${TOKEN}\nsecond line\n`, TOKEN]] as const) {
    const r = w.run(mountOf(w.mp), input);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.seen?.argv, `mount dsk-1:/runs/r1 ${w.mp} --region ${REGION}`);
    assert.equal(r.seen?.token, expect);
    assert.ok(!r.seen?.argv.includes(TOKEN));
    assert.equal(r.scope, null, "outside a system service there is no scope");
  }
});

test("mount refuses no token: empty stdin or an empty first line, and archil never runs", () => {
  const w = disposeAfter(wrapper(OUTSIDE));
  for (const input of ["", "\n", "\nlater\n"]) {
    const r = w.run(mountOf(w.mp), input);
    assert.equal(r.status, 2, JSON.stringify(input));
    assert.match(r.stderr, /no mount token on stdin/);
    assert.equal(r.seen, null);
  }
});

test("inside a system service, mount runs in its own scope and the token still reaches only archil", () => {
  const w = disposeAfter(wrapper(SERVICE));
  const r = w.run(mountOf(w.mp), `${TOKEN}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.scope ?? "", new RegExp(`^scope=--scope --quiet --collect --unit=pda-r1-fuse-\\d+ -- ${w.archil} mount dsk-1:/runs/r1 ${w.mp} --region ${REGION}$`));
  assert.ok(!r.scope?.includes(TOKEN), "the token is not an argument of systemd-run");
  assert.equal(r.seen?.token, TOKEN);
});

test("each shape the claim uses reaches archil with exactly its arguments; only mount reads stdin", () => {
  const w = disposeAfter(wrapper(OUTSIDE));
  const mounts: string[][] = [mountOf(w.mp), ["mount", "--force", "dsk-1:/runs/r1", w.mp, "--region", REGION], mountOf(w.mp, "dsk-1:/data/set.v2")];
  for (const args of mounts) {
    const r = w.run(args, `${TOKEN}\n`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.seen?.argv, args.join(" "));
    assert.equal(r.seen?.token, TOKEN);
  }
  for (const args of [["unmount", w.mp], ["checkin", w.mp], ["sync", w.mp], ["delegations", "--json", w.mp]]) {
    const r = w.run(args, "left-for-archil\n");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.seen?.argv, args.join(" "));
    assert.equal(r.seen?.token, "<unset>");
    assert.equal(r.seen?.stdin, "left-for-archil");
  }
});

// Each refused before archil runs, with exit 2. `args` is built over the rig's paths. The rig's stub mount table lists
// runs/r1 whatever it is, so the wrapper's own checks are what refuse.
type Rig = { root: string; mp: string };
const REFUSED: [string, (w: Rig) => string[], { rootLink?: boolean; mpLink?: boolean }?][] = [
  ["a mountpoint at /etc", () => mountOf("/etc")],
  ["a mountpoint at /usr/local/bin", () => mountOf("/usr/local/bin")],
  ["unmount /usr", () => ["unmount", "/usr"]],
  ["a ../ in the mountpoint", (w) => mountOf(`${w.root}/runs/r1/../../../etc`)],
  ["a ../ in the disk path", (w) => mountOf(w.mp, "dsk-1:/runs/../etc")],
  ["a disk path with an absolute second root", (w) => mountOf(w.mp, "dsk-1://etc")],
  ["a symlinked root", (w) => mountOf(w.mp), { rootLink: true }],
  ["a symlinked mountpoint", (w) => mountOf(w.mp), { mpLink: true }],
  ["unmount through a symlinked mountpoint", (w) => ["unmount", w.mp], { mpLink: true }],
  ["unmount of a path no archil mount is listed at", (w) => ["unmount", `${w.root}/runs/r2`]],
  ["a missing --region", (w) => ["mount", "dsk-1:/runs/r1", w.mp]],
  ["an extra flag after the region", (w) => [...mountOf(w.mp), "--shared"]],
  ["an extra flag before the target", (w) => ["mount", "--read-only", "dsk-1:/runs/r1", w.mp, "--region", REGION]],
  ["--force after the target", (w) => ["mount", "dsk-1:/runs/r1", "--force", w.mp, "--region", REGION]],
  ["--force at the end", (w) => [...mountOf(w.mp), "--force"]],
  ["an unknown verb", (w) => ["checkout", w.mp]],
  ["no verb", () => []],
  ["delegations without --json", (w) => ["delegations", w.mp]],
  ["checkin with an extra argument", (w) => ["checkin", w.mp, "--all"]],
  ["a bad disk token", (w) => mountOf(w.mp, "dsk-1;id:/runs/r1")],
  ["a bad region token", (w) => ["mount", "dsk-1:/runs/r1", w.mp, "--region", "aws-us-east-1/x"]],
  ["a newline in the mountpoint", (w) => mountOf(`${w.mp}\n/etc`)],
  ["a newline in an unmount's mountpoint", (w) => ["unmount", `${w.mp}\n/usr`]],
];
for (const [name, args, opts] of REFUSED) {
  test(`refused: ${name}`, () => {
    const w = disposeAfter(wrapper(OUTSIDE, opts));
    const r = w.run(args(w), `${TOKEN}\nleft-for-archil\n`);
    assert.equal(r.status, 2, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /^archil-scoped: /m);
    assert.equal(r.seen, null, `archil ran with ${JSON.stringify(r.seen?.argv)}`);
  });
}

// ---- every call the package makes, read from its source, is one the wrapper takes ---------------------------------------

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const MOUNT_ARGV = 'const args = [host.archil, "mount", ...(force ? ["--force"] : []), `${target.disk}:/${path}`, mountpoint, "--region", target.region];';
/** Verbs the wrapper acts on itself; the rest reach archil. */
const OWN = new Set(["prepare", "retire", "stray", "stale"]);

/** Each `archil(host, [...])` in the package's source, as the expressions it passes. */
function callSites(): string[][] {
  const files = readdirSync(SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  const sites: string[][] = [];
  for (const f of files) {
    for (const m of readFileSync(join(SRC, f), "utf8").matchAll(/\barchil\(host, \[([^\]]*)\]/g)) sites.push(m[1].split(", "));
  }
  return sites;
}

test("every archil call in the package's source is one the wrapper takes, with exactly its arguments, and the wrapper takes no other verb", () => {
  const w = disposeAfter(wrapper(OUTSIDE));
  const ids = { SUDO_UID: String(process.getuid!()), SUDO_GID: String(process.getgid!()) };
  const sites = callSites();
  assert.ok(sites.length >= 9, `found ${sites.length} archil(host, [...]) calls`);
  const claim = readFileSync(join(SRC, "claim.ts"), "utf8");
  assert.ok(claim.includes(MOUNT_ARGV), "mount's argv in claim.ts changed: build the new shape here");
  // A call's expressions as the claim fills them: its mountpoint (a fresh one for prepare, the unlisted runs/r2 for the
  // cleanup verbs that need no mount), a tag, and string literals as written. Anything else needs a value here.
  const value = (verb: string, expr: string) => {
    const literal = /^"([^"]*)"$/.exec(expr);
    if (literal) return literal[1];
    if (expr === "mountpoint" || expr === "dir") return verb === "prepare" ? `${w.root}/runs/r3` : verb === "stray" || verb === "stale" ? `${w.root}/runs/r2` : w.mp;
    if (expr === "tag" || expr === "Date.now().toString(36)") return "t1";
    throw new Error(`no value for ${expr} in a call of ${verb}`);
  };
  const calls = sites.map((exprs) => {
    const verb = value("", exprs[0]);
    return [verb, ...exprs.slice(1).map((e) => value(verb, e))];
  });
  calls.push(mountOf(w.mp), ["mount", "--force", "dsk-1:/runs/r1", w.mp, "--region", REGION]);
  for (const args of calls) {
    const r = w.run(args, `${TOKEN}\n`, ids);
    if (OWN.has(args[0])) {
      assert.notEqual(r.status, 2, `${args.join(" ")}: refused: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /refused: /, args.join(" "));
    } else {
      assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
      assert.equal(r.seen?.argv, args.join(" "));
    }
  }
  // The verbs the wrapper's dispatch names are exactly the verbs the package calls.
  const script = readFileSync(ARCHIL_SCOPED, "utf8");
  const dispatch = script.slice(script.indexOf('case "${1:-}" in'), script.indexOf("\nesac", script.indexOf('case "${1:-}" in')));
  const taken = [...dispatch.matchAll(/^ {2}([a-z]+(?: \| [a-z]+)*)\)/gm)].flatMap((m) => m[1].split(" | "));
  assert.deepEqual([...new Set(taken)].sort(), [...new Set(calls.map((c) => c[0]))].sort());
});

// ---- the mount root: root's, so nobody else can swap an entry between a check and archil's use -----------------------

/** Every verb, over the rig's paths, as the claim would call it (the cleanup verbs on the unlisted runs/r2). */
const EVERY_VERB = (w: Rig): string[][] => [
  mountOf(w.mp), ["unmount", w.mp], ["checkin", w.mp], ["sync", w.mp], ["delegations", "--json", w.mp],
  ["prepare", `${w.root}/runs/r3`], ["retire", w.mp, "t1"], ["stray", `${w.root}/runs/r2`, "t1"], ["stale", `${w.root}/runs/r2`],
];

test("every verb refuses a mount root and runs/ that root does not own", () => {
  const w = disposeAfter(wrapper(OUTSIDE, { untrusted: true }));
  for (const args of EVERY_VERB(w)) {
    const r = w.run(args, `${TOKEN}\n`, { SUDO_UID: String(process.getuid!()), SUDO_GID: String(process.getgid!()) });
    assert.equal(r.status, 2, `${args[0]}: exit ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /runs must be owned by root and writable by no one else/, args[0]);
    assert.equal(r.seen, null, `${args[0]}: archil ran`);
  }
  assert.equal(existsSync(join(w.root, "runs", "r3")), false, "prepare made nothing");
});

test("every verb refuses a runs/ or a mount root that group or others may write", () => {
  for (const at of ["runs", "root"] as const) {
    const w = disposeAfter(wrapper(OUTSIDE));
    chmodSync(at === "runs" ? join(w.real, "runs") : w.real, 0o775);
    for (const args of EVERY_VERB(w)) {
      const r = w.run(args, `${TOKEN}\n`, { SUDO_UID: String(process.getuid!()), SUDO_GID: String(process.getgid!()) });
      assert.equal(r.status, 2, `${at}, ${args[0]}: exit ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /must be owned by root and writable by no one else/, `${at}, ${args[0]}`);
      assert.equal(r.seen, null);
    }
  }
});

test("a directory above the mount root that others may write refuses every verb, unless it is sticky", () => {
  const w = disposeAfter(wrapper(OUTSIDE));
  chmodSync(w.dir, 0o777);
  for (const args of EVERY_VERB(w)) {
    const r = w.run(args, `${TOKEN}\n`, { SUDO_UID: String(process.getuid!()), SUDO_GID: String(process.getgid!()) });
    assert.equal(r.status, 2, `${args[0]}: exit ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /above .* must be root's and not writable by others/, args[0]);
  }
  chmodSync(w.dir, 0o1777);
  const r = w.run(mountOf(w.mp), `${TOKEN}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.seen?.argv, mountOf(w.mp).join(" "));
});

test("prepare makes the run's mountpoint, 0755 and owned by the caller sudo names, and leaves an existing one as it is", () => {
  const w = disposeAfter(wrapper(OUTSIDE));
  const ids = { SUDO_UID: String(process.getuid!()), SUDO_GID: String(process.getgid!()) };
  const r3 = join(w.root, "runs", "r3");
  const made = w.run(["prepare", r3], "", ids);
  assert.equal(made.status, 0, made.stderr);
  const st = statSync(r3);
  assert.deepEqual([st.isDirectory(), st.mode & 0o7777, st.uid, st.gid], [true, 0o755, process.getuid!(), process.getgid!()]);
  writeFileSync(join(r3, "kept"), "x");
  const again = w.run(["prepare", r3], "", ids);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(readdirSync(r3), ["kept"], "an existing mountpoint is left as it is");
  assert.equal(made.seen, null, "prepare never runs archil");
});

test("prepare refuses without sudo's caller, over a link or a file, and outside <root>/runs/<run>", () => {
  const w = disposeAfter(wrapper(OUTSIDE));
  const ids = { SUDO_UID: String(process.getuid!()), SUDO_GID: String(process.getgid!()) };
  symlinkSync(join(w.dir, "elsewhere-r4"), join(w.root, "runs", "r4"));
  writeFileSync(join(w.root, "runs", "r5"), "");
  for (const [args, env] of [
    [["prepare", `${w.root}/runs/r3`], {}],
    [["prepare", `${w.root}/runs/r3`], { SUDO_UID: "x1", SUDO_GID: "1" }],
    [["prepare", `${w.root}/runs/r4`], ids],
    [["prepare", `${w.root}/runs/r5`], ids],
    [["prepare", "/etc/r3"], ids],
    [["prepare", `${w.root}/runs/r3`, "extra"], ids],
  ] as [string[], Record<string, string>][]) {
    const r = w.run(args, "", env);
    assert.equal(r.status, 2, `${args.join(" ")} ${JSON.stringify(env)}: exit ${r.status}: ${r.stderr}`);
  }
  assert.equal(existsSync(join(w.root, "runs", "r3")), false);
  assert.equal(existsSync(join(w.dir, "elsewhere-r4")), false, "nothing was made through the link");
});

// ---- retire: move a mount the kernel will not unmount (Sysbox) aside and kill exactly its daemon ----------------------

/** The wrapper with its mount table, /proc, mount and kill pointed at stubs; `procs` are fake processes (argv). */
function retireRig(procs: Record<string, string[]>, opts: { moveFails?: boolean; killIgnored?: boolean; fstype?: string; owner?: number; rootLink?: boolean; unlisted?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pda-retire-"));
  const real = join(dir, "mnt");
  mkdirSync(join(real, "runs", "r1"), { recursive: true });
  mkdirSync(join(real, "runs", "r2"), { recursive: true });
  for (const d of [real, join(real, "runs")]) chmodSync(d, 0o755);
  if (opts.rootLink) symlinkSync(real, join(dir, "link"));
  const root = opts.rootLink ? join(dir, "link") : real;
  const mp = join(root, "runs", "r1");
  const mounts = join(dir, "mounts");
  const proc = join(dir, "proc");
  const log = join(dir, "log");
  const stub = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const archil = stub("archil", "exit 0");
  const mount = stub("mount", opts.moveFails ? `echo "mount $*" >> '${log}'; exit 32` : `echo "mount $*" >> '${log}'; awk -v s="$2" -v d="$3" '{ if ($2 == s) $2 = d; print }' '${mounts}' > '${mounts}.tmp' && mv '${mounts}.tmp' '${mounts}'`);
  const kill = stub("kill", `echo "kill $*" >> '${log}'; ${opts.killIgnored ? "" : `for p in "$@"; do case "$p" in -*) ;; *) rm -rf '${proc}'/"$p" ;; esac; done`}`);
  const r1 = `dsk-1:/runs/r1[aws-us-east-1] ${mp} ${opts.fstype ?? "fuse.archil"} rw,allow_other 0 0`;
  writeFileSync(mounts, [...(opts.unlisted ? [] : [r1]), `dsk-1:/runs/r2[aws-us-east-1] ${join(root, "runs", "r2")} fuse.archil rw 0 0`, "proc /proc proc rw 0 0"].join("\n") + "\n");
  for (const [pid, argv] of Object.entries(procs)) {
    mkdirSync(join(proc, pid), { recursive: true });
    writeFileSync(join(proc, pid, "cmdline"), argv.map((a) => a.replace("$ARCHIL", archil).replace("$MP", mp).replace("$ROOT", root)).join("\0") + "\0");
  }
  const script = readFileSync(ARCHIL_SCOPED, "utf8")
    .replace("ARCHIL=/usr/bin/archil", `ARCHIL='${archil}'`)
    .replace("MOUNT=/usr/bin/mount", `MOUNT='${mount}'`)
    .replace("MOUNTS=/proc/self/mounts", `MOUNTS='${mounts}'`)
    .replace("PROC=/proc", `PROC='${proc}'`)
    .replace("KILL=kill", `KILL='${kill}'`)
    .replace("OWNER=0", `OWNER=${opts.owner ?? process.getuid!()}`)
    .replace("TRUST=0", `TRUST=${process.getuid!()}`);
  const path = stub("archil-scoped", script.replace(/^#!\/bin\/sh\n/, ""));
  const run = (args: string[]) => {
    const r = spawnSync(path, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, timeout: 15_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return {
    dir,
    root,
    mp,
    run,
    relist: () => writeFileSync(mounts, `dsk-1:/runs/r1[aws-us-east-1] ${mp} fuse.archil rw 0 0\n`),
    log: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    table: () => readFileSync(mounts, "utf8"),
    alive: (pid: string) => existsSync(join(proc, pid)),
    [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const PROCS = {
  "101": ["$ARCHIL", "mount", "dsk-1:/runs/r1", "$MP", "--region", "aws-us-east-1"],
  "102": ["$ARCHIL", "mount", "dsk-1:/runs/r2", "$ROOT/runs/r2", "--region", "aws-us-east-1"],
  "103": ["/bin/bash", "-c", "$MP"],
  "104": ["$ARCHIL", "sync", "$MP"],
  "105": ["/usr/local/bin/archil", "mount", "dsk-1:/runs/r1", "$MP"],
};

test("retire moves the run's archil mount to <root>/.released/<run>-<tag> and kills exactly its daemon", () => {
  const r = disposeAfter(retireRig(PROCS));
  const res = r.run(["retire", r.mp, "t1"]);
  assert.equal(res.status, 0, res.stderr);
  const dest = join(r.root, ".released", "r1-t1");
  assert.deepEqual(r.log(), [`mount --move ${r.mp} ${dest}`, "kill -KILL 101"]);
  assert.ok(!r.table().includes(` ${r.mp} `) && r.table().includes(` ${dest} `), "the path is free; the mount sits under .released");
  assert.ok(existsSync(dest));
  assert.equal(statSync(join(r.root, ".released")).mode & 0o777, 0o700, ".released is made 0700");
  assert.equal(statSync(dest).mode & 0o777, 0o700);
  assert.equal(r.alive("101"), false);
  for (const pid of ["102", "103", "104", "105"]) assert.equal(r.alive(pid), true, `pid ${pid} is not that mount's daemon (another run, not archil, not mount, another binary)`);
  assert.match(res.stdout, /moved .* killed: 101/);
});

test("retire refuses anything but a fuse.archil mount at <root>/runs/<run> with a safe tag, and touches nothing", () => {
  const r = disposeAfter(retireRig(PROCS));
  const cases: [string[], number][] = [
    [["retire", r.mp], 2],
    [["retire", join(r.root, "runs", "..", "etc"), "t"], 2],
    [["retire", "/etc", "t"], 2],
    [["retire", `${r.root}//runs/r1`, "t"], 2],
    [["retire", r.mp, "a/b"], 2],
    [["retire", r.mp, "-rf"], 2],
    [["retire", join(r.root, "runs", "r9"), "t"], 3],
  ];
  for (const [args, status] of cases) assert.equal(r.run(args).status, status, args.join(" "));
  assert.deepEqual(r.log(), []);
  const other = disposeAfter(retireRig(PROCS, { fstype: "ext4" }));
  assert.equal(other.run(["retire", other.mp, "t"]).status, 3, "not a fuse.archil mount");
  assert.deepEqual(other.log(), []);
});

test("retire kills nothing when the move fails, and fails when the daemon will not die", () => {
  const r = disposeAfter(retireRig(PROCS, { moveFails: true }));
  assert.equal(r.run(["retire", r.mp, "t"]).status, 4);
  assert.equal(r.log().filter((l) => l.startsWith("kill")).length, 0);
  assert.equal(r.alive("101"), true);
  const s = disposeAfter(retireRig(PROCS, { killIgnored: true }));
  const res = s.run(["retire", s.mp, "t"]);
  assert.equal(res.status, 5);
  assert.match(res.stderr, /daemon 101 still alive/);
});

test("retire never follows a link as root: a symlinked .released, a link in the root or in runs, a .released not owned by root", () => {
  const a = disposeAfter(retireRig(PROCS));
  const elsewhere = join(a.dir, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(a.root, ".released"));
  const ra = a.run(["retire", a.mp, "t1"]);
  assert.equal(ra.status, 6, ra.stderr);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing was created where the link points");

  const b = disposeAfter(retireRig(PROCS, { rootLink: true }));
  assert.equal(b.run(["retire", b.mp, "t1"]).status, 2, "a link in the root path");

  const c = disposeAfter(retireRig(PROCS));
  rmSync(join(c.root, "runs"), { recursive: true });
  mkdirSync(join(c.dir, "real-runs", "r1"), { recursive: true });
  symlinkSync(join(c.dir, "real-runs"), join(c.root, "runs"));
  assert.equal(c.run(["retire", c.mp, "t1"]).status, 2, "runs is a link");

  const d = disposeAfter(retireRig(PROCS, { owner: process.getuid!() + 1 }));
  mkdirSync(join(d.root, ".released"), { mode: 0o700 });
  assert.equal(d.run(["retire", d.mp, "t1"]).status, 6, ".released not owned by root");

  for (const r of [a, b, c, d]) {
    assert.deepEqual(r.log(), [], "nothing moved, nothing killed");
    assert.equal(r.alive("101"), true);
  }
});

test("retire refuses a destination that exists, and reuses a root-owned .released for the next release", () => {
  const r = disposeAfter(retireRig(PROCS));
  mkdirSync(join(r.root, ".released", "r1-t1"), { recursive: true, mode: 0o700 });
  chmodSync(join(r.root, ".released"), 0o700);
  const taken = r.run(["retire", r.mp, "t1"]);
  assert.equal(taken.status, 6, taken.stderr);
  assert.deepEqual(r.log(), []);
  const first = r.run(["retire", r.mp, "t2"]);
  assert.equal(first.status, 0, first.stderr);
  r.relist();
  const second = r.run(["retire", r.mp, "t3"]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readdirSync(join(r.root, ".released")).sort(), ["r1-t1", "r1-t2", "r1-t3"]);
});

// ---- stray: a run's mountpoint that is no mount and not empty, moved aside whole ---------------------------------------

/** The wrapper with its mount table and root's uid pointed at the test; `<root>/runs/r1` holds `seed` (path to content). */
function strayRig(seed: Record<string, string>, opts: { owner?: number; rootLink?: boolean; mpLink?: boolean; listed?: boolean; mode?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pda-stray-"));
  const real = join(dir, "mnt");
  mkdirSync(join(real, "runs"), { recursive: true });
  for (const d of [real, join(real, "runs")]) chmodSync(d, 0o755);
  if (opts.rootLink) symlinkSync(real, join(dir, "link"));
  const root = opts.rootLink ? join(dir, "link") : real;
  const mp = join(root, "runs", "r1");
  if (opts.mpLink) {
    mkdirSync(join(dir, "elsewhere-run"));
    writeFileSync(join(dir, "elsewhere-run", "x"), "x\n");
    symlinkSync(join(dir, "elsewhere-run"), join(real, "runs", "r1"));
  } else {
    mkdirSync(join(real, "runs", "r1"), { mode: opts.mode ?? 0o755 });
    chmodSync(join(real, "runs", "r1"), opts.mode ?? 0o755);
    for (const [p, content] of Object.entries(seed)) {
      mkdirSync(join(real, "runs", "r1", p, ".."), { recursive: true });
      writeFileSync(join(real, "runs", "r1", p), content);
    }
  }
  const mounts = join(dir, "mounts");
  writeFileSync(mounts, (opts.listed ? `dsk-1:/runs/r1[aws-us-east-1] ${mp} fuse.archil rw 0 0\n` : "") + "proc /proc proc rw 0 0\n");
  const script = readFileSync(ARCHIL_SCOPED, "utf8")
    .replace("MOUNTS=/proc/self/mounts", `MOUNTS='${mounts}'`)
    .replace("OWNER=0", `OWNER=${opts.owner ?? process.getuid!()}`)
    .replace("TRUST=0", `TRUST=${process.getuid!()}`);
  const path = join(dir, "archil-scoped");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  const run = (tag = "t1") => spawnSync(path, ["stray", mp, tag], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } });
  const files = (p: string): string[] => (existsSync(p) ? readdirSync(p, { recursive: true }).map(String).sort() : []);
  return { dir, root, real, mp, run, files, [Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }) };
}

const SEED = { "run.json": "secret-content-1\n", "jobs/a/report.md": "secret-content-2\n" };

test("stray moves a dirty mountpoint whole to <root>/.stray/<run>-<tag> and leaves it empty, with its owner and mode", () => {
  const r = disposeAfter(strayRig(SEED, { mode: 0o750 }));
  const res = r.run("t1");
  assert.equal(res.status, 0, res.stderr);
  const dest = join(r.root, ".stray", "r1-t1");
  assert.deepEqual(r.files(dest), ["jobs", "jobs/a", "jobs/a/report.md", "run.json"]);
  assert.deepEqual(r.files(r.mp), [], "the run's mountpoint is empty");
  const st = statSync(r.mp);
  assert.equal(st.mode & 0o7777, 0o750);
  assert.equal(st.uid, process.getuid!());
  assert.equal(statSync(join(r.root, ".stray")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(r.root, ".stray")), ["r1-t1"], "no .fresh directory left");
  assert.match(res.stdout, /entries=2 total=4/);
  assert.ok(!res.stdout.includes("secret") && !res.stderr.includes("secret"), "no file content in the output");
});

test("stray leaves an empty mountpoint alone and makes no .stray", () => {
  const r = disposeAfter(strayRig({}));
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /empty; nothing moved/);
  assert.equal(existsSync(join(r.root, ".stray")), false);
});

test("stray refuses a symlinked .stray, an existing destination, a .stray not owned by root, links, and a mount; nothing moves", () => {
  const a = disposeAfter(strayRig(SEED));
  mkdirSync(join(a.dir, "elsewhere"));
  symlinkSync(join(a.dir, "elsewhere"), join(a.root, ".stray"));
  assert.equal(a.run().status, 6, "a symlinked .stray");
  assert.deepEqual(readdirSync(join(a.dir, "elsewhere")), [], "nothing created where the link points");

  const b = disposeAfter(strayRig(SEED));
  mkdirSync(join(b.root, ".stray", "r1-t1"), { recursive: true });
  chmodSync(join(b.root, ".stray"), 0o700);
  assert.equal(b.run("t1").status, 6, "an existing destination");

  const c = disposeAfter(strayRig(SEED, { owner: process.getuid!() + 1 }));
  mkdirSync(join(c.root, ".stray"), { mode: 0o700 });
  assert.equal(c.run().status, 6, ".stray not owned by root");

  const d = disposeAfter(strayRig(SEED, { rootLink: true }));
  assert.equal(d.run().status, 2, "a link in the root path");

  const e = disposeAfter(strayRig({}, { mpLink: true }));
  assert.equal(e.run().status, 2, "the mountpoint is a link");
  assert.deepEqual(readdirSync(join(e.dir, "elsewhere-run")), ["x"]);

  const f = disposeAfter(strayRig(SEED, { listed: true }));
  assert.equal(f.run().status, 3, "a mount is never moved as stray");

  for (const r of [a, b, c, d, f]) assert.deepEqual(r.files(join(r.real, "runs", "r1")), ["jobs", "jobs/a", "jobs/a/report.md", "run.json"], "the files stay where they were");
});

test("stale kills exactly the run's archil daemons when no mount is listed at the run's path, and moves nothing", () => {
  const r = disposeAfter(retireRig(PROCS, { unlisted: true }));
  const res = r.run(["stale", r.mp]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(r.log(), ["kill -KILL 101"]);
  assert.equal(r.alive("101"), false);
  for (const pid of ["102", "103", "104", "105"]) assert.equal(r.alive(pid), true, `pid ${pid} is not that mountpoint's daemon (another run, not archil, not mount, another binary)`);
  assert.match(res.stdout, /killed stale archil daemon\(s\) of .*runs\/r1: 101$/m);
  assert.deepEqual(readdirSync(r.root).sort(), ["runs"], "no .released, no .stray");
});

test("stale never touches a listed mount's daemon, and kills nothing when there is no daemon", () => {
  const r = disposeAfter(retireRig(PROCS));
  const res = r.run(["stale", r.mp]);
  assert.equal(res.status, 3, res.stderr);
  assert.match(res.stderr, /is mounted; its daemon is not stale/);
  assert.deepEqual(r.log(), []);
  assert.equal(r.alive("101"), true);
  const none = disposeAfter(retireRig({ "102": PROCS["102"], "103": PROCS["103"] }, { unlisted: true }));
  const quiet = none.run(["stale", none.mp]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /no archil daemon for/);
  assert.deepEqual(none.log(), []);
});

test("stale refuses a path that is not a plain <root>/runs/<run>, a link in the root, extra arguments; fails when the daemon will not die", () => {
  const r = disposeAfter(retireRig(PROCS, { unlisted: true }));
  for (const args of [["stale"], ["stale", r.mp, "t"], ["stale", join(r.root, "runs", "..", "etc")], ["stale", "/etc"], ["stale", `${r.root}//runs/r1`]]) {
    assert.equal(r.run(args).status, 2, args.join(" "));
  }
  const l = disposeAfter(retireRig(PROCS, { unlisted: true, rootLink: true }));
  assert.equal(l.run(["stale", l.mp]).status, 2, "a link in the root path");
  for (const x of [r, l]) {
    assert.deepEqual(x.log(), []);
    assert.equal(x.alive("101"), true);
  }
  const k = disposeAfter(retireRig(PROCS, { unlisted: true, killIgnored: true }));
  const res = k.run(["stale", k.mp]);
  assert.equal(res.status, 5);
  assert.match(res.stderr, /daemon 101 still alive/);
});
