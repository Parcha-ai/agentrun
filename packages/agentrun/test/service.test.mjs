// `agentrun service`: the LaunchAgent and the systemd user unit it writes, what it asks launchctl and systemctl to do for
// each verb (a fake runs in their place: no service is installed on the machine that runs this), the wait for /health,
// and the wiring from the bin. The installer's flags and its refusals.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LABEL, UNIT, INSTALL_COMMAND, canOpen, launchOpener, managerOf, plistArgs, plistEnv, plistText, serviceOf, systemdWord, systemdWords, unitArgs, unitEnv, unitText } from "../lib/service.mjs";
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
  assert.deepEqual(fetched, ["http://127.0.0.1:7345/v2/health", "http://127.0.0.1:7345/v2/auth/session"], "once it answers, whether it has an owner yet");
  const said = out.join("");
  assert.match(said, /AgentRun is running at http:\/\/127\.0\.0\.1:7345\/ \(systemd --user agentrun\.service\)/);
  assert.match(said, /sudo loginctl enable-linger a/);

  const status = ioOf();
  const again = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec, io: status.io, fail, get });
  assert.equal(await again.status(), 0);
  assert.match(status.out.join(""), /Service: systemd --user agentrun\.service, active \(running\), pid 7\nConsole: http:\/\/127\.0\.0\.1:7345\/\nHealth: ok/);
});

/** A server with no owner yet behind linuxHome's fake systemd: /health ok, /auth/session as `session`, and POST
 *  /setup/code answering `printed` (a printed code is appended to the log as the server does). */
