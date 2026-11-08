// The root helper a box on another machine mounts its run's work folder with (box/agentrun-archil), run here as this
// user against a copy whose three fixed paths (the archil client, the mountpoint and the mount table) are a recording
// stand-in's and a scratch directory's: no archil, no sudo and no root. It checks every argument itself, whoever calls,
// and runs nothing but the client, with fixed arguments; the token comes on fd 0 and reaches the client's environment
// alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** A fresh scratch directory, removed when the test ends. */
async function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "computer-archil-helper-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const HELPER = fileURLToPath(new URL("../box/agentrun-archil", import.meta.url));
const DISK = "dsk-00000000000baf76";
const REGION = "aws-us-east-1";
const FOLDER = "agents/a1/runs/r1/work";
const TOKEN = "tok-archil-helper-test-0123456789abcdef";
/** The box's /proc as the image mounts it: no user sees another's processes. */
const PROC = "proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=invisible 0 0\n";

/** A copy of the helper over a scratch box: its archil a stand-in that records each call's arguments, whether the token
 *  was in its environment, and every process's arguments as `ps` shows them while it runs. The helper's root is this
 *  user (ROOT_UID), unless `root` is false: then root is another uid, and this user is not it. Its computerd is a
 *  stand-in that records its arguments and what came on its stdin; the walk that holds computerd to root's alone stops at
 *  the scratch directory (HELD_TOP), since the directories above it are no box's. */
