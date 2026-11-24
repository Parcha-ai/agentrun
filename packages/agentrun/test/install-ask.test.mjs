// install.sh asks before it makes AgentRun a service of the user (GRE-4837): want_service, run on its own with the
// terminal it asks on standing in as a file. Yes only for y or yes; No for anything else, and always under --no-service;
// with no terminal to ask in, yes, as the installer did before it asked.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const INSTALL = new URL("../install.sh", import.meta.url);
const wantService = /^want_service\(\) \{\n[\s\S]*?\n\}\n/m.exec(await readFile(INSTALL, "utf8"))?.[0];

async function ask(t, { answer, noService = "", terminal = true }) {
  const dir = await mkdtemp(join(tmpdir(), "install-ask-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tty = terminal ? join(dir, "tty") : join(dir, "none", "tty");
  if (terminal) await writeFile(tty, answer === undefined ? "" : `${answer}\n`);
  await writeFile(join(dir, "script.sh"), `set -u\nno_service=${noService}\n${wantService}want_service ${tty}\n`);
  return promisify(execFile)("sh", [join(dir, "script.sh")]).then(() => 0, (e) => e.code);
}

test("install.sh has want_service", () => assert.ok(wantService, "want_service() { ... } in install.sh"));

test("a service only for y or yes; No for anything else, an empty line included", async (t) => {
  for (const yes of ["y", "Y", "yes", "YES"]) assert.equal(await ask(t, { answer: yes }), 0, yes);
  for (const no of ["", "n", "no", "maybe"]) assert.equal(await ask(t, { answer: no }), 1, JSON.stringify(no));
});

test("--no-service says no without asking, and no terminal to ask in keeps the service, as before", async (t) => {
  assert.equal(await ask(t, { answer: "y", noService: "1" }), 1);
  assert.equal(await ask(t, { terminal: false }), 0);
});

// The installer's choice once AgentRun is installed (its `default)` start), run with a fake agentrun whose
// `service status` exits as a service manager would: 0 or 1 a service is there, 3 none.
const choice = /^    default\)\n([\s\S]*?)\n      ;;\n  esac/m.exec(await readFile(INSTALL, "utf8"))?.[1];
const refusal = /^no_service_over_service\(\) \{\n[\s\S]*?\n\}\n/m.exec(await readFile(INSTALL, "utf8"))?.[0];
async function started(t, { status, noService = "", wanted = false }) {
  const dir = await mkdtemp(join(tmpdir(), "install-start-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shim = join(dir, "agentrun");
  await writeFile(shim, `#!/bin/sh\necho "agentrun $*"\n[ "$1 $2" = "service status" ] && exit ${status}\nexit 0\n`, { mode: 0o755 });
  const script = [
    "set -u", `no_service=${noService}`, "ts_flag=", "version=test", "why=", `shim=${shim}`,
    'say() { echo "say: $*"; }', "start_background() { echo start_background; }", "stop_background() { echo stop_background; }",
    "service_manager() { return 0; }", `want_service() { return ${wanted ? 0 : 1}; }`, "shown_shim() { echo agentrun; }",
    'fail() { printf "agentrun install: %s\\n" "$*" >&2; exit 1; }', refusal, choice,
  ].join("\n");
  await writeFile(join(dir, "script.sh"), `${script}\n`);
  const { stdout, stderr, code = 0 } = await promisify(execFile)("sh", [join(dir, "script.sh")]).catch((e) => e);
  const ran = stdout.split("\n").filter((line) => line && !line.startsWith("say: ") && line !== "agentrun service status");
  return code === 0 ? ran : { code, ran, stderr };
}

test("install.sh's start has its default branch and its --no-service refusal", () => {
  assert.ok(choice, "    default) ... ;; esac in install.sh");
  assert.ok(refusal, "no_service_over_service() { ... } in install.sh");
});

// A service keeps what it was installed with (--data, --port, --tailscale, --env, --public-url); a background start has
// none of it, so --no-service over a service stops and leaves the service as it is.
test("--no-service where a service is installed stops, and neither removes, restarts nor replaces the service", async (t) => {
  for (const status of [0, 1]) {
    const result = await started(t, { status, noService: "1" });
    assert.equal(result.code, 1, `status ${status}`);
    assert.deepEqual(result.ran, [], `status ${status}`);
    assert.match(result.stderr, /--no-service, but AgentRun is a service of this user already/);
    assert.match(result.stderr, /agentrun service uninstall/);
  }
});

// The whole installer, with an AgentRun already installed as a service: it stops before it downloads or writes
// anything. The --package it is given does not exist, so getting past the check would fail on that instead.
test("the installer refuses --no-service over a service before it downloads anything", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "install-refuse-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const log = join(home, "calls");
  await mkdir(join(home, ".agentrun", "bin"), { recursive: true });
  const run = async (status) => {
    await writeFile(join(home, ".agentrun", "bin", "agentrun"), `#!/bin/sh\necho "$*" >> '${log}'\n[ "$1 $2" = "service status" ] && exit ${status}\nexit 0\n`, { mode: 0o755 });
    await rm(log, { force: true });
    const { code = 0, stderr } = await promisify(execFile)("sh", [fileURLToPath(INSTALL), "--no-service", "--package", join(home, "missing.tgz")], { env: { ...process.env, HOME: home } }).catch((e) => e);
    return { code, stderr, calls: (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean), left: await readdir(join(home, ".agentrun")) };
  };
  const refused = await run(0);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /--no-service, but AgentRun is a service of this user already/);
  assert.deepEqual(refused.calls, ["service status"]);
  assert.deepEqual(refused.left, ["bin"]);
  const none = await run(3);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /missing\.tgz: no such file/);
});

test("without --no-service an installed service restarts; with none, a No runs in the background and a Yes installs it", async (t) => {
  assert.deepEqual(await started(t, { status: 0 }), ["agentrun service restart"]);
  assert.deepEqual(await started(t, { status: 3 }), ["start_background"]);
  assert.deepEqual(await started(t, { status: 3, noService: "1" }), ["start_background"]);
  assert.deepEqual(await started(t, { status: 3, wanted: true }), ["stop_background", "agentrun service install"]);
});
