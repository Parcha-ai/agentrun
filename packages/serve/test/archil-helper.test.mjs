// The root helper a box on another machine mounts its run's work folder with (box/agentrun-archil), run here as this
// user against a copy whose three fixed paths (the archil client, the mountpoint and the mount table) are a recording
// stand-in's and a scratch directory's: no archil, no sudo and no root. It checks every argument itself, whoever calls,
// and runs nothing but the client, with fixed arguments; the token comes on fd 0 and reaches the client's environment
// alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { scratch } from "./support.mjs";

export const HELPER = fileURLToPath(new URL("../box/agentrun-archil", import.meta.url));
const DISK = "dsk-00000000000baf76";
const REGION = "aws-us-east-1";
const FOLDER = "agents/a1/runs/r1/work";
const TOKEN = "tok-archil-helper-test-0123456789abcdef";

/** A copy of the helper over a scratch box: its archil a stand-in that records each call's arguments, whether the token
 *  was in its environment, and every process's arguments as `ps` shows them while it runs. */
async function box(t) {
  const dir = realpathSync(await scratch(t));
  const mp = join(dir, "workspace");
  mkdirSync(mp);
  const mounts = join(dir, "mounts");
  writeFileSync(mounts, "proc /proc proc rw 0 0\n");
  const calls = join(dir, "calls");
  const archil = join(dir, "archil");
  writeFileSync(archil, `#!/bin/sh\n{ printf 'argv %s\\n' "$*"; [ "\${ARCHIL_MOUNT_TOKEN-}" = '${TOKEN}' ] && echo 'env token'; ps -eo args | awk 'index($0, ENVIRON["ARCHIL_MOUNT_TOKEN"]) { n++ } END { print "ps " n + 0 }'; } >> '${calls}'\n`);
  chmodSync(archil, 0o755);
  const source = readFileSync(HELPER, "utf8");
  for (const line of ["ARCHIL=/usr/bin/archil", "MP=/workspace", "MOUNTS=/proc/self/mounts"]) assert.ok(source.includes(`\n${line}\n`), `the helper fixes ${line}`);
  const helper = join(dir, "agentrun-archil");
  writeFileSync(helper, source.replace("\nARCHIL=/usr/bin/archil\n", `\nARCHIL=${archil}\n`).replace("\nMP=/workspace\n", `\nMP=${mp}\n`).replace("\nMOUNTS=/proc/self/mounts\n", `\nMOUNTS=${mounts}\n`));
  chmodSync(helper, 0o755);
  const run = (args, stdin = `${TOKEN}\n`) => {
    const ran = spawnSync(helper, args, { input: stdin, encoding: "utf8", env: { PATH: process.env.PATH } });
    return { status: ran.status, stderr: ran.stderr, calls: existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean) : [] };
  };
  return { dir, mp, mounts, run, mounted: (folder = FOLDER) => writeFileSync(mounts, `proc /proc proc rw 0 0\n${DISK}:/${folder}[${REGION}] ${mp} fuse.archil rw 0 0\n`) };
}

test("mount: the client alone, with fixed arguments; the token in its environment, never an argument any process shows", async (t) => {
  const b = await box(t);
  const ran = b.run(["mount", DISK, REGION, FOLDER]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.calls, [`argv mount ${DISK}:/${FOLDER} ${b.mp} --region ${REGION}`, "env token", "ps 0"]);
});

test("revoke: the same mount with --force, which takes the folder back from a box that is gone", async (t) => {
  const b = await box(t);
  const ran = b.run(["revoke", DISK, REGION, FOLDER]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.calls, [`argv mount --force ${DISK}:/${FOLDER} ${b.mp} --region ${REGION}`, "env token", "ps 0"]);
});

test("an owner-qualified disk name is a disk too", async (t) => {
  const b = await box(t);
  assert.equal(b.run(["mount", "someone@example.com/agents-disk", REGION, FOLDER]).status, 0);
});

test("sync and checkin act on the mount alone, and only once it is an archil mount", async (t) => {
  const b = await box(t);
  for (const verb of ["sync", "checkin"]) assert.equal(b.run([verb]).status, 3, `${verb} before any mount: nothing is held`);
  b.mounted();
  for (const verb of ["sync", "checkin"]) assert.equal(b.run([verb], "").status, 0);
  assert.deepEqual(b.run([]).calls.filter((line) => line.startsWith("argv")), [`argv sync ${b.mp}`, `argv checkin ${b.mp}`]);
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
  writeFileSync(other.mounts, `tmpfs ${other.mp} tmpfs rw 0 0\n`);
  assert.equal(other.run(["mount", DISK, REGION, FOLDER]).status, 2, "another mount");
  for (const each of [b, linked, other]) assert.deepEqual(each.run([]).calls, []);
});