async function box(t, { root = true } = {}) {
  const dir = realpathSync(await scratch(t));
  chmodSync(dir, 0o755);
  const opt = join(dir, "opt");
  mkdirSync(opt, { mode: 0o755 });
  const computerd = join(opt, "computerd");
  writeFileSync(computerd, `#!/bin/sh\n{ printf 'computerd %s\\n' "$*"; printf 'stdin %s\\n' "$(wc -c | tr -d ' ')"; } >> '${join(dir, "calls")}'\n`);
  chmodSync(computerd, 0o755);
  const mp = join(dir, "workspace");
  mkdirSync(mp);
  const mounts = join(dir, "mounts");
  writeFileSync(mounts, PROC);
  const calls = join(dir, "calls");
  const archil = join(dir, "archil");
  writeFileSync(archil, `#!/bin/sh\n{ printf 'argv %s\\n' "$*"; [ "\${ARCHIL_MOUNT_TOKEN-}" = '${TOKEN}' ] && echo 'env token'; ps -eo args | awk 'index($0, ENVIRON["ARCHIL_MOUNT_TOKEN"]) { n++ } END { print "ps " n + 0 }'; } >> '${calls}'\n[ ! -e '${join(dir, "archil-fails")}' ] || { echo 'archil: mount failed' >&2; exit 1; }\n`);
  chmodSync(archil, 0o755);
  // The computer's chown: it records its arguments, and whether the token reached its environment (it must not).
  const chown = join(dir, "chown");
  writeFileSync(chown, `#!/bin/sh\n{ printf 'chown %s\\n' "$*"; [ -z "\${ARCHIL_MOUNT_TOKEN-}" ] || echo 'chown env token'; } >> '${calls}'\n[ ! -e '${join(dir, "chown-fails")}' ] || exit 1\n`);
  chmodSync(chown, 0o755);
  // The box's `mount`: it records each call; it remounts /proc with hidepid (in the mount table) only in a box made
  // `remountable`, as root with CAP_SYS_ADMIN can, and refuses as a box without it does.
  const remounts = join(dir, "remounts");
  const remountable = join(dir, "remountable");
  const mount = join(dir, "mount");
  writeFileSync(mount, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${remounts}'\n[ -e '${remountable}' ] || { echo 'mount: /proc: permission denied.' >&2; exit 32; }\n[ "$*" = '-o remount,hidepid=2 /proc' ] || exit 1\nsed -i 's#^proc /proc proc \\([^ ]*\\) #proc /proc proc \\1,hidepid=invisible #' '${mounts}'\n`);
  chmodSync(mount, 0o755);
  const source = readFileSync(HELPER, "utf8");
  const fixed = { ARCHIL: ["/usr/bin/archil", archil], MP: ["/workspace", mp], MOUNTS: ["/proc/self/mounts", mounts], MOUNT: ["/usr/bin/mount", mount], CHOWN: ["/usr/bin/chown", chown], TOOL: ["agentrun-tool", userInfo().username], ROOT_UID: ["0", String(root ? process.getuid() : process.getuid() + 1)], COMPUTERD: ["/opt/agentrun/computerd", computerd], HELD_TOP: ["/", dir], SOCK: ["/run/agentrun-archil/archil.sock", join(dir, "run", "archil.sock")] };
  let copy = source;
  for (const [name, [shipped, here]] of Object.entries(fixed)) {
    assert.ok(source.includes(`\n${name}=${shipped}\n`), `the helper fixes ${name}=${shipped}`);
    copy = copy.replace(`\n${name}=${shipped}\n`, `\n${name}=${here}\n`);
  }
  const helper = join(dir, "agentrun-archil");
  writeFileSync(helper, copy);
  chmodSync(helper, 0o755);
  const run = (args, stdin = `${TOKEN}\n`) => {
    const ran = spawnSync(helper, args, { input: stdin, encoding: "utf8", env: { PATH: process.env.PATH } });
    return { status: ran.status, stderr: ran.stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [] };
  };
  return { dir, mp, mounts, run, computerd, sock: join(dir, "run", "archil.sock"), remounts: () => (existsSync(remounts) ? readFileSync(remounts, "utf8").split("\n").filter(Boolean) : []), remountable: () => writeFileSync(remountable, ""), mounted: (folder = FOLDER) => writeFileSync(mounts, `${PROC}${DISK}:/${folder}[${REGION}] ${mp} fuse.archil rw 0 0\n`) };
}

/** The chown a mount ends with: the mount's top folder given to the tool user (here, this user), in no token's company. */
const chowned = (b) => `chown ${userInfo().username}:${userInfo().username} ${b.mp}`;

test("mount: the client alone, with fixed arguments; the token in its environment, never an argument any process shows; then the folder's top given to the tool user", async (t) => {
  const b = await box(t);
  const ran = b.run(["mount", DISK, REGION, FOLDER]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.calls, [`argv mount ${DISK}:/${FOLDER} ${b.mp} --region ${REGION}`, "env token", "ps 0", chowned(b)]);
});

test("revoke: the same mount with --force, which takes the folder back from a box that is gone; then the same chown", async (t) => {
  const b = await box(t);
  const ran = b.run(["revoke", DISK, REGION, FOLDER]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.calls, [`argv mount --force ${DISK}:/${FOLDER} ${b.mp} --region ${REGION}`, "env token", "ps 0", chowned(b)]);
});

test("a mount the client refuses gives nothing away: its exit code, and no chown", async (t) => {
  const b = await box(t);
  writeFileSync(join(b.dir, "archil-fails"), "");
  const ran = b.run(["mount", DISK, REGION, FOLDER]);
  assert.equal(ran.status, 1, ran.stderr);
  assert.ok(!ran.calls.some((line) => line.startsWith("chown")), JSON.stringify(ran.calls));
});

test("a mount whose top folder cannot be given to the tool user exits 4, in words: the tools could not write the run's folder", async (t) => {
  const b = await box(t);
  writeFileSync(join(b.dir, "chown-fails"), "");
  const ran = b.run(["mount", DISK, REGION, FOLDER]);
  assert.equal(ran.status, 4, ran.stderr);
  assert.match(ran.stderr, /cannot give .* to /);
});

test("an owner-qualified disk name is a disk too", async (t) => {
  const b = await box(t);
  assert.equal(b.run(["mount", "someone@example.com/agents-disk", REGION, FOLDER]).status, 0);
});

test("checkin acts on the mount alone, and only once it is an archil mount", async (t) => {
  const b = await box(t);
  assert.equal(b.run(["checkin"]).status, 3, "checkin before any mount: nothing is held");
  b.mounted();
  assert.equal(b.run(["checkin"], "").status, 0);
  assert.deepEqual(b.run([]).calls.filter((line) => line.startsWith("argv")), [`argv checkin ${b.mp}`]);
});

test("sync is no verb of the helper's: the resident serve syncs; a sync exits 2 and runs nothing, mounted or not", async (t) => {
  const b = await box(t);
  for (const mounted of [false, true]) {
    if (mounted) b.mounted();
    const ran = b.run(["sync"], "");
    assert.equal(ran.status, 2, ran.stderr);
    assert.match(ran.stderr, /^agentrun-archil: say mount, revoke, serve or checkin\n$/);
    assert.deepEqual(ran.calls, []);
  }
});

test("run by anyone but root, every verb exits 2 and runs nothing: the provider runs it as root through its own exec, never through sudo", async (t) => {
  const b = await box(t, { root: false });
  b.mounted();
  for (const args of [["mount", DISK, REGION, FOLDER], ["revoke", DISK, REGION, FOLDER], ["serve"], ["checkin"]]) {
    const ran = b.run(args);
    assert.equal(ran.status, 2, `${args[0]}: ${ran.stderr}`);
    assert.match(ran.stderr, /^agentrun-archil: run it as root, through the provider's own exec\n$/, args[0]);
    assert.deepEqual(ran.calls, [], args[0]);
    assert.deepEqual(b.remounts(), [], `${args[0]}: no remount`);
  }
});

test("serve: with the archil mount, it becomes computerd sync-serve with fixed arguments alone, and no token: its stdin is not passed on", async (t) => {
  const b = await box(t);
  b.mounted();
  const ran = b.run(["serve"]);
  assert.equal(ran.status, 0, ran.stderr);
  const gid = spawnSync("id", ["-g", userInfo().username], { encoding: "utf8" }).stdout.trim();
  assert.deepEqual(ran.calls, [`computerd sync-serve --socket ${b.sock} --mountpoint ${b.mp} --mounts ${b.mounts} --archil ${join(b.dir, "archil")} --gid ${gid}`, "stdin 0"]);
});

test("serve takes no argument, and serves only an archil mount: an argument exits 2, nothing mounted exits 3, and neither runs anything", async (t) => {
  const b = await box(t);
  const bare = b.run(["serve"], "");
  assert.equal(bare.status, 3, bare.stderr);
  assert.match(bare.stderr, /nothing is mounted at /);
  b.mounted();
  for (const args of [["serve", "x"], ["serve", "--socket", "/tmp/s"], ["serve", ""]]) {
    const ran = b.run(args, "");
    assert.equal(ran.status, 2, `${JSON.stringify(args)}: ${ran.stderr}`);
  }
  const other = await box(t);
  writeFileSync(other.mounts, `${PROC}tmpfs ${other.mp} tmpfs rw 0 0\n`);
  assert.equal(other.run(["serve"], "").status, 3, "another kind of mount is no archil mount");
  for (const each of [b, other]) assert.deepEqual(each.run([]).calls, []);
});

test("serve runs computerd only while it is root's alone: a file or a folder above it another user may change, or not root's, exits 4 and runs nothing", async (t) => {
  const spoils = [
    ["group-writable", (b) => chmodSync(b.computerd, 0o775)],
    ["world-writable folder", (b) => chmodSync(join(b.dir, "opt"), 0o777)],
    ["a link", (b) => { rmSync(b.computerd); symlinkSync(join(b.dir, "archil"), b.computerd); }],
    ["missing", (b) => rmSync(b.computerd)],
  ];
  for (const [what, spoil] of spoils) {
    const b = await box(t);
    b.mounted();
    spoil(b);
    const ran = b.run(["serve"], "");
    assert.equal(ran.status, 4, `${what}: ${ran.stderr}`);
    assert.match(ran.stderr, /computerd .* is not root's alone/, what);
    assert.deepEqual(ran.calls, [], what);
  }
});

test("checkin first takes serve's socket away, so the resident serve exits, then lets go of the folder", async (t) => {
  const b = await box(t);
  b.mounted();
  mkdirSync(join(b.dir, "run"));
  writeFileSync(b.sock, "");
  const ran = b.run(["checkin"], "");
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(existsSync(b.sock), false, "the socket is gone");
  assert.deepEqual(ran.calls.filter((line) => !line.startsWith("ps ")), [`argv checkin ${b.mp}`]);
});

test("a mount of a folder already mounted there answers at once and runs nothing", async (t) => {
  const b = await box(t);
  b.mounted();
  const ran = b.run(["mount", DISK, REGION, FOLDER], "");
  assert.equal(ran.status, 0);
  assert.deepEqual(ran.calls, []);
});

test("a mount where another folder is mounted already is refused, and runs nothing", async (t) => {
  const b = await box(t);
  b.mounted("agents/a1/runs/r0/work");
  const ran = b.run(["mount", DISK, REGION, FOLDER]);
  assert.equal(ran.status, 2, ran.stderr);
  assert.deepEqual(ran.calls, []);
});

const REFUSED = [
  ["no verb", []],
  ["an unknown verb", ["unmount"]],
  ["a verb of the client's it does not take", ["delegations", DISK]],
  ["a missing folder", ["mount", DISK, REGION]],
  ["an extra argument", ["mount", DISK, REGION, FOLDER, "--force"]],
  ["sync with an argument", ["sync", "/"]],
  ["checkin of another path", ["checkin", "/mnt"]],
  ["a newline in the folder", ["mount", DISK, REGION, `${FOLDER}\nagents/b/runs/r/work`]],
  ["a newline in the disk", ["mount", `${DISK}\nx`, REGION, FOLDER]],
  ["an absolute folder", ["mount", DISK, REGION, `/${FOLDER}`]],
  ["`..` for the run", ["mount", DISK, REGION, "agents/a1/runs/../work"]],
  ["`..` for the agent", ["mount", DISK, REGION, "agents/../runs/r1/work"]],
  ["`..` at the end", ["mount", DISK, REGION, "agents/a1/runs/r1/work/.."]],
  ["`.` for the run", ["mount", DISK, REGION, "agents/a1/runs/./work"]],
  ["an empty segment", ["mount", DISK, REGION, "agents//runs/r1/work"]],
  ["a trailing slash", ["mount", DISK, REGION, `${FOLDER}/`]],
  ["an extra segment", ["mount", DISK, REGION, `${FOLDER}/inputs`]],
  ["the run's whole folder", ["mount", DISK, REGION, "agents/a1/runs/r1"]],
  ["the run's store", ["mount", DISK, REGION, "agents/a1/runs/r1/store"]],
  ["the agent's learning", ["mount", DISK, REGION, "agents/a1/learning"]],
  ["the disk's root", ["mount", DISK, REGION, ""]],
  ["a dotted agent id", ["mount", DISK, REGION, "agents/.a/runs/r1/work"]],
  ["a disk with a path in it", ["mount", "dsk-00000000000baf76:/x", REGION, FOLDER]],
  ["a disk that is a word of a shell", ["mount", "dsk;rm", REGION, FOLDER]],
  ["a disk that climbs", ["mount", "../dsk", REGION, FOLDER]],
  ["a region with a space", ["mount", DISK, "us east", FOLDER]],
  ["a region that is a flag", ["mount", DISK, "--force", FOLDER]],
  ["revoke of the run's whole folder", ["revoke", DISK, REGION, "agents/a1/runs/r1"]],
];
for (const [what, args] of REFUSED) {
  test(`refuses ${what}, and runs nothing`, async (t) => {
    const b = await box(t);
    const ran = b.run(args);
    assert.equal(ran.status, 2, ran.stderr);
    assert.match(ran.stderr, /^agentrun-archil: /);
    assert.deepEqual(ran.calls, []);
  });
}

const BAD_TOKENS = [
  ["no token", ""],
  ["an empty line", "\n"],
  ["a token with a space", "tok archil helper test 0123456789\n"],
  ["a token with a quote", "tok'archil-helper-test-0123456789\n"],
  ["a token too short to be one", "short\n"],
];
for (const [what, stdin] of BAD_TOKENS) {
  test(`refuses ${what} on fd 0, and runs nothing`, async (t) => {
    const b = await box(t);
    const ran = b.run(["mount", DISK, REGION, FOLDER], stdin);
    assert.equal(ran.status, 2, ran.stderr);
    assert.deepEqual(ran.calls, []);
  });
}

test("refuses a mountpoint that is a link, one that is not empty, and one that is another mount", async (t) => {
  const b = await box(t);
  writeFileSync(join(b.mp, "left"), "x");
  assert.equal(b.run(["mount", DISK, REGION, FOLDER]).status, 2, "not empty");
  const linked = await box(t);
  const elsewhere = join(linked.dir, "elsewhere");
  mkdirSync(elsewhere);
  const { rmSync } = await import("node:fs");
  rmSync(linked.mp, { recursive: true });
  symlinkSync(elsewhere, linked.mp);
  assert.equal(linked.run(["mount", DISK, REGION, FOLDER]).status, 2, "a link");
  const other = await box(t);
  writeFileSync(other.mounts, `${PROC}tmpfs ${other.mp} tmpfs rw 0 0\n`);
  assert.equal(other.run(["mount", DISK, REGION, FOLDER]).status, 2, "another mount");
  for (const each of [b, linked, other]) assert.deepEqual(each.run([]).calls, []);
});

test("refuses a mount or revoke while the box's /proc lets a user see another's processes (no hidepid=2 or invisible), exit 4, and runs nothing", async (t) => {
  for (const proc of ["proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n", "proc /proc proc rw,hidepid=1 0 0\n", "proc /proc proc rw,hidepid=invisible 0 0\nproc /proc proc rw,relatime 0 0\n", ""]) {
    const b = await box(t);
    writeFileSync(b.mounts, proc);
    for (const verb of ["mount", "revoke"]) {
      const ran = b.run([verb, DISK, REGION, FOLDER]);
      assert.equal(ran.status, 4, `${JSON.stringify(proc)}: ${ran.stderr}`);
      assert.match(ran.stderr, /\/proc is not mounted with hidepid=2/);
      assert.deepEqual(ran.calls, []);
    }
  }
  // hidepid=2, as an older kernel names it, is the same as invisible.
  const b = await box(t);
  writeFileSync(b.mounts, "proc /proc proc rw,hidepid=2 0 0\n");
  assert.equal(b.run(["mount", DISK, REGION, FOLDER]).status, 0);
});

test("a mount or revoke first remounts /proc with hidepid=2: a box whose root can is mounted; one whose root cannot is refused as before", async (t) => {
  const bare = "proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n";
  for (const [verb, force] of [["mount", ""], ["revoke", "--force "]]) {
    const b = await box(t);
    writeFileSync(b.mounts, bare);
    b.remountable();
    const ran = b.run([verb, DISK, REGION, FOLDER]);
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(b.remounts(), ["-o remount,hidepid=2 /proc"]);
    assert.match(readFileSync(b.mounts, "utf8"), /^proc \/proc proc rw,nosuid,nodev,noexec,relatime,hidepid=invisible /);
    assert.deepEqual(ran.calls, [`argv mount ${force}${DISK}:/${FOLDER} ${b.mp} --region ${REGION}`, "env token", "ps 0", chowned(b)]);
    const stuck = await box(t);
    writeFileSync(stuck.mounts, bare);
    const refused = stuck.run([verb, DISK, REGION, FOLDER]);
    assert.equal(refused.status, 4, refused.stderr);
    assert.match(refused.stderr, /^agentrun-archil: \/proc is not mounted with hidepid=2 \(or invisible\): the run's tools could see the root archil client's processes\n$/);
    assert.deepEqual(stuck.remounts(), ["-o remount,hidepid=2 /proc"], "the remount was tried, and its failure said nothing");
    assert.deepEqual(refused.calls, []);
  }
});

test("netlock is no verb of the helper's: the tools' network is init's own namespace; it exits 2 and runs nothing", async (t) => {
  for (const args of [["netlock"], ["netlock", REGION]]) {
    const b = await box(t);
    const ran = b.run(args, "");
    assert.equal(ran.status, 2, `${JSON.stringify(args)}: ${ran.stderr}`);
    assert.match(ran.stderr, /^agentrun-archil: say mount, revoke, serve or checkin\n$/);
    assert.deepEqual(ran.calls, []);
  }
});

test("the helper runs no firewall program and names none", () => {
  const source = readFileSync(HELPER, "utf8");
  for (const word of ["iptables", "ip6tables", "getent", "CAP_NET_ADMIN", "netlock"]) assert.ok(!source.includes(word), `the helper names ${word}`);
});
