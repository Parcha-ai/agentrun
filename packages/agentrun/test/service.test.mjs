// `agentrun service`: the LaunchAgent and the systemd user unit it writes, what it asks launchctl and systemctl to do for
// each verb (a fake runs in their place: no service is installed on the machine that runs this), the wait for /health,
// and the wiring from the bin. The installer's flags and its refusals.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LABEL, UNIT, INSTALL_COMMAND, managerOf, plistArgs, plistText, serviceOf, systemdWord, systemdWords, unitArgs, unitText } from "../lib/service.mjs";
import { removeAtEnd } from "./support.mjs";

const PACKAGE = new URL("..", import.meta.url).pathname;
const BIN = join(PACKAGE, "bin", "agentrun.mjs");
const INSTALLER = join(PACKAGE, "install.sh");
const VERSION = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8")).version;

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-service-"));
  removeAtEnd(dir);
  return dir;
};
class Fail extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => new Fail(code, message);
const ioOf = () => {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } } };
};

/** A fake exec: each call recorded as "command arg ...", answered by `answer` (status 0 and no output by default). */
const execOf = (answer = () => ({})) => {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args].join(" "));
    return { status: 0, stdout: "", stderr: "", ...answer(command, args) };
  };
  return { calls, exec };
};

const ODD = ["--data", "/u/mac b/data & <more> \"quoted\" 100% $HOME", "--port", "7340"];

