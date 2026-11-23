// install.sh --vps installs Docker with apt-get on a server that has just booted, where cloud-init or unattended-upgrades
// may hold apt's locks for minutes (a Droplet whose user data runs the installer starts it on first boot). vps_apt waits
// for them: dpkg's lock through DPkg::Lock::Timeout, and the package lists' lock, which that option does not cover, by
// trying again while apt-get says it could not get a lock. Any other failure stops the install at once, as before.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const INSTALL = new URL("../install.sh", import.meta.url);
const vpsApt = /^vps_apt\(\) \{\n[\s\S]*?\n\}\n/m.exec(await readFile(INSTALL, "utf8"))?.[0];

// A stand-in apt-get: it logs its arguments, says it could not get the lists' lock for its first $LOCKED calls, then
// exits $THEN (0, or 100 with another error).
const APT = String.raw`#!/bin/sh
printf '%s\n' "$*" >> "$FAKE/calls"
n=$(wc -l < "$FAKE/calls")
if [ "$n" -le "$LOCKED" ]; then
  echo "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 812 (apt-get)" >&2
  exit 100
fi
[ "$THEN" = 0 ] || echo "E: Unable to locate package docker-ce" >&2
exit "$THEN"
`;

async function run(t, { locked, then }) {
  const dir = await mkdtemp(join(tmpdir(), "vps-apt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "apt-get"), APT);
  await writeFile(join(dir, "sleep"), "#!/bin/sh\nexit 0\n"); // the waits between tries, at once
  await chmod(join(dir, "apt-get"), 0o755);
  await chmod(join(dir, "sleep"), 0o755);
  await writeFile(join(dir, "calls"), "");
  const script = `set -u\nwork=${dir}\nsay() { printf '%s\\n' "$*"; }\nfail() { printf 'agentrun install: %s\\n' "$*" >&2; exit 1; }\n${vpsApt}vps_apt install docker-ce\n`;
  await writeFile(join(dir, "script.sh"), script);
  const result = await promisify(execFile)("sh", [join(dir, "script.sh")], {
    env: { PATH: `${dir}:${process.env.PATH}`, FAKE: dir, LOCKED: String(locked), THEN: String(then) },
  }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  const calls = (await readFile(join(dir, "calls"), "utf8")).trim().split("\n").filter(Boolean);
  return { ...result, calls };
}

test("install.sh has vps_apt", () => assert.ok(vpsApt, "vps_apt() { ... } in install.sh"));

test("vps_apt waits out apt's locks: every apt-get it runs waits up to 600 s for dpkg's lock, and a lists lock is tried again", async (t) => {
  const { code, calls, stdout, stderr } = await run(t, { locked: 2, then: 0 });
  assert.equal(code, 0, stderr);
  assert.equal(calls.length, 3, "two tries refused a lock, the third ran");
  assert.equal(stdout.match(/Waiting for the apt-get/g)?.length, 1, "said once");
  for (const call of calls) {
    assert.match(call, /(^| )-o DPkg::Lock::Timeout=600( |$)/, call);
    assert.match(call, / install docker-ce$/, call);
  }
});

test("vps_apt stops at once, with apt-get's last lines, on any failure but a lock", async (t) => {
  const { code, calls, stderr } = await run(t, { locked: 0, then: 100 });
  assert.equal(code, 1);
  assert.equal(calls.length, 1, "not tried again");
  assert.match(stderr, /Unable to locate package docker-ce/);
  assert.match(stderr, /agentrun install: apt-get install docker-ce failed/);
});
