// The root helper a box on another machine mounts its run's work folder with (box/agentrun-archil), run here as this
// user against a copy whose three fixed paths (the archil client, the mountpoint and the mount table) are a recording
// stand-in's and a scratch directory's: no archil, no sudo and no root. It checks every argument itself, whoever calls,
// and runs nothing but the client, with fixed arguments; the token comes on fd 0 and reaches the client's environment
// alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";
import { fakeConnect, fakeGetent, fakeInet6, fakeIptables, fakeStatus } from "./fixtures/fake-iptables.mjs";
import { scratch } from "./support.mjs";

export const HELPER = fileURLToPath(new URL("../box/agentrun-archil", import.meta.url));
const DISK = "dsk-00000000000baf76";
const REGION = "aws-us-east-1";
const FOLDER = "agents/a1/runs/r1/work";
const TOKEN = "tok-archil-helper-test-0123456789abcdef";
/** The box's /proc as the image mounts it: no user sees another's processes. */
const PROC = "proc /proc proc rw,nosuid,nodev,noexec,relatime,hidepid=invisible 0 0\n";

/** A copy of the helper over a scratch box: its archil a stand-in that records each call's arguments, whether the token
 *  was in its environment, and every process's arguments as `ps` shows them while it runs. */
async function box(t) {
  const dir = realpathSync(await scratch(t));
  const mp = join(dir, "workspace");
  mkdirSync(mp);
  const mounts = join(dir, "mounts");
  writeFileSync(mounts, PROC);
  const calls = join(dir, "calls");
  const archil = join(dir, "archil");
  writeFileSync(archil, `#!/bin/sh\n{ printf 'argv %s\\n' "$*"; [ "\${ARCHIL_MOUNT_TOKEN-}" = '${TOKEN}' ] && echo 'env token'; ps -eo args | awk 'index($0, ENVIRON["ARCHIL_MOUNT_TOKEN"]) { n++ } END { print "ps " n + 0 }'; } >> '${calls}'\n`);
  chmodSync(archil, 0o755);
  const source = readFileSync(HELPER, "utf8");
  const fixed = { ARCHIL: ["/usr/bin/archil", archil], MP: ["/workspace", mp], MOUNTS: ["/proc/self/mounts", mounts], IPTABLES: ["/usr/sbin/iptables", fakeIptables(dir, "iptables")], IP6TABLES: ["/usr/sbin/ip6tables", fakeIptables(dir, "ip6tables")], GETENT: ["/usr/bin/getent", fakeGetent(dir)], STATUS: ["/proc/self/status", fakeStatus(dir)], IF_INET6: ["/proc/net/if_inet6", fakeInet6(dir)], TOOL: ["agentrun-tool", userInfo().username] };
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
  return { dir, mp, mounts, run, mounted: (folder = FOLDER) => writeFileSync(mounts, `${PROC}${DISK}:/${folder}[${REGION}] ${mp} fuse.archil rw 0 0\n`) };
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

const CHAIN_RULES = (uid, address, prefix) => [
  "-N AGENTRUN-NET",
  `-A AGENTRUN-NET -m owner --uid-owner ${uid} -j DROP`,
  "-A AGENTRUN-NET -o lo -j ACCEPT",
  "-A AGENTRUN-NET -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT",
  "-A AGENTRUN-NET -p udp -m owner --uid-owner 0 -m udp --dport 53 -j ACCEPT",
  "-A AGENTRUN-NET -p tcp -m owner --uid-owner 0 -m tcp --dport 53 -j ACCEPT",
  `-A AGENTRUN-NET -d ${address}/${prefix} -p tcp -m owner --uid-owner 0 -m tcp --dport 8100 -j ACCEPT`,
  "-A AGENTRUN-NET -p tcp -m owner --uid-owner 0 -m tcp --dport 32050 -j ACCEPT",
  "-A AGENTRUN-NET -m owner --uid-owner 0 -j DROP",
];

test("netlock: the tool user sends nothing, root reaches the region's mount endpoint on 8100 and 32050 alone, for IPv4 and IPv6, in a chain jumped to first, read back whole; again, the same", async (t) => {
  const b = await box(t);
  const uid = process.getuid();
  for (const round of [1, 2]) {
    const ran = b.run(["netlock", REGION], "");
    assert.equal(ran.status, 0, `round ${round}: ${ran.stderr}`);
    assert.match(ran.stderr, /root reaches mount\.green\.us-east-1\.aws\.prod\.archil\.com on 8100/);
    assert.deepEqual(readFileSync(join(b.dir, "iptables.chain.AGENTRUN-NET"), "utf8").split("\n").filter(Boolean), CHAIN_RULES(uid, "203.0.113.10", 32).slice(1));
    assert.deepEqual(readFileSync(join(b.dir, "ip6tables.chain.AGENTRUN-NET"), "utf8").split("\n").filter(Boolean), CHAIN_RULES(uid, "2001:db8::10", 128).slice(1));
    for (const name of ["iptables", "ip6tables"]) assert.deepEqual(readFileSync(join(b.dir, `${name}.OUTPUT`), "utf8").split("\n").filter(Boolean), ["-A OUTPUT -j AGENTRUN-NET"], `${name}: one jump, first`);
  }
  assert.deepEqual(b.run([]).calls, [], "archil is never run");
});

const NETLOCK_REFUSED = [
  ["no CAP_NET_ADMIN", (b) => writeFileSync(join(b.dir, "status"), "CapEff:\t000001ffffffefff\n"), /no CAP_NET_ADMIN/],
  ["no ip6tables in a box with IPv6", (b) => rmSync(join(b.dir, "ip6tables")), /the box has IPv6, and ip6tables is not installed/],
  ["no iptables", (b) => rmSync(join(b.dir, "iptables")), /iptables is not installed/],
  ["an ip6tables that answers yes to everything", (b) => writeFileSync(join(b.dir, "ip6tables"), "#!/bin/sh\nexit 0\n"), /cannot move its jump|reads back other rules/],
  ["a read-back that differs", (b) => writeFileSync(join(b.dir, "iptables.tamper"), ""), /reads back other rules than it was given/],
  ["no address for the endpoint", (b) => writeFileSync(join(b.dir, "getent"), "#!/bin/sh\nexit 2\n"), /has no address/],
];
for (const [what, spoil, said] of NETLOCK_REFUSED) {
  test(`netlock refuses, exit 4, with ${what}`, async (t) => {
    const b = await box(t);
    spoil(b);
    const ran = b.run(["netlock", REGION], "");
    assert.equal(ran.status, 4, ran.stderr);
    assert.match(ran.stderr, said);
  });
}

test("netlock: the tool user's drop is the chain's first rule, so a tool reaches no loopback port either (the provider's daemon on 2280 included), for IPv4 and IPv6", async (t) => {
  const b = await box(t);
  const ran = b.run(["netlock", REGION], "");
  assert.equal(ran.status, 0, ran.stderr);
  const uid = process.getuid();
  for (const name of ["iptables", "ip6tables"]) {
    const [first] = readFileSync(join(b.dir, `${name}.chain.AGENTRUN-NET`), "utf8").split("\n");
    assert.equal(first, `-A AGENTRUN-NET -m owner --uid-owner ${uid} -j DROP`, `${name}: before loopback and replies pass`);
  }
  const connect = fakeConnect(b.dir, join(b.dir, "iptables.chain.AGENTRUN-NET"), uid, join(b.dir, "ip6tables.chain.AGENTRUN-NET"));
  for (const [host, port] of [["127.0.0.1", "2280"], ["::1", "2280"], ["127.0.0.1", "8080"], ["203.0.113.10", "8100"]]) {
    const tried = spawnSync(connect, [host, port], { encoding: "utf8" });
    assert.equal(tried.status, 1, `${host}:${port} is refused the tool: ${tried.stdout}`);
  }
});

test("netlock in a box with no IPv6: the IPv4 rules alone, and no ip6tables needed", async (t) => {
  const b = await box(t);
  writeFileSync(join(b.dir, "if_inet6"), "");
  rmSync(join(b.dir, "ip6tables"));
  const ran = b.run(["netlock", REGION], "");
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stderr, /the box has no IPv6, so there are no IPv6 rules to lock/);
  assert.deepEqual(readFileSync(join(b.dir, "iptables.chain.AGENTRUN-NET"), "utf8").split("\n").filter(Boolean), CHAIN_RULES(process.getuid(), "203.0.113.10", 32).slice(1));
  assert.equal(existsSync(join(b.dir, "ip6tables.chain.AGENTRUN-NET")), false);
});

test("netlock takes the region alone, of its shape: anything else exits 2 and touches no rule", async (t) => {
  for (const args of [["netlock"], ["netlock", REGION, "extra"], ["netlock", "us"], ["netlock", "aws-us east"], ["netlock", "aws-us-east-1;id"], ["netlock", `${REGION}\naws-x-1`]]) {
    const b = await box(t);
    const ran = b.run(args, "");
    assert.equal(ran.status, 2, `${JSON.stringify(args)}: ${ran.stderr}`);
    assert.equal(existsSync(join(b.dir, "iptables.OUTPUT")), false, JSON.stringify(args));
  }
});