test("the LaunchAgent: its label, arguments, PATH and log, started at login and again after a failed exit", () => {
  const text = plistText({ program: "/u/mac/.agentrun/bin/agentrun", args: ["--no-open", ...ODD], path: "/opt/homebrew/bin:/usr/bin", log: "/u/mac/.agentrun/logs/agentrun.log" });
  assert.match(text, new RegExp(`<key>Label</key>\\s*<string>${LABEL.replace(/\./g, "\\.")}</string>`));
  assert.match(text, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(text, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  assert.match(text, /<key>StandardOutPath<\/key>\s*<string>\/u\/mac\/\.agentrun\/logs\/agentrun\.log<\/string>/);
  assert.match(text, /<key>StandardErrorPath<\/key>\s*<string>\/u\/mac\/\.agentrun\/logs\/agentrun\.log<\/string>/);
  assert.match(text, /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  assert.match(text, /&amp; &lt;more&gt; &quot;quoted&quot;/);
  assert.deepEqual(plistArgs(text), ["/u/mac/.agentrun/bin/agentrun", "--no-open", ...ODD]);
});

test("the systemd user unit: its command quoted as systemd reads it, restarted on failure, its output appended to the log", () => {
  const text = unitText({ program: "/u/linux/.agentrun/bin/agentrun", args: ["--no-open", ...ODD], path: "/u/linux/bin:/usr/bin", log: "/u/linux/.agentrun/logs/agentrun.log" });
  const line = (key) => new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1];
  assert.equal(line("ExecStart"), '/u/linux/.agentrun/bin/agentrun --no-open --data "/u/mac b/data & <more> \\"quoted\\" 100%% $$HOME" --port 7340');
  assert.equal(line("Environment"), "PATH=/u/linux/bin:/usr/bin");
  assert.equal(line("Restart"), "on-failure");
  assert.equal(line("StandardOutput"), "append:/u/linux/.agentrun/logs/agentrun.log");
  assert.equal(line("StandardError"), "append:/u/linux/.agentrun/logs/agentrun.log");
  assert.equal(line("WantedBy"), "default.target");
  assert.deepEqual(unitArgs(text), ["/u/linux/.agentrun/bin/agentrun", "--no-open", ...ODD]);
  assert.equal(systemdWord("plain/path-1.0"), "plain/path-1.0");
  assert.deepEqual(systemdWords(systemdWord("a\\b \"c\"")), ["a\\b \"c\""]);
});

test("launchd: install boots the job into this user's GUI domain, restart kicks it, stop and remove boot it out", () => {
  let loaded = false;
  const { calls, exec } = execOf((command, args) => {
    if (args[0] === "print") return args[1] === "gui/501" || loaded ? { stdout: "\tstate = running\n\tpid = 4242\n" } : { status: 113 };
    if (args[0] === "bootstrap") loaded = true;
    if (args[0] === "bootout") loaded = false;
    return {};
  });
  const manager = managerOf({ platform: "darwin", home: "/u/mac", uid: 501, user: "a", env: {}, exec, fail });
  assert.equal(manager.file, `/u/mac/Library/LaunchAgents/${LABEL}.plist`);
  assert.equal(manager.available(), undefined);
  assert.deepEqual(calls.splice(0), ["launchctl print gui/501"]);
  manager.install();
  assert.deepEqual(calls.splice(0), [`launchctl print gui/501/${LABEL}`, `launchctl enable gui/501/${LABEL}`, `launchctl bootstrap gui/501 ${manager.file}`]);
  manager.install();
  assert.deepEqual(calls.splice(0), [`launchctl print gui/501/${LABEL}`, `launchctl bootout gui/501/${LABEL}`, `launchctl enable gui/501/${LABEL}`, `launchctl bootstrap gui/501 ${manager.file}`]);
  manager.restart();
  assert.deepEqual(calls.splice(0), [`launchctl print gui/501/${LABEL}`, `launchctl kickstart -k gui/501/${LABEL}`]);
  assert.deepEqual(manager.state(), { active: true, words: "running, pid 4242" });
  calls.splice(0);
  manager.stop();
  assert.deepEqual(calls.splice(0), [`launchctl print gui/501/${LABEL}`, `launchctl bootout gui/501/${LABEL}`]);
  manager.start();
  assert.deepEqual(calls.splice(0), [`launchctl print gui/501/${LABEL}`, `launchctl bootstrap gui/501 ${manager.file}`]);
  assert.deepEqual(manager.notes(), []);
});

test("launchd: a login with no GUI session says so", () => {
  const { exec } = execOf(() => ({ status: 113 }));
  assert.match(managerOf({ platform: "darwin", home: "/u/mac", uid: 501, user: "a", env: {}, exec, fail }).available(), /no launchd session \(gui\/501\)/);
});

test("systemd: install reloads, enables and restarts the unit; the linger line is said only when lingering is off", () => {
  let linger = "no";
  const { calls, exec } = execOf((command, args) => (command === "loginctl" ? { stdout: `${linger}\n` } : args[1] === "show" ? { stdout: "ActiveState=active\nSubState=running\nMainPID=99\n" } : {}));
  const manager = managerOf({ platform: "linux", home: "/u/linux", uid: 1000, user: "a", env: { XDG_CONFIG_HOME: "/u/linux/conf" }, exec, fail });
  assert.equal(manager.file, `/u/linux/conf/systemd/user/${UNIT}`);
  manager.install();
  assert.deepEqual(calls.splice(0), ["systemctl --user daemon-reload", `systemctl --user enable ${UNIT}`, `systemctl --user restart ${UNIT}`]);
  for (const verb of ["start", "stop", "restart"]) manager[verb]();
  assert.deepEqual(calls.splice(0), ["start", "stop", "restart"].map((verb) => `systemctl --user ${verb} ${UNIT}`));
  manager.remove();
  manager.removed();
  assert.deepEqual(calls.splice(0), [`systemctl --user disable --now ${UNIT}`, `systemctl --user reset-failed ${UNIT}`, "systemctl --user daemon-reload"]);
  assert.deepEqual(manager.state(), { active: true, words: "active (running), pid 99" });
  assert.deepEqual(manager.notes(), ["It stops when you log out and starts when you log in. To keep it running, and start it at boot, run once: sudo loginctl enable-linger a"]);
  assert.ok(calls.includes("loginctl show-user a --property=Linger --value"));
  linger = "yes";
  assert.deepEqual(manager.notes(), []);
});

test("systemd: no systemd, or no user session, is said in words; a failed systemctl names itself", () => {
  const none = execOf(() => ({ status: null, error: Object.assign(new Error("spawnSync systemctl ENOENT"), { code: "ENOENT" }) }));
  assert.equal(managerOf({ platform: "linux", home: "/h", uid: 1, user: "a", env: {}, exec: none.exec, fail }).available(), "this machine has no systemd");
  const bus = execOf(() => ({ status: 1, stderr: "Failed to connect to bus: No medium found\n" }));
  const manager = managerOf({ platform: "linux", home: "/h", uid: 1, user: "a", env: {}, exec: bus.exec, fail });
  assert.match(manager.available(), /no systemd user session/);
  assert.throws(() => manager.restart(), (error) => error.code === 1 && /systemctl --user restart agentrun.service failed: Failed to connect to bus/.test(error.message));
  assert.equal(managerOf({ platform: "win32", home: "/h", uid: 1, user: "a", env: {}, exec: bus.exec, fail }), undefined);
});

/** A home with the installer's command in it, a fake systemd that "starts" a server by writing its record, and a /health
 *  that answers `health`. */
function linuxHome({ health = "ok", lingering = "yes" } = {}) {
  const home = fresh();
  mkdirSync(join(home, ".agentrun", "bin"), { recursive: true });
  writeFileSync(join(home, ".agentrun", "bin", "agentrun"), "#!/bin/sh\n", { mode: 0o755 });
  const { calls, exec } = execOf((command, args) => {
    if (command === "loginctl") return { stdout: `${lingering}\n` };
    if (args[1] === "show") return { stdout: "ActiveState=active\nSubState=running\nMainPID=7\n" };
    if (["restart", "start"].includes(args[1])) {
      const data = /--data (\S+)/.exec(readFileSync(join(home, ".config", "systemd", "user", UNIT), "utf8"))?.[1] ?? join(home, ".agentrun");
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, ".server.json"), JSON.stringify({ base_url: "http://127.0.0.1:7345/v2", pid: process.pid, token_file: true }));
    }
    return {};
  });
  const fetched = [];
  const get = async (url) => (fetched.push(url), { ok: health === "ok", status: health === "ok" ? 200 : 503, json: async () => ({ status: health }) });
  return { home, calls, exec, get, fetched };
}

