// install.sh --vps installs Docker with apt-get on a server that has just booted, where cloud-init, apt-daily or
// unattended-upgrades may hold apt's locks for minutes (a Droplet whose user data runs the installer starts it on first
// boot). vps_apt waits for them: dpkg's lock through DPkg::Lock::Timeout, and every other lock apt-get could not get (the
// archives' that `install` takes, the lists' that `update` takes), which that option does not cover, by trying again
// until 600 s by the clock have passed since the first try.
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

// A stand-in apt-get on a server set to German: it logs its arguments, says it could not get the lock at $LOCK for its
// first $LOCKED calls (in English only under LC_ALL=C, as apt does), then exits $THEN (0, or 100 with another error).
// Each call takes $TOOK seconds of the stand-in clock ($FAKE/clock, which the stand-in date reads and sleep moves on).
const APT = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE/calls"
echo $(($(cat "$FAKE/clock") + TOOK)) > "$FAKE/clock"
n=$(wc -l < "$FAKE/calls")
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

async function run(t, { locked, then, lock = ARCHIVES, verb = "install docker-ce", took = 0 }) {
  const dir = await mkdtemp(join(tmpdir(), "vps-apt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "apt-get"), APT);
  // The waits between tries, at once, and the clock they move on: date +%s reads it.
  await writeFile(join(dir, "sleep"), '#!/bin/sh\necho $(($(cat "$FAKE/clock") + $1)) > "$FAKE/clock"\n');
  await writeFile(join(dir, "date"), '#!/bin/sh\ncat "$FAKE/clock"\n');
  for (const name of ["apt-get", "sleep", "date"]) await chmod(join(dir, name), 0o755);
  await writeFile(join(dir, "calls"), "");
  await writeFile(join(dir, "clock"), "1000\n");
  const script = `set -u\nwork=${dir}\nsay() { printf '%s\\n' "$*"; }\nfail() { printf 'agentrun install: %s\\n' "$*" >&2; exit 1; }\n${vpsApt}vps_apt ${verb}\n`;
  await writeFile(join(dir, "script.sh"), script);
  const result = await promisify(execFile)("sh", [join(dir, "script.sh")], {
    env: { PATH: `${dir}:${process.env.PATH}`, FAKE: dir, LOCKED: String(locked), THEN: String(then), LOCK: lock, TOOK: String(took), LANG: "de_DE.UTF-8" },
  }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  const calls = (await readFile(join(dir, "calls"), "utf8")).trim().split("\n").filter(Boolean);
  return { ...result, calls };
}

test("install.sh has vps_apt", () => assert.ok(vpsApt, "vps_apt() { ... } in install.sh"));

// apt-daily's download-only run on first boot holds the archives' lock and not dpkg's: `apt-get install` takes it with a
// plain lock call that DPkg::Lock::Timeout does not cover, so it is refused at once.
test("vps_apt waits out apt's locks on a server set to another language: the archives' lock an install is refused is tried again, and every apt-get waits up to 600 s for dpkg's", async (t) => {
  const { code, calls, stdout, stderr } = await run(t, { locked: 2, then: 0 });
  assert.equal(code, 0, stderr);
  assert.equal(calls.length, 3, "two tries refused a lock, the third ran");
  assert.equal(stdout.match(/Waiting for the apt-get/g)?.length, 1, "said once");
  for (const call of calls) {
    assert.match(call, /(^| )-o DPkg::Lock::Timeout=600( |$)/, call);
    assert.match(call, / install docker-ce$/, call);
  }
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

// One try can first wait out DPkg::Lock::Timeout's 600 s for dpkg's lock and only then be refused the archives' lock: the
// 600 s are the clock's since the first try, not the 5 s sleeps between tries, or such a box loops ~120 tries of 605 s.
test("vps_apt stops trying again once 600 s have passed by the clock, however long each try took", async (t) => {
  const { code, calls, stderr } = await run(t, { locked: 5, then: 0, took: 400 });
  assert.equal(code, 1, stderr);
  assert.equal(calls.length, 2, "the first try ended at 400 s and was tried again; the second ended past 600 s and stopped");
  assert.ok(stderr.includes(`Could not get lock ${ARCHIVES}`), stderr);
  assert.match(stderr, /agentrun install: apt-get install docker-ce failed/);
});
