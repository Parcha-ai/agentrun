// install.sh --vps installs Docker with apt-get on a server that has just booted, where cloud-init, apt-daily or
// unattended-upgrades may hold apt's locks for minutes (a Droplet whose user data runs the installer starts it on first
// boot). vps_apt waits for them: dpkg's lock through DPkg::Lock::Timeout, and every other lock apt-get could not get (the
// archives' that `install` takes, the lists' that `update` takes), which that option does not cover, by trying again.
// One deadline bounds the whole wait: 600 s from the first refusal of such a lock, which every later try's own wait for
// dpkg's lock is cut to as well. Its clock is the time since boot (/proc/uptime), which the clock steps a just-booted
// server takes (timesyncd, chrony) never move.
// apt-get runs under LC_ALL=C, so its words are the ones matched on a server set to another language. Any other failure
// stops the install at once, as before.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const INSTALL = new URL("../install.sh", import.meta.url);
const vpsApt = /^vps_apt\(\) \{\n[\s\S]*?\n\}\n/m.exec(await readFile(INSTALL, "utf8"))?.[0];

// The stand-in clock: seconds since boot as /proc/uptime holds them ("1000.37 3912.08"), which the stand-ins move on.
const CLOCK = 'read c _ < "$FAKE/uptime"; c=${c%%.*}';

// A stand-in apt-get on a server set to German: it logs its arguments, says it could not get the lock at $LOCK for its
// first $LOCKED calls (in English only under LC_ALL=C, as apt does), then exits $THEN (0, or 100 with another error).
// Each call takes $TOOK seconds of the stand-in clock, the first $TOOK_FIRST when given (a first wait for dpkg's lock).
const APT = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE/calls"
n=$(wc -l < "$FAKE/calls")
took=$TOOK
[ "$n" -gt 1 ] || [ -z "$TOOK_FIRST" ] || took=$TOOK_FIRST
${CLOCK}
echo "$((c + took)).37 0.00" > "$FAKE/uptime"
if [ "$n" -le "$LOCKED" ]; then
  if [ "$LC_ALL" = C ]; then
    echo "E: Could not get lock $LOCK. It is held by process 812 (apt-get)" >&2
  else
    echo "E: Sperre $LOCK konnte nicht erlangt werden. Sie wird von Prozess 812 (apt-get) gehalten." >&2
  fi
  exit 100
fi
[ "$THEN" = 0 ] || echo "E: Unable to locate package docker-ce" >&2
exit "$THEN"
`;

const ARCHIVES = "/var/cache/apt/archives/lock";

async function run(t, { locked, then, lock = ARCHIVES, verb = "install docker-ce", took = 0, tookFirst }) {
  const dir = await mkdtemp(join(tmpdir(), "vps-apt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "apt-get"), APT);
  // The waits between tries, at once, and the clock they move on.
  await writeFile(join(dir, "sleep"), `#!/bin/sh\n${CLOCK}\necho "$((c + $1)).37 0.00" > "$FAKE/uptime"\n`);
  // The wall clock, stepped a day ahead as a first boot's time sync can: a wait that read it would end at once.
  await writeFile(join(dir, "date"), `#!/bin/sh\n${CLOCK}\necho $((c + 86400))\n`);
  for (const name of ["apt-get", "sleep", "date"]) await chmod(join(dir, name), 0o755);
  await writeFile(join(dir, "calls"), "");
  await writeFile(join(dir, "uptime"), "1000.37 3912.08\n");
  const ours = vpsApt.replaceAll("/proc/uptime", join(dir, "uptime"));
  const script = `set -u\nwork=${dir}\nsay() { printf '%s\\n' "$*"; }\nfail() { printf 'agentrun install: %s\\n' "$*" >&2; exit 1; }\n${ours}vps_apt ${verb}\n`;
  await writeFile(join(dir, "script.sh"), script);
  const env = { PATH: `${dir}:${process.env.PATH}`, FAKE: dir, LOCKED: String(locked), THEN: String(then), LOCK: lock, TOOK: String(took), LANG: "de_DE.UTF-8" };
  if (tookFirst !== undefined) env.TOOK_FIRST = String(tookFirst);
  const result = await promisify(execFile)("sh", [join(dir, "script.sh")], { env }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  const calls = (await readFile(join(dir, "calls"), "utf8")).trim().split("\n").filter(Boolean);
  return { ...result, calls };
}

/** The DPkg::Lock::Timeout a call passed. */
const lockTimeout = (call) => Number(/(?:^| )-o DPkg::Lock::Timeout=(\d+)(?: |$)/.exec(call)?.[1]);

test("install.sh has vps_apt, and its clock is the time since boot", () => {
  assert.ok(vpsApt, "vps_apt() { ... } in install.sh");
  assert.match(vpsApt, /\/proc\/uptime/);
  assert.doesNotMatch(vpsApt, /\bdate\b/, "the wall clock, which a first boot's time sync steps, is never read");
});