test("service install writes the unit for the installer's command, starts it, waits for /health and says where it is", async () => {
  const { home, calls, exec, get, fetched } = linuxHome({ lingering: "no" });
  const { out, io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: { PATH: "/usr/local/bin:/usr/bin" }, exec, io, fail, get, waitMs: 5_000 });
  assert.equal(await service.install({ port: "7345" }), 0);
  const unit = readFileSync(join(home, ".config", "systemd", "user", UNIT), "utf8");
  assert.deepEqual(unitArgs(unit), [join(home, ".agentrun", "bin", "agentrun"), "--no-open", "--port", "7345"]);
  assert.match(unit, /^Environment=PATH=\/usr\/local\/bin:\/usr\/bin$/m);
  assert.ok(existsSync(join(home, ".agentrun", "logs")));
  assert.deepEqual(calls.filter((call) => call.startsWith("systemctl")), ["systemctl --user show-environment", "systemctl --user daemon-reload", `systemctl --user enable ${UNIT}`, `systemctl --user restart ${UNIT}`]);
  assert.deepEqual(fetched, ["http://127.0.0.1:7345/v2/health"]);
  const said = out.join("");
  assert.match(said, /AgentRun is running at http:\/\/127\.0\.0\.1:7345\/ \(systemd --user agentrun\.service\)/);
  assert.match(said, /sudo loginctl enable-linger a/);

  const status = ioOf();
  const again = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec, io: status.io, fail, get });
  assert.equal(await again.status(), 0);
  assert.match(status.out.join(""), /Service: systemd --user agentrun\.service, active \(running\), pid 7\nConsole: http:\/\/127\.0\.0\.1:7345\/\nHealth: ok/);
});

test("service install with --data waits on that directory's server, and a restart waits for a record newer than itself", async () => {
  const { home, exec, get } = linuxHome();
  const data = join(home, "elsewhere");
  const { io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec, io, fail, get, waitMs: 5_000 });
  assert.equal(await service.install({ data }), 0);
  assert.ok(existsSync(join(data, ".server.json")));
  assert.equal(await service.restart(), 0);
});

test("a server that never answers ok: the wait ends, says its state and the log's last lines, exit 1", async () => {
  const { home, exec, get } = linuxHome({ health: "starting" });
  mkdirSync(join(home, ".agentrun", "logs"), { recursive: true });
  writeFileSync(join(home, ".agentrun", "logs", "agentrun.log"), "first\nAgentRun did not start: the port is taken.\n");
  const { err, io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec, io, fail, get, waitMs: 600 });
  assert.equal(await service.install({}), 1);
  assert.match(err.join(""), /did not answer \/health ok within 0\.6 s \(503 starting\)\. Its state: active \(running\), pid 7\.\n.*\n  first\n  AgentRun did not start: the port is taken\./);
});