function setupHome({ session = { accounts: true, password_set: false, signed_in: false, setup_code: true }, printed = false, line = true } = {}) {
  const box = linuxHome();
  const log = join(box.home, ".agentrun", "logs", "agentrun.log");
  mkdirSync(join(box.home, ".agentrun", "logs"), { recursive: true });
  writeFileSync(log, line ? "AgentRun is running at https://box.example.test/\nSet up this server: https://box.example.test/setup#code=OLDCODE1 (or paste AGENTRUN_TOKEN)\n" : "AgentRun is running at https://box.example.test/\n");
  const asked = [];
  const answer = (body) => ({ ok: true, status: 200, json: async () => body });
  box.get = async (url, init = {}) => {
    asked.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.endsWith("/health")) return answer({ status: "ok" });
    if (url.endsWith("/auth/session")) return answer(session);
    if (url.endsWith("/setup/code")) {
      if (printed) writeFileSync(log, `${readFileSync(log, "utf8")}Set up this server: https://box.example.test/setup#code=NEWCODE2 (or paste AGENTRUN_TOKEN)\n`);
      return answer({ printed, expires_at: "2026-11-18T12:30:00.000Z" });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  // The opener is launched, never run through exec: exec waits for its exit, and an opener can stay until the browser closes.
  const run = box.exec;
  box.exec = (command, args, options) => {
    if (["open", "xdg-open"].includes(command)) throw new Error(`${command} went through exec, which waits for the browser`);
    return run(command, args, options);
  };
  box.launch = async (command, args) => (box.calls.push([command, ...args].join(" ")), true);
  return { ...box, asked, log };
}

test("canOpen: a browser on macOS, and on Linux with a display; never in CI", () => {
  assert.equal(canOpen({}, "darwin"), true);
  assert.equal(canOpen({ DISPLAY: ":0" }, "linux"), true);
  assert.equal(canOpen({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
  assert.equal(canOpen({}, "linux"), false);
  assert.equal(canOpen({ CI: "1" }, "darwin"), false);
  assert.equal(canOpen({}, "win32"), false);
});

test("service install on a server with no owner opens its setup page in the browser, the logged setup code filled in", async () => {
  const { home, calls, exec, get, asked, launch } = setupHome();
  const { out, io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: { DISPLAY: ":0" }, exec, io, fail, get, waitMs: 5_000, launch });
  assert.equal(await service.install({}), 0);
  assert.deepEqual(calls.filter((call) => call.startsWith("xdg-open")), ["xdg-open https://box.example.test/setup#code=OLDCODE1"]);
  assert.ok(asked.includes("POST /v2/setup/code"), "a code still good is kept; an expired or spent one is replaced first");
  assert.match(out.join(""), /Opened the setup page in your browser: set the owner password there\./);
  // An opener can start and still find no browser: the link is there to open by hand.
  assert.match(out.join(""), /If no browser opened, open https:\/\/box\.example\.test\/setup#code=OLDCODE1\n/);
  assert.match(out.join(""), /works once and for 30 minutes/);
});

// The service's log holds the setup lines of the server in ~/.agentrun alone: a server started on another --data prints
// its own in its own terminal, so its page opens without a code, never with the service's.
test("agentrun open --data on another server never fills in the service log's code; it says where that server's code is", async () => {
  const box = setupHome();
  const other = join(box.home, "other");
  mkdirSync(other);
  writeFileSync(join(other, ".server.json"), JSON.stringify({ base_url: "http://127.0.0.1:7399/v2", pid: process.pid }));
  const { out, io } = ioOf();
  const service = serviceOf({ platform: "linux", home: box.home, uid: 1000, user: "a", env: { DISPLAY: ":0" }, exec: box.exec, io, fail, get: box.get, launch: box.launch });
  assert.equal(await service.open({ data: other }), 0);
  assert.deepEqual(box.calls.filter((call) => call.startsWith("xdg-open")), ["xdg-open http://127.0.0.1:7399/"]);
  assert.doesNotMatch(out.join(""), /OLDCODE1/);
  assert.match(out.join(""), /Its setup code is in the log of the terminal or service AgentRun runs in/);
});

// A crash or a forced stop leaves .server.json behind: its address answers nothing, so there is nothing to open.
// /v2/health answers 503 when free disk is below its floor, while the console and sign-in still work: a server that
// answers is opened whatever its check says, and the check is said beside it.
test("agentrun open on a server whose health check fails (low disk, 503) still opens it, and says what the check answered", async () => {
  const box = setupHome({ session: { accounts: true, password_set: true, signed_in: false, setup_code: false } });
  writeFileSync(join(box.home, ".agentrun", ".server.json"), JSON.stringify({ base_url: "http://127.0.0.1:7345/v2", pid: process.pid }));
  const answered = box.get;
  const get = async (url, init) => (url.endsWith("/health") ? { ok: false, status: 503, json: async () => ({ status: "degraded", checks: { store: "ok", disk: "low" } }) } : answered(url, init));
  const { out, io } = ioOf();
  assert.equal(await serviceOf({ platform: "darwin", home: box.home, uid: 501, user: "a", env: {}, exec: box.exec, io, fail, get, launch: box.launch }).open({}), 0);
  assert.deepEqual(box.calls.filter((call) => call.startsWith("open ")), ["open http://127.0.0.1:7345/"]);
  assert.match(out.join(""), /Its health check answers 503 degraded \(disk: low\); agentrun service status says more\./);
});

test("agentrun open on a record no server answers says no AgentRun answers, exit 1, and opens nothing", async () => {
  const box = setupHome();
  writeFileSync(join(box.home, ".agentrun", ".server.json"), JSON.stringify({ base_url: "http://127.0.0.1:7345/v2", pid: process.pid }));
  const { err, io } = ioOf();
  const refused = async () => { throw new Error("refused"); };
  assert.equal(await serviceOf({ platform: "darwin", home: box.home, uid: 501, user: "a", env: {}, exec: box.exec, io, fail, get: refused, launch: box.launch }).open({}), 1);
  assert.match(err.join(""), /No AgentRun answers for /);
  assert.deepEqual(box.calls.filter((call) => call.startsWith("open ")), []);
});

test("with no browser here (a remote machine), the setup link is printed for the person, never opened; a new code is waited for", async () => {
  const { home, calls, exec, get, launch } = setupHome({ printed: true });
  const { out, io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec, io, fail, get, waitMs: 5_000, launch });
  assert.equal(await service.install({}), 0);
  assert.deepEqual(calls.filter((call) => call.startsWith("xdg-open")), []);
  assert.match(out.join(""), /Set the owner password at the setup page: https:\/\/box\.example\.test\/setup#code=NEWCODE2\n/, "the newest code, printed after the renewal");
});

test("agentrun open: the setup page with no code on a loopback server; the console once there is an owner; with --setup-only, nothing then", async () => {
  const open = setupHome({ session: { accounts: true, password_set: false, signed_in: false, setup_code: false }, line: false });
  writeFileSync(join(open.home, ".agentrun", ".server.json"), JSON.stringify({ base_url: "http://127.0.0.1:7345/v2", pid: process.pid }));
  const first = ioOf();
  assert.equal(await serviceOf({ platform: "darwin", home: open.home, uid: 501, user: "a", env: {}, exec: open.exec, io: first.io, fail, get: open.get, launch: open.launch }).open({}), 0);
  assert.deepEqual(open.calls.filter((call) => call.startsWith("open ")), ["open http://127.0.0.1:7345/setup"]);
  assert.ok(!open.asked.includes("POST /v2/setup/code"), "setup takes no code here: none is asked for");

  const owned = setupHome({ session: { accounts: true, password_set: true, signed_in: false, setup_code: false } });
  writeFileSync(join(owned.home, ".agentrun", ".server.json"), JSON.stringify({ base_url: "http://127.0.0.1:7345/v2", pid: process.pid }));
  const said = ioOf();
  const service = serviceOf({ platform: "darwin", home: owned.home, uid: 501, user: "a", env: {}, exec: owned.exec, io: said.io, fail, get: owned.get, launch: owned.launch });
  assert.equal(await service.open({ "setup-only": true }), 0);
  assert.deepEqual(owned.calls.filter((call) => call.startsWith("open ")), [], "the installer's last step opens nothing once the owner is set");
  assert.equal(await service.open({}), 0);
  assert.deepEqual(owned.calls.filter((call) => call.startsWith("open ")), ["open http://127.0.0.1:7345/"]);
  assert.match(said.out.join(""), /Opened the console in your browser\./);
});

// An opener that stays in the foreground until the browser closes held `agentrun service install` (and the installer)
// open after the setup page was up, until the browser closed: the opener is started and left running.
test("launchOpener returns once the opener has started, while it still runs; false when there is no such command", async (t) => {
  const dir = fresh();
  const pidFile = join(dir, "opener.pid");
  writeFileSync(join(dir, "xdg-open"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
  const began = Date.now();
  assert.equal(await launchOpener("xdg-open", ["http://127.0.0.1:7345/setup"], { PATH: `${dir}:/usr/bin:/bin` }), true);
  assert.ok(Date.now() - began < 5_000, "it did not wait for the opener to exit");
  for (let waited = 0; !existsSync(pidFile) && waited < 5_000; waited += 50) await new Promise((done) => setTimeout(done, 50));
  const pid = Number(readFileSync(pidFile, "utf8"));
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  });
  assert.doesNotThrow(() => process.kill(pid, 0), "the opener still runs");
  assert.equal(await launchOpener("agentrun-no-such-opener", ["x"], { PATH: dir }), false);
});

test("agentrun open with no server answering says so, exit 1", async () => {
  const home = fresh();
  const { exec } = execOf();
  const { err, io } = ioOf();
  assert.equal(await serviceOf({ platform: "darwin", home, uid: 501, user: "a", env: {}, exec, io, fail, get: async () => { throw new Error("refused"); } }).open({}), 1);
  assert.match(err.join(""), /No AgentRun answers for /);
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

const MODEL_ENV = ["AGENT_MODEL_BASE_URL=http://localhost:11434/v1", "AGENT_MODEL_GATEWAY_IDS=bare", "AGENT_MODEL=qwen3:8b", "AGENT_MODEL_PRICE=0,0,0"];
const MODEL_VARS = Object.fromEntries(MODEL_ENV.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));

test("service install --env: the local model's variables go into the systemd unit, stay through a re-install, and KEY= removes one", async () => {
  const { home, exec, get } = linuxHome();
  const { io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: { PATH: "/usr/bin" }, exec, io, fail, get, waitMs: 5_000 });
  const file = join(home, ".config", "systemd", "user", UNIT);
  assert.equal(await service.install({ port: "7345", env: MODEL_ENV }), 0);
  let unit = readFileSync(file, "utf8");
  assert.match(unit, /^Environment=PATH=\/usr\/bin\nEnvironment=AGENT_MODEL_BASE_URL=http:\/\/localhost:11434\/v1\nEnvironment=AGENT_MODEL_GATEWAY_IDS=bare\nEnvironment=AGENT_MODEL=qwen3:8b\nEnvironment=AGENT_MODEL_PRICE=0,0,0$/m);
  assert.deepEqual(unitEnv(unit), { PATH: "/usr/bin", ...MODEL_VARS });
  // A re-install with no --env keeps them; one --env changes that variable alone, and the port named before stays.
  assert.equal(await service.install({ env: ["AGENT_MODEL=llama3.2 big"] }), 0);
  unit = readFileSync(file, "utf8");
  assert.deepEqual(unitEnv(unit), { PATH: "/usr/bin", ...MODEL_VARS, AGENT_MODEL: "llama3.2 big" });
  assert.deepEqual(unitArgs(unit).slice(1), ["--no-open", "--port", "7345"]);
  assert.equal(await service.install({}), 0);
  assert.equal(unitEnv(readFileSync(file, "utf8")).AGENT_MODEL, "llama3.2 big");
  assert.equal(await service.install({ env: ["AGENT_MODEL=", "AGENT_MODEL_PRICE="] }), 0);
  assert.deepEqual(unitEnv(readFileSync(file, "utf8")), { PATH: "/usr/bin", AGENT_MODEL_BASE_URL: "http://localhost:11434/v1", AGENT_MODEL_GATEWAY_IDS: "bare" });
  // A restart runs the unit as it is.
  const before = readFileSync(file, "utf8");
  assert.equal(await service.restart(), 0);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("service install --env on macOS: the LaunchAgent's EnvironmentVariables, kept through a re-install", async () => {
  const home = fresh();
  mkdirSync(join(home, ".agentrun", "bin"), { recursive: true });
  writeFileSync(join(home, ".agentrun", "bin", "agentrun"), "#!/bin/sh\n", { mode: 0o755 });
  const { exec } = execOf((command, args) => {
    if (args[0] === "print") return args[1] === "gui/501" ? {} : { status: 113 };
    if (args[0] === "bootstrap") writeFileSync(join(home, ".agentrun", ".server.json"), JSON.stringify({ base_url: "http://127.0.0.1:7340/v2", pid: process.pid }));
    return {};
  });
  const get = async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) });
  const { io } = ioOf();
  const service = serviceOf({ platform: "darwin", home, uid: 501, user: "a", env: { PATH: "/opt/homebrew/bin:/usr/bin" }, exec, io, fail, get, waitMs: 5_000 });
  const file = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  assert.equal(await service.install({ env: MODEL_ENV }), 0);
  let plist = readFileSync(file, "utf8");
  assert.match(plist, /<key>AGENT_MODEL_BASE_URL<\/key>\s*<string>http:\/\/localhost:11434\/v1<\/string>/);
  assert.deepEqual(plistEnv(plist), { PATH: "/opt/homebrew/bin:/usr/bin", ...MODEL_VARS });
  assert.equal(await service.install({ env: ["AGENT_MODEL=a&b<c>"] }), 0);
  plist = readFileSync(file, "utf8");
  assert.match(plist, /<string>a&amp;b&lt;c&gt;<\/string>/);
  assert.deepEqual(plistEnv(plist), { PATH: "/opt/homebrew/bin:/usr/bin", ...MODEL_VARS, AGENT_MODEL: "a&b<c>" });
});

test("service install --env: the start-time switches go into the unit at 1, stay through a re-install beside the model's, and KEY= removes one", async () => {
  const { home, exec, get } = linuxHome();
  const { io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: { PATH: "/usr/bin" }, exec, io, fail, get, waitMs: 5_000 });
  const file = join(home, ".config", "systemd", "user", UNIT);
  assert.equal(await service.install({ env: ["AGENTRUN_MCP_ALLOW_LOOPBACK=1", "AGENTRUN_WEBHOOK_PRIVATE_TARGETS=1"] }), 0);
  assert.deepEqual(unitEnv(readFileSync(file, "utf8")), { PATH: "/usr/bin", AGENTRUN_MCP_ALLOW_LOOPBACK: "1", AGENTRUN_WEBHOOK_PRIVATE_TARGETS: "1" });
  assert.equal(await service.install({ env: ["AGENT_MODEL=qwen3:8b"] }), 0);
  assert.deepEqual(unitEnv(readFileSync(file, "utf8")), { PATH: "/usr/bin", AGENTRUN_MCP_ALLOW_LOOPBACK: "1", AGENTRUN_WEBHOOK_PRIVATE_TARGETS: "1", AGENT_MODEL: "qwen3:8b" });
  assert.equal(await service.install({ env: ["AGENTRUN_WEBHOOK_PRIVATE_TARGETS="] }), 0);
  assert.deepEqual(unitEnv(readFileSync(file, "utf8")), { PATH: "/usr/bin", AGENTRUN_MCP_ALLOW_LOOPBACK: "1", AGENT_MODEL: "qwen3:8b" });
  // The server reads a switch as on at 1 alone: any other value would leave it off, so it is refused.
  await assert.rejects(service.install({ env: ["AGENTRUN_MCP_ALLOW_LOOPBACK=true"] }), (error) => error.code === 2 && /AGENTRUN_MCP_ALLOW_LOOPBACK takes 1 \(on\) or nothing \(off\), not true/.test(error.message));
  assert.equal(unitEnv(readFileSync(file, "utf8")).AGENTRUN_MCP_ALLOW_LOOPBACK, "1");
});

test("service install --env refuses any other variable by name, and a pair with no =, before it writes anything", async () => {
  const { home, exec, get } = linuxHome();
  const { io } = ioOf();
  const service = serviceOf({ platform: "linux", home, uid: 1000, user: "a", env: {}, exec, io, fail, get, waitMs: 5_000 });
  for (const [pair, said] of [
    ["OPENROUTER_API_KEY=sk-or-x", /--env takes AGENT_MODEL_BASE_URL, AGENT_MODEL_GATEWAY_IDS, AGENT_MODEL, AGENT_MODEL_PRICE, AGENTRUN_MCP_ALLOW_LOOPBACK or AGENTRUN_WEBHOOK_PRIVATE_TARGETS, not OPENROUTER_API_KEY: a key goes in the console/],
    ["PATH=/x", /not PATH/],
    ["AGENT_MODEL", /--env takes KEY=VALUE, not AGENT_MODEL/],
    ["AGENT_MODEL=a\nb", /AGENT_MODEL's value has a line break/],
  ]) {
    await assert.rejects(service.install({ env: [pair] }), (error) => error.code === 2 && said.test(error.message), pair);
  }
  assert.equal(existsSync(join(home, ".config", "systemd", "user", UNIT)), false);
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
  assert.match(bin(["service", "install", "--help"]).stdout, /--env KEY=VALUE +a local model's variable/);
  const secret = bin(["service", "install", "--env", "AGENT_MODEL=x", "--env", "OPENROUTER_API_KEY=x"], home);
  assert.equal(secret.status, 2);
  assert.match(secret.stderr, /not OPENROUTER_API_KEY/);
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

// --vps (vps-walk.sh walks it as root in CI): its options and its refusals, before it installs or downloads anything.
test("install.sh --vps: its help, the options it refuses, and root", () => {
  const run = (...args) => spawnSync("sh", [INSTALLER, ...args], { encoding: "utf8", env: { HOME: fresh(), PATH: process.env.PATH } });
  const help = run("--help").stdout;
  assert.match(help, /curl -fsSL https:\/\/agentrun\.ai\/install \| sh -s -- --vps\n/);
  assert.match(help, /--vps +AgentRun in Docker Compose in \/opt\/agentrun/);
  assert.match(help, /--public +with --vps: listen on every address of the server, port 7340, over plain HTTP/);
  for (const flag of ["--public", "--image=x"]) {
    const refused = run(flag);
    assert.deepEqual([refused.status, refused.stderr], [1, "agentrun install: --public and --image go with --vps (see --help)\n"], flag);
  }
  for (const flag of [["--tailscale"], ["--no-start"], ["--service"], ["--package", "x.tgz"], ["--node-version", "24.22.3"]]) {
    const refused = run("--vps", ...flag);
    assert.deepEqual([refused.status, refused.stderr], [1, `agentrun install: ${flag[0]} is for an install on this computer; --vps runs AgentRun in Docker (see --help)\n`], flag[0]);
  }
  if (process.getuid?.() !== 0 && process.platform === "linux") {
    const user = run("--vps", "--public");
    assert.deepEqual([user.status, user.stderr], [1, "agentrun install: --vps installs Docker and writes /opt/agentrun, so it runs as root: curl -fsSL https://agentrun.ai/install | sudo sh -s -- --vps --public\n"]);
  }
});