// apt-daily's download-only run on first boot holds the archives' lock and not dpkg's: `apt-get install` takes it with a
// plain lock call that DPkg::Lock::Timeout does not cover, so it is refused at once.
test("vps_apt waits out apt's locks on a server set to another language: the archives' lock an install is refused is tried again, the first try waiting up to 600 s for dpkg's and each later one for the time left", async (t) => {
  const { code, calls, stdout, stderr } = await run(t, { locked: 2, then: 0 });
  assert.equal(code, 0, stderr);
  assert.equal(calls.length, 3, "two tries refused a lock, the third ran");
  assert.equal(stdout.match(/Waiting for the apt-get/g)?.length, 1, "said once");
  assert.deepEqual(calls.map(lockTimeout), [600, 595, 590], "600 s, then the deadline 600 s after the first refusal less the 5 s waits");
  for (const call of calls) assert.match(call, / install docker-ce$/, call);
});

test("vps_apt tries the package lists' lock again, which `apt-get update` takes", async (t) => {
  const { code, calls, stderr } = await run(t, { locked: 1, then: 0, lock: "/var/lib/apt/lists/lock", verb: "update" });
  assert.equal(code, 0, stderr);
  assert.equal(calls.length, 2);
});

test("vps_apt stops at once, with apt-get's last lines, on any failure but a lock", async (t) => {
  const { code, calls, stderr } = await run(t, { locked: 0, then: 100 });
  assert.equal(code, 1);
  assert.equal(calls.length, 1, "not tried again");
  assert.match(stderr, /Unable to locate package docker-ce/);
  assert.match(stderr, /agentrun install: apt-get install docker-ce failed/);
});

// DPkg::Lock::Timeout=600 has already waited for dpkg's lock when apt-get says it could not get it: one more try per 5 s
// would hold a stuck dpkg (an unattended-upgrades that hangs on first boot) for 120 more of those waits, about 20 hours.
test("vps_apt stops on dpkg's lock, which apt-get has already waited 600 s for", async (t) => {
  for (const lock of ["/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock"]) {
    const { code, calls, stderr } = await run(t, { locked: 5, then: 0, lock });
    assert.equal(code, 1, lock);
    assert.equal(calls.length, 1, `${lock}: not tried again, its own wait was the 600 s`);
    assert.ok(stderr.includes(`Could not get lock ${lock}`), stderr);
    assert.match(stderr, /agentrun install: apt-get install docker-ce failed/);
  }
});

// The bound: tries 5 s apart from the first refusal until 600 s have passed, so 120 tries again and no more.
test("vps_apt tries again for 600 s from the first refusal, and no longer", async (t) => {
  const { code, calls, stderr } = await run(t, { locked: 1000, then: 0 });
  assert.equal(code, 1, stderr);
  assert.equal(calls.length, 121, "the first try, then one every 5 s for 600 s");
  assert.equal(lockTimeout(calls.at(-1)), 0, "the last try waits no more for dpkg's lock: the deadline has come");
  assert.ok(stderr.includes(`Could not get lock ${ARCHIVES}`), stderr);
  assert.match(stderr, /agentrun install: apt-get install docker-ce failed/);
});

// unattended-upgrades holds dpkg's lock for 590 s, then apt-daily takes the archives' lock as the first try gets dpkg's: the
// 600 s start at that refusal, so the tries again still have their window, and the whole wait stays under about 1200 s.
test("vps_apt's 600 s start at the first refusal, however long the first try waited for dpkg's lock", async (t) => {
  const { code, calls, stderr } = await run(t, { locked: 10, then: 0, tookFirst: 590 });
  assert.equal(code, 0, stderr);
  assert.equal(calls.length, 11, "ten refusals, all inside the 600 s after the first, then the run");
  assert.equal(lockTimeout(calls[0]), 600);
  assert.equal(lockTimeout(calls[1]), 595, "a later try waits for dpkg's lock only for the time left");
});

// A later try can itself wait for dpkg's lock before the archives' lock refuses it: the deadline, not the 5 s sleeps,
// ends the tries, or such a box loops 120 tries of up to 605 s each.
test("vps_apt stops trying again at the deadline, however long each try took", async (t) => {
  const { code, calls, stderr } = await run(t, { locked: 5, then: 0, took: 400 });
  assert.equal(code, 1, stderr);
  assert.equal(calls.length, 3, "refused at 400 s (the deadline then 1000 s), again at 805 s, again past 1000 s: stopped");
  assert.ok(stderr.includes(`Could not get lock ${ARCHIVES}`), stderr);
  assert.match(stderr, /agentrun install: apt-get install docker-ce failed/);
});