test("service install refuses without the installer's command, or without a service manager; status says not installed, exit 3", async () => {
  const home = fresh();
  const { exec } = execOf();
  const { out, io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec, io, fail });
  await assert.rejects(service.install({}), (error) => error.code === 1 && error.message.includes(INSTALL_COMMAND));
  assert.equal(await service.status(), 3);
  assert.match(out.join(""), /not installed: agentrun service install installs it/);
  await assert.rejects(service.start(), (error) => error.code === 3);
  assert.equal(await service.uninstall(), 0);

  mkdirSync(join(home, ".agentrun", "bin"), { recursive: true });
  writeFileSync(join(home, ".agentrun", "bin", "agentrun"), "");
  const container = execOf(() => ({ status: 1, stderr: "System has not been booted with systemd as init system (PID 1).\n" }));
  const there = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec: container.exec, io, fail });
  await assert.rejects(there.install({}), (error) => error.code === 1 && /can't run as a service here: this user has no systemd user session/.test(error.message));
  await assert.rejects(there.install({ port: "x" }), (error) => error.code === 2 && /--port takes a port number/.test(error.message));
});

test("service uninstall disables the unit and removes its file; upgrade runs the installer, then the new command's restart", async () => {
  const { home, calls, exec, get } = linuxHome();
  const { out, io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec, io, fail, get, waitMs: 5_000 });
  await service.install({});
  calls.splice(0);
  assert.equal(await service.upgrade({ version: "0.4.99" }), 0);
  assert.deepEqual(calls, [`sh ${join(PACKAGE, "install.sh")} --no-start --version 0.4.99`, `${join(home, ".agentrun", "bin", "agentrun")} service restart`]);
  calls.splice(0);
  assert.equal(await service.uninstall(), 0);
  assert.equal(existsSync(join(home, ".config", "systemd", "user", UNIT)), false);
  assert.deepEqual(calls, [`systemctl --user disable --now ${UNIT}`, `systemctl --user reset-failed ${UNIT}`, "systemctl --user daemon-reload"]);
  assert.match(out.join(""), /Removed AgentRun's service .*Its data stays in/);

  const failed = execOf((command) => (command === "sh" ? { status: 1 } : {}));
  const halted = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec: failed.exec, io, fail });
  await assert.rejects(halted.upgrade({}), (error) => error.code === 1 && /installer stopped \(exit 1\); the service was not restarted/.test(error.message));
  assert.deepEqual(failed.calls, [`sh ${join(PACKAGE, "install.sh")} --no-start`]);
});

test("service logs prints the log's last lines", async () => {
  const home = fresh();
  mkdirSync(join(home, ".agentrun", "logs"), { recursive: true });
  writeFileSync(join(home, ".agentrun", "logs", "agentrun.log"), "one\ntwo\nthree\n");
  const { out, io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec: execOf().exec, io, fail });
  assert.equal(await service.logs({ lines: "2" }), 0);
  assert.equal(out.join(""), "two\nthree\n");
  out.splice(0);
  assert.equal(await service.logs({ lines: "0" }), 0);
  assert.equal(out.join(""), "");
  await assert.rejects(service.logs({ lines: "-1" }), (error) => error.code === 2);

  // A long log is read from its end: the last lines whole, a character split across a read boundary included.
  const long = Array.from({ length: 20_000 }, (_, i) => `line ${i} é`).join("\n");
  writeFileSync(join(home, ".agentrun", "logs", "agentrun.log"), `${long}\n\nlast, no newline ✓`);
  out.splice(0);
  assert.equal(await service.logs({ lines: "3" }), 0);
  assert.equal(out.join(""), "line 19999 é\n\nlast, no newline ✓\n");
  out.splice(0);
  assert.equal(await service.logs({ lines: "20002" }), 0);
  assert.equal(out.join(""), `${long}\n\nlast, no newline ✓\n`);
});

test("service start on a service that is already running accepts its record, however old; a stopped one needs a new record", async () => {
  const { home, exec, get } = linuxHome();
  const { io } = ioOf();
  await serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec, io, fail, get, waitMs: 5_000 }).install({});
  const record = join(home, ".agentrun", ".server.json");
  const old = new Date(Date.now() - 600_000);
  utimesSync(record, old, old);
  const asIs = (active) => execOf((command, args) => (args[1] === "show" ? { stdout: `ActiveState=${active}\nSubState=x\nMainPID=7\n` } : {})).exec;
  const running = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec: asIs("active"), io, fail, get, waitMs: 1_000 });
  assert.equal(await running.start(), 0);
  const stopped = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec: asIs("inactive"), io, fail, get, waitMs: 600 });
  assert.equal(await stopped.start(), 1);
});

/** A process in its own process group, as install.sh starts AgentRun (setsid), running a file under `home`'s
 *  .agentrun/lib; `ignoreTerm` makes it ignore SIGTERM, and `pidFile` false leaves agentrun.pid as it is. Resolves once
 *  it runs, with its exit. */
async function holder(home, { ignoreTerm = false, pidFile = true } = {}) {
  const dir = join(home, ".agentrun", "lib", "0.0.0");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "hold.mjs");
  writeFileSync(file, `${ignoreTerm ? 'process.on("SIGTERM", () => {});\n' : ""}setInterval(() => {}, 1000);\nconsole.log("ready");\n`);
  const child = spawn(process.execPath, [file], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise((done) => child.on("exit", (code, signal) => done(signal ?? code)));
  await new Promise((done) => child.stdout.once("data", done));
  if (pidFile) writeFileSync(join(home, ".agentrun", "agentrun.pid"), `${child.pid}\n`);
  return { child, exited };
}

test("stop: the AgentRun the installer started in the background, and its server, end on a SIGTERM, or a SIGKILL past the wait; none running is exit 3", async () => {
  const home = fresh();
  const pidFile = join(home, ".agentrun", "agentrun.pid");
  const { out, io } = ioOf();
  const service = (stopWaitMs = 5_000) => serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, io, fail, stopWaitMs });

  const one = await holder(home);
  assert.equal(await service().background(), 0);
  assert.equal(await one.exited, "SIGTERM");
  assert.equal(existsSync(pidFile), false);
  assert.match(out.join(""), new RegExp(`Stopped AgentRun \\(pid ${one.child.pid}\\)\\.`));

  const stubborn = await holder(home, { ignoreTerm: true });
  out.splice(0);
  assert.equal(await service(600).background(), 0);
  assert.equal(await stubborn.exited, "SIGKILL");
  assert.match(out.join(""), /still running 0\.6 s after its SIGTERM, so it was sent a SIGKILL/);

  // The launcher ends on its SIGTERM, and its server, in a process group of its own (no setsid), outlives it: the server,
  // the pid in its record, is waited for too and sent the SIGKILL, and only then is AgentRun stopped.
  const launcher = await holder(home);
  const server = await holder(home, { ignoreTerm: true, pidFile: false });
  writeFileSync(join(home, ".agentrun", ".server.json"), JSON.stringify({ base_url: "http://127.0.0.1:7340", pid: server.child.pid }));
  out.splice(0);
  assert.equal(await service(600).background(), 0);
  assert.equal(await launcher.exited, "SIGTERM");
  assert.equal(await server.exited, "SIGKILL");
  assert.equal(existsSync(pidFile), false);
  assert.match(out.join(""), new RegExp(`^AgentRun \\(pid ${server.child.pid}\\) was still running 0\\.6 s after its SIGTERM, so it was sent a SIGKILL\\.\\nStopped AgentRun \\(pid ${launcher.child.pid}\\)\\.\\n$`));

  // No pid file; then a pid file naming a live process that runs nothing of this install (this test's own): neither is
  // stopped, and the stale file goes.
  out.splice(0);
  assert.equal(await service().background(), 3);
  writeFileSync(pidFile, `${process.pid}\n`);
  assert.equal(await service().background(), 3);
  assert.equal(existsSync(pidFile), false);
  assert.match(out.join(""), /^No AgentRun started in the background is running\.\n/);

  // With a service installed, it says the service has a stop of its own.
  mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(join(home, ".config", "systemd", "user", UNIT), "");
  out.splice(0);
  assert.equal(await service().background(), 3);
  assert.match(out.join(""), /AgentRun runs as a service here: agentrun service stop stops it\./);
});

/** The bin, with HOME a fresh folder and a fake systemctl first on PATH that answers as a machine with no user session. */
function bin(args, home = fresh()) {
  const fakes = join(home, "fakes");
  mkdirSync(fakes, { recursive: true });
  writeFileSync(join(fakes, "systemctl"), "#!/bin/sh\necho 'Failed to connect to bus: No medium found' >&2\nexit 1\n");
  chmodSync(join(fakes, "systemctl"), 0o755);
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { HOME: home, PATH: `${fakes}:${process.env.PATH}` } });
}

test("the bin: --version prints the version; help lists service and stop; each verb is wired, and an unknown one is refused", { skip: process.platform !== "linux" && "the wiring runs systemd's path" }, () => {
  assert.equal(bin(["--version"]).stdout, `${VERSION}\n`);
  assert.match(bin(["help"]).stdout, /^ {2}service +install, logs, restart, start, status, stop, uninstall, upgrade$/m);
  assert.match(bin(["help"]).stdout, /^ {2}stop +Stop the AgentRun the installer started in the background/m);
  const stop = bin(["stop"]);
  assert.deepEqual([stop.status, stop.stdout], [3, "No AgentRun started in the background is running.\n"]);
  const status = bin(["service", "status"]);
  assert.equal(status.status, 3);
  assert.match(status.stdout, /not installed/);
  const install = bin(["service", "install"]);
  assert.equal(install.status, 1);
  assert.match(install.stderr, /runs the installed command, .*\.agentrun\/bin\/agentrun, and it is not there\. Install it first: curl -fsSL https:\/\/agentrun\.ai\/install \| sh/);
  const home = fresh();
  mkdirSync(join(home, ".agentrun", "bin"), { recursive: true });
  writeFileSync(join(home, ".agentrun", "bin", "agentrun"), "");
  assert.match(bin(["service", "install"], home).stderr, /can't run as a service here: this user has no systemd user session/);
  assert.match(bin(["service", "logs", "--help"]).stdout, /--follow +and keep printing what comes \(-f\)/);
  assert.equal(bin(["service", "nope"]).status, 2);
});

test("install.sh: POSIX sh syntax, its help, and its refusals before it downloads anything", () => {
  assert.equal(spawnSync("sh", ["-n", INSTALLER]).status, 0);
  const run = (...args) => spawnSync("sh", [INSTALLER, ...args], { encoding: "utf8", env: { HOME: fresh(), PATH: process.env.PATH } });
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--version V.*\n.*--package FILE.*\n.*--node-version V.*\n.*\n.*--no-start.*\n.*--service/);
  assert.match(run("--bogus").stderr, /agentrun install: unknown option --bogus/);
  assert.match(run("--version", "1.0;rm").stderr, /--version 1\.0;rm is not a version or npm tag/);
  assert.match(run("--package", "/nonexistent.tgz").stderr, /--package \/nonexistent\.tgz: no such file/);
  assert.match(run("--node-version", "24.22").stderr, /--node-version 24\.22 is not a Node\.js version \(X\.Y\.Z\)/);
  // --node-version is checked against the floor of the package it installs, part by part as numbers.
  const dir = fresh();
  mkdirSync(join(dir, "package"));
  writeFileSync(join(dir, "package", "package.json"), JSON.stringify({ name: "@parcha/agentrun", version: "9.9.9", engines: { node: ">=24.22.3" } }, null, 2));
  assert.equal(spawnSync("tar", ["-czf", join(dir, "launcher.tgz"), "-C", dir, "package"]).status, 0);
  for (const below of ["24.22.2", "24.9.99", "23.99.99", "v24.3.0"]) {
    assert.match(run("--package", join(dir, "launcher.tgz"), "--node-version", below).stderr, /--node-version v?[\d.]+ is below the Node\.js @parcha\/agentrun 9\.9\.9 needs, 24\.22\.3/, below);
  }
  const quoted = spawnSync("sh", [INSTALLER, "--no-start"], { encoding: "utf8", env: { HOME: "/tmp/it's", PATH: process.env.PATH } });
  assert.match(quoted.stderr, /has a single quote in it/);
});
