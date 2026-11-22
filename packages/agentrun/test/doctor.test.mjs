// `agentrun doctor`: each check's ok and not-ok lines, its exit codes, its JSON, and that it is read-only and never prints
// the server's token. The server is a fake fetch (or, through the CLI, a small HTTP server on loopback) and every command
// it runs a fake exec: nothing is installed, started or asked of this machine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../lib/cli.mjs";
import { doctorOf, meetsFloor, textOf } from "../lib/doctor.mjs";
import { INSTALL_COMMAND, LABEL, plistText, unitText } from "../lib/service.mjs";
import { removeAtEnd } from "./support.mjs";

const CANARY = "doctor-canary-token-7f3a9c0e1b2d4f6a8c0e2b4d6f8a0c2e";
const BASE = "http://127.0.0.1:7340/v2"; // key-gate: loopback-rule the fake server's address in a test

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "agentrun-doctor-"));
  removeAtEnd(dir);
  return dir;
};

/** A home with an AgentRun: its data directory's record and token, the installer's command, and (unless `service` is
 *  false) a systemd user unit for it, serving `serviceData` when given. */
function homeOf({ record = true, service = true, serviceData, program = true, env = {}, args = [] } = {}) {
  const home = fresh();
  const data = join(home, ".agentrun");
  mkdirSync(join(data, "bin"), { recursive: true });
  if (program) writeFileSync(join(data, "bin", "agentrun"), "#!/bin/sh\n", { mode: 0o755 });
  if (record) writeFileSync(join(data, ".server.json"), `${JSON.stringify({ base_url: BASE, pid: 4242, token_file: join(data, ".token") })}\n`, { mode: 0o600 });
  writeFileSync(join(data, ".token"), `${CANARY}\n`, { mode: 0o600 });
  if (service) {
    const unit = join(home, ".config", "systemd", "user", "agentrun.service");
    mkdirSync(join(unit, ".."), { recursive: true });
    writeFileSync(unit, unitText({ program: join(data, "bin", "agentrun"), args: ["--no-open", ...(serviceData ? ["--data", serviceData] : []), ...args], path: "/usr/bin:/bin", log: join(data, "logs", "agentrun.log"), env }));
  }
  return { home, data };
}

const HEALTHY_CAPS = {
  server: { name: "@parcha/agentrun-serve", version: "9.9.9" },
  models: { source: "providers", default: "anthropic/claude-test", ready: true, needs: null },
  harnesses: [{ id: "pi", available: true, default_model: "anthropic/claude-test" }, { id: "claude-agent", available: true, default_model: "anthropic/claude-test" }],
  places: { boxes: [{ id: "docker", available: true, state: "ready" }] },
  features: { triggers: { public_url: false } },
  switches: {
    AGENTRUN_MCP_ALLOW_LOOPBACK: { on: false, value: null, allows: "An MCP server on this machine's loopback." },
    AGENTRUN_BOX_CPUS: { on: true, value: "2", allows: "A Docker computer's CPUs." },
  },
};

/** A fake fetch for the server at BASE: each answer by path, every request recorded with its method and headers. */
function serverOf({ health = { status: 200, body: { status: "ok", checks: { store: "ok", disk: "ok" } } }, session = { status: 200, body: { accounts: true, password_set: true, signed_in: false } }, caps = { status: 200, body: HEALTHY_CAPS }, down = false } = {}) {
  const requests = [];
  const get = async (url, options = {}) => {
    requests.push({ url, method: options.method ?? "GET", headers: options.headers ?? {} });
    if (down) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const path = new URL(url).pathname;
    const answer = path === "/v2/health" ? health : path === "/v2/auth/session" ? session : path === "/v2/capabilities" ? caps : { status: 404, body: { error: { code: "not_found" } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  };
  return { get, requests };
}

/** A fake exec: systemd present with the unit active and lingering on, the node on PATH as this one, Docker answering,
 *  Tailscale not installed; `answer` overrides any of them. Every call recorded. */
function execOf(answer = () => undefined) {
  const calls = [];
  const exec = (command, args) => {
    calls.push([command, ...args].join(" "));
    const own = answer(command, args);
    if (own) return { status: 0, stdout: "", stderr: "", ...own };
    const said = (stdout) => ({ status: 0, stdout, stderr: "" });
    if (command === "node") return said("v24.22.3\n");
    if (command === "systemctl" && args.includes("show-environment")) return said("PATH=/usr/bin\n");
    if (command === "systemctl" && args.includes("show")) return said("ActiveState=active\nSubState=running\nMainPID=4242\n");
    if (command === "loginctl") return said("yes\n");
    if (command === "docker") return said("29.0.0\n");
    return { status: null, stdout: "", stderr: "", error: Object.assign(new Error(`spawnSync ${command} ENOENT`), { code: "ENOENT" }) };
  };
  return { exec, calls };
}

const readToken = () => CANARY;
// The records name pid 4242: it runs, unless a test says it has exited.
const alive = () => true;
const LOCAL_ENV = { DISPLAY: ":0" };

async function doctor({ home, data, env = LOCAL_ENV, server = serverOf(), exec = execOf(), ...rest } = {}) {
  const report = await doctorOf({ data, home, env, platform: "linux", uid: 1000, user: "someone", exec: exec.exec, get: server.get, nodeVersion: "24.22.3", engines: ">=24.22.3", readToken, alive, ...rest });
  return { report, text: textOf(report, home), server, exec, check: (id) => report.checks.find((c) => c.id === id) };
}

/** Nothing the doctor did writes: every request a GET, no command that starts, stops or changes anything. */
function assertReadOnly({ server, exec }) {
  for (const request of server.requests) assert.equal(request.method, "GET", request.url);
  for (const call of exec.calls) assert.doesNotMatch(call, /\b(start|stop|restart|enable|disable|bootstrap|bootout|kickstart|daemon-reload|serve --bg|funnel|set|up)\b/, call);
}

test("a healthy setup: every check ok or info, exit 0, the version from capabilities, read-only", async () => {
  const { home, data } = homeOf();
  const run = await doctor({ home, data });
  assert.equal(run.report.exit, 0);
  assert.deepEqual(run.report.checks.map((c) => [c.id, c.status]), [["node", "ok"], ["server", "ok"], ["service", "ok"], ["address", "ok"], ["owner", "ok"], ["models", "ok"], ["harnesses", "ok"], ["switches", "info"], ["docker", "ok"]]);
  assert.deepEqual(run.report.server, { url: "http://127.0.0.1:7340/", version: "9.9.9" });
  assert.match(run.check("server").summary, /answers \/v2\/health ok, version 9\.9\.9/);
  assert.match(run.check("models").summary, /anthropic\/claude-test/);
  assert.match(run.text, /^AgentRun doctor \(agentrun [^,]+, data directory ~\/\.agentrun\)/);
  assert.match(run.text, /\nAll good\.\n$/);
  assert.doesNotMatch(run.text, /Fix:/);
  // Capabilities carried the server's own token, to the server's own address, and nothing else did.
  const withToken = run.server.requests.filter((r) => r.headers.authorization);
  assert.deepEqual(withToken.map((r) => [r.url, r.headers.authorization]), [[`${BASE}/capabilities`, `Bearer ${CANARY}`]]);
  assertReadOnly(run);
});

test("the token is never printed, in text or JSON, whatever the checks say", async () => {
  for (const server of [serverOf(), serverOf({ caps: { status: 401, body: { error: { message: `refused ${CANARY.slice(0, 4)}` } } } }), serverOf({ session: { status: 200, body: { password_set: false } } })]) {
    const { home, data } = homeOf();
    const run = await doctor({ home, data, server, env: { ...LOCAL_ENV, SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22" } });
    assert.ok(!run.text.includes(CANARY), "text holds the token");
    assert.ok(!JSON.stringify(run.report).includes(CANARY), "JSON holds the token");
  }
});

test("Node: an older Node fails with the installer, and an older node on PATH warns", async () => {
  const { home, data } = homeOf();
  const old = await doctor({ home, data, nodeVersion: "24.22.2" });
  assert.equal(old.check("node").status, "fail");
  assert.match(old.check("node").summary, /v24\.22\.2; AgentRun needs 24\.22\.3 or newer/);
  assert.ok(old.check("node").fix.some((f) => f.includes(INSTALL_COMMAND)));
  assert.equal(old.report.exit, 1);
  const path = await doctor({ home, data, exec: execOf((command) => (command === "node" ? { stdout: "v22.1.0\n" } : undefined)) });
  assert.equal(path.check("node").status, "warn");
  assert.match(path.check("node").summary, /node on PATH is v22\.1\.0/);
  assert.equal(path.report.exit, 0);
  assert.equal(meetsFloor("25.0.0", ">=24.22.3"), true);
  assert.equal(meetsFloor("24.21.9", ">=24.22.3"), false);
});

test("Server: none recorded is exit 3, its checks skipped, with how to start it", async () => {
  const none = homeOf({ record: false, service: false, program: false });
  const run = await doctor({ ...none, server: serverOf({ down: true }) });
  assert.equal(run.report.exit, 3);
  assert.equal(run.report.server, null);
  assert.equal(run.check("server").status, "fail");
  assert.match(run.check("server").summary, /No AgentRun server is running for/);
  assert.ok(run.check("server").fix.some((f) => f.includes(INSTALL_COMMAND)));
  for (const id of ["address", "owner", "models", "harnesses", "switches"]) assert.equal(run.check(id).status, "skip", id);
  assert.match(run.text, /No server is answering: start it first/);

  // A record whose server does not answer, with the service installed: start the service.
  const stale = homeOf();
  const down = await doctor({ ...stale, server: serverOf({ down: true }), exec: execOf((command, args) => (command === "systemctl" && args.includes("show") && !args.includes("show-environment") ? { stdout: "ActiveState=failed\nSubState=failed\nMainPID=0\n" } : undefined)) });
  assert.equal(down.report.exit, 3);
  assert.match(down.check("server").summary, /is not answering \(ECONNREFUSED\)/);
  assert.equal(down.check("server").fix[0], "agentrun service start");
  assert.equal(down.check("service").status, "fail");
});

test("Server: a record that is refused (unreadable as private, or an address with a user, a query or another scheme) is exit 1, and nothing is sent anywhere", async () => {
  const { home, data } = homeOf();
  const server = serverOf();
  const refused = await doctor({ home, data, server, readRecord: (file) => { throw new Error(`${file} is not a private file of yours (a regular file you own, mode 0600); refusing it.`); } });
  assert.equal(refused.report.exit, 1);
  assert.equal(refused.report.server, null);
  assert.equal(refused.check("server").status, "fail");
  assert.match(refused.check("server").summary, /is not a private file of yours .*refusing it: nothing is sent to the address it names\./);
  assert.match(refused.check("server").fix[0], /mode 0600/);
  for (const id of ["address", "owner", "models", "harnesses", "switches"]) {
    assert.equal(refused.check(id).status, "skip", id);
    assert.match(refused.check(id).summary, /the server record is refused/, id);
  }
  assert.deepEqual(server.requests, []);

  // The address with a user and password is built here: the source holds no URL with a credential in it.
  const withUser = Object.assign(new URL(BASE), { username: "someone", password: "x" }).href;
  for (const base_url of [withUser, "http://127.0.0.1:7340/v2?to=elsewhere", "file:///etc/passwd", "ftp://127.0.0.1/v2"]) {
    const odd = homeOf();
    writeFileSync(join(odd.data, ".server.json"), JSON.stringify({ base_url, pid: 4242, token_file: join(odd.data, ".token") }), { mode: 0o600 });
    const asked = serverOf();
    const run = await doctor({ ...odd, server: asked });
    assert.equal(run.report.exit, 1, base_url);
    assert.match(run.check("server").summary, /is not a server record .*refusing it/, base_url);
    assert.deepEqual(asked.requests, [], base_url);
    assert.ok(!run.text.includes("someone"), "the record's user is not echoed");
  }

  const pidless = homeOf();
  writeFileSync(join(pidless.data, ".server.json"), JSON.stringify({ base_url: BASE, token_file: join(pidless.data, ".token") }), { mode: 0o600 });
  const noPid = serverOf();
  const withoutPid = await doctor({ ...pidless, server: noPid });
  assert.equal(withoutPid.report.exit, 1);
  assert.match(withoutPid.check("server").summary, /pid a positive whole number\); refusing it/);
  assert.deepEqual(noPid.requests, []);

  const broken = homeOf();
  writeFileSync(join(broken.data, ".server.json"), "{not json", { mode: 0o600 });
  const garbled = await doctor({ ...broken, server: serverOf() });
  assert.equal(garbled.report.exit, 1);
  assert.match(garbled.check("server").summary, /is not valid JSON/);
});

test("Server: a record whose process has exited is stale: its address, which another process may hold now, is sent nothing", async () => {
  const { home, data } = homeOf();
  const server = serverOf();
  const asked = [];
  const run = await doctor({ home, data, server, alive: (pid) => (asked.push(pid), false) });
  assert.deepEqual(asked, [4242]);
  assert.deepEqual(server.requests, [], "no request, so no token, went to the recorded address");
  assert.equal(run.report.exit, 3);
  assert.equal(run.report.server, null);
  assert.equal(run.check("server").status, "fail");
  assert.match(run.check("server").summary, /\(http:\/\/127\.0\.0\.1:7340\/\) is not running \(its process, pid 4242, has exited\)/);
  assert.equal(run.check("server").fix[0], "agentrun service start");
  for (const id of ["address", "owner", "models", "harnesses", "switches"]) assert.equal(run.check(id).status, "skip", id);
});

test("Server: a failing /v2/health is exit 1, with the disk to free", async () => {
  const { home, data } = homeOf();
  const run = await doctor({ home, data, server: serverOf({ health: { status: 503, body: { status: "failing", checks: { store: "ok", disk: "below_floor" } } } }) });
  assert.equal(run.report.exit, 1);
  assert.equal(run.check("server").status, "fail");
  assert.match(run.check("server").summary, /503 failing \(disk below_floor\)/);
  assert.match(run.check("server").fix[0], /Free disk space/);
});

test("Service: not installed warns, stopped fails, lingering off warns with its sudo line, another data directory and no systemd are info", async () => {
  const bare = homeOf({ service: false });
  const notInstalled = await doctor(bare);
  assert.equal(notInstalled.check("service").status, "warn");
  assert.deepEqual(notInstalled.check("service").fix, ["agentrun service install"]);
  // Another data directory: the service the fix installs is that one's, not ~/.agentrun's.
  const elsewhereData = join(bare.home, "srv-agentrun");
  mkdirSync(elsewhereData);
  writeFileSync(join(elsewhereData, ".server.json"), JSON.stringify({ base_url: BASE, pid: 4242, token_file: join(elsewhereData, ".token") }), { mode: 0o600 });
  const otherData = await doctor({ home: bare.home, data: elsewhereData });
  assert.deepEqual(otherData.check("service").fix, [`agentrun service install --data ${elsewhereData}`]);
  const noCommand = homeOf({ service: false, program: false });
  const otherNoCommand = await doctor({ home: noCommand.home, data: elsewhereData });
  assert.deepEqual(otherNoCommand.check("service").fix, [`${INSTALL_COMMAND} -s -- --no-start  (installs the command alone)`, `Then: ${join(noCommand.home, ".agentrun", "bin", "agentrun")} service install --data ${elsewhereData}  (a new terminal has agentrun on PATH; this one does not yet)`]);

  const { home, data } = homeOf();
  const linger = await doctor({ home, data, exec: execOf((command) => (command === "loginctl" ? { stdout: "no\n" } : undefined)) });
  assert.equal(linger.check("service").status, "warn");
  assert.deepEqual(linger.check("service").fix, ["sudo loginctl enable-linger someone"]);
  assert.equal(linger.report.exit, 0);

  const stopped = await doctor({ home, data, server: serverOf({ down: true }), exec: execOf((command, args) => (command === "systemctl" && args[1] === "show" ? { stdout: "ActiveState=inactive\nSubState=dead\nMainPID=0\n" } : undefined)) });
  assert.equal(stopped.check("service").status, "fail");
  assert.match(stopped.check("service").summary, /installed but inactive \(dead\)/);

  const other = homeOf({ serviceData: "/srv/elsewhere" });
  const elsewhere = await doctor(other);
  assert.equal(elsewhere.check("service").status, "info");
  assert.match(elsewhere.check("service").summary, /serves another data directory, \/srv\/elsewhere/);

  const container = homeOf({ service: false });
  const noSystemd = await doctor({ ...container, exec: execOf((command) => (command === "systemctl" ? { status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) } : undefined)) });
  assert.equal(noSystemd.check("service").status, "info");
  assert.match(noSystemd.check("service").summary, /no systemd/);
});

test("Address: loopback from a remote session warns with a tunnel and the tailnet line (never Funnel); a public address or a local session is ok", async () => {
  const { home, data } = homeOf();
  const tailscale = execOf((command) => (command === "tailscale" ? { stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.tailnet.example.test." } }) } : undefined));
  const remote = await doctor({ home, data, env: { SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22" }, exec: tailscale });
  const address = remote.check("address");
  assert.equal(address.status, "warn");
  assert.match(address.summary, /loopback only .*this session looks remote \(SSH\)/);
  assert.ok(address.fix.some((f) => f.includes("ssh -L 7340:localhost:7340")));
  assert.ok(address.fix.some((f) => f.includes("tailscale serve --bg 7340") && f.includes("agentrun service install --public-url https://box.tailnet.example.test")));
  assert.ok(address.fix.some((f) => f.includes("--allow-host")));
  assert.ok(!address.fix.some((f) => /tailscale funnel/.test(f)));
  assert.match(remote.text, /Docs: https:\/\/github\.com\/Parcha-ai\/agentrun\/blob\/main\/packages\/serve\/README\.md#quick-start/);
  assertReadOnly(remote);

  // No display on Linux counts as remote too; Tailscale signed out adds no tailnet line.
  const headless = await doctor({ home, data, env: {} });
  assert.equal(headless.check("address").status, "warn");
  assert.match(headless.check("address").summary, /\(no display\)/);
  assert.ok(!headless.check("address").fix.some((f) => f.includes("tailscale")));

  const caps = { ...HEALTHY_CAPS, features: { triggers: { public_url: true } } };
  const published = await doctor({ home, data, env: {}, server: serverOf({ caps: { status: 200, body: caps } }) });
  assert.equal(published.check("address").status, "ok");

  const named = homeOf({ env: { AGENTRUN_PUBLIC_URL: "https://agentrun.example.test" } });
  const byUnit = await doctor({ ...named, env: {}, readToken: () => undefined });
  assert.equal(byUnit.check("address").status, "ok");

  // Started in a terminal (no service): the restart keeps this port, which the tailnet entry forwards to.
  const terminal = homeOf({ service: false });
  const fromTerminal = await doctor({ ...terminal, env: { SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22" }, exec: tailscale, readToken: () => undefined });
  assert.ok(fromTerminal.check("address").fix.some((f) => f.includes("tailscale serve --bg 7340") && f.includes("start AgentRun with --port 7340 --public-url https://box.tailnet.example.test")), fromTerminal.check("address").fix.join("\n"));

  // agentrun service install --public-url keeps the address on the service's command line.
  const flagged = homeOf({ args: ["--public-url", "https://agentrun.example.test"] });
  const byFlag = await doctor({ ...flagged, env: { SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22" }, readToken: () => undefined });
  assert.equal(byFlag.check("address").status, "ok", byFlag.check("address").summary);
  assert.match(byFlag.check("address").summary, /served at a name of its own \(its public URL\)/);

  // On macOS the service is a launchd plist, which holds the public URL as a key and a string, not a line.
  const mac = homeOf({ service: false });
  const plist = join(mac.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  mkdirSync(join(plist, ".."), { recursive: true });
  writeFileSync(plist, plistText({ program: join(mac.data, "bin", "agentrun"), args: ["--no-open"], path: "/usr/bin:/bin", log: join(mac.data, "logs", "agentrun.log"), env: { AGENTRUN_PUBLIC_URL: "https://agentrun.example.test" } }));
  const launchd = execOf((command, args) => (command === "launchctl" && args[0] === "print" ? { stdout: "state = running\npid = 4242\n" } : undefined));
  const onMac = await doctor({ ...mac, platform: "darwin", env: { SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22" }, exec: launchd, readToken: () => undefined });
  assert.equal(onMac.check("service").status, "ok", onMac.check("service").summary);
  assert.equal(onMac.check("address").status, "ok", onMac.check("address").summary);

  // A stopped service's settings say nothing of the server that answers: a public URL in its unit counts only while it runs.
  const stoppedExec = execOf((command, args) => (command === "systemctl" && args.includes("show") && !args.includes("show-environment") ? { stdout: "ActiveState=inactive\nSubState=dead\nMainPID=0\n" } : undefined));
  const stoppedNamed = await doctor({ ...named, env: { SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22" }, exec: stoppedExec, readToken: () => undefined });
  assert.equal(stoppedNamed.check("address").status, "warn");

  // The tailnet entry counts when it forwards to this server's port, not to another one the service used.
  const tailnetHome = homeOf();
  writeFileSync(join(tailnetHome.data, "tailscale.json"), JSON.stringify({ url: "https://box.tailnet.example.test/", proxy: "http://127.0.0.1:7340" }), { mode: 0o600 });
  const served = await doctor({ ...tailnetHome, env: { SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22" }, readToken: () => undefined });
  assert.equal(served.check("address").status, "ok");
  assert.match(served.check("address").summary, /box\.tailnet\.example\.test.*on your tailnet/);
  writeFileSync(join(tailnetHome.data, "tailscale.json"), JSON.stringify({ url: "https://box.tailnet.example.test/", proxy: "http://127.0.0.1:7399" }), { mode: 0o600 });
  const otherPort = await doctor({ ...tailnetHome, env: { SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22" }, readToken: () => undefined });
  assert.equal(otherPort.check("address").status, "warn");

  // --allow-host only names the Host names it accepts: nothing forwards to it, so a remote session still gets the tunnel.
  const allowed = homeOf({ args: ["--allow-host", "agentrun.example.test"] });
  const byAllowHost = await doctor({ ...allowed, env: { SSH_CONNECTION: "203.0.113.5 50000 198.51.100.7 22" }, readToken: () => undefined });
  assert.equal(byAllowHost.check("address").status, "warn");
  assert.ok(byAllowHost.check("address").fix.some((f) => f.includes("ssh -L 7340:localhost:7340")));

  assert.equal((await doctor({ home, data })).check("address").status, "ok");
});

test("Owner: no password warns with agentrun open as the fix, never the code; setup with no code adds its page; no accounts is info", async () => {
  const { home, data } = homeOf();
  const unset = await doctor({ home, data, server: serverOf({ session: { status: 200, body: { accounts: true, password_set: false, setup_code: true } } }) });
  const owner = unset.check("owner");
  assert.equal(owner.status, "warn");
  assert.deepEqual(owner.fix, ["agentrun open  (opens the setup page with its code filled in; where no browser opens, it prints the link)"]);
  assert.doesNotMatch(unset.text, /Set up this server:|#code=/);
  assert.equal(unset.report.exit, 0);
  // The doctor asks for no setup code itself: a new one is a POST, and every request is a GET.
  assertReadOnly(unset);

  const open = await doctor({ home, data, server: serverOf({ session: { status: 200, body: { accounts: true, password_set: false, setup_code: false } } }) });
  assert.deepEqual(open.check("owner").fix, ["agentrun open  (opens the setup page; where no browser opens, it prints the link)", "Or open http://127.0.0.1:7340/setup in a browser that reaches this server: its setup takes no code"]);

  const elsewhere = homeOf({ service: false });
  const other = join(elsewhere.home, "other");
  mkdirSync(other);
  writeFileSync(join(other, ".server.json"), JSON.stringify({ base_url: BASE, pid: 4242, token_file: join(other, ".token") }), { mode: 0o600 });
  const withData = await doctor({ home: elsewhere.home, data: other, server: serverOf({ session: { status: 200, body: { accounts: true, password_set: false, setup_code: true } } }) });
  assert.ok(withData.check("owner").fix[0].startsWith(`agentrun open --data ${other}  (`), withData.check("owner").fix[0]);

  // AGENTRUN_ACCOUNTS=0: the session answers 200 with accounts false (server.ts getAuthSession); an older server, 404.
  const noAccounts = await doctor({ home, data, server: serverOf({ session: { status: 200, body: { accounts: false } } }) });
  assert.equal(noAccounts.check("owner").status, "info");
  assert.match(noAccounts.check("owner").summary, /no accounts \(AGENTRUN_ACCOUNTS=0\): its token opens the console/);
  const older = await doctor({ home, data, server: serverOf({ session: { status: 404, body: { error: { code: "not_found" } } } }) });
  assert.equal(older.check("owner").status, "info");
});

test("Models: none ready fails with the console's Model keys and the gateway's variables; harnesses not ready are named", async () => {
  const { home, data } = homeOf();
  const caps = {
    ...HEALTHY_CAPS,
    models: { source: "providers", default: null, ready: false, needs: "key" },
    harnesses: [{ id: "pi", available: false, reason: "No model yet." }, { id: "claude-agent", available: false, reason: "claude-agent needs ANTHROPIC_API_KEY or OPENROUTER_API_KEY." }],
  };
  const run = await doctor({ home, data, server: serverOf({ caps: { status: 200, body: caps } }) });
  assert.equal(run.report.exit, 1);
  const models = run.check("models");
  assert.equal(models.status, "fail");
  // It speaks of the model AgentRun runs: a connected native agent runs on its own sign-in.
  assert.match(models.summary, /no agent on a model AgentRun runs can start\. A connected native agent \(Claude Code or Codex on its own sign-in\) needs none/);
  assert.ok(models.fix.some((f) => f.includes("Settings → Model keys")));
  assert.ok(models.fix.some((f) => ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_GATEWAY_IDS=bare", "AGENT_MODEL_API_KEY"].every((name) => f.includes(name))));
  const harnesses = run.check("harnesses");
  assert.equal(harnesses.status, "fail");
  assert.match(harnesses.summary, /claude-agent needs ANTHROPIC_API_KEY/);
  assert.doesNotMatch(harnesses.summary, /claude-agent: claude-agent|\.;/);

  const some = await doctor({ home, data, server: serverOf({ caps: { status: 200, body: { ...HEALTHY_CAPS, harnesses: [{ id: "pi", available: true, default_model: "anthropic/claude-test" }, caps.harnesses[1]] } } }) });
  assert.equal(some.check("harnesses").status, "info");
  assert.deepEqual(some.check("harnesses").details, { ready: ["pi"], not_ready: { "claude-agent": "claude-agent needs ANTHROPIC_API_KEY or OPENROUTER_API_KEY." } });

  // A harness that runs here with no default model (pi with no key: available, default_model null) is not ready, and
  // its reason is kept; one from a server that does not list default_model goes by available.
  const keyless = { id: "pi", available: true, default_model: null, reason: "pi has no model here: add a model key (Settings → Model keys).", needs: ["key"] };
  const noDefault = await doctor({ home, data, server: serverOf({ caps: { status: 200, body: { ...HEALTHY_CAPS, harnesses: [keyless, { id: "codex", available: true }] } } }) });
  assert.equal(noDefault.check("harnesses").status, "info");
  assert.deepEqual(noDefault.check("harnesses").details, { ready: ["codex"], not_ready: { pi: keyless.reason } });
  assert.match(noDefault.check("harnesses").summary, /Ready: codex\. Not ready: pi has no model here: add a model key/);
  const onlyKeyless = await doctor({ home, data, server: serverOf({ caps: { status: 200, body: { ...HEALTHY_CAPS, harnesses: [keyless] } } }) });
  assert.equal(onlyKeyless.check("harnesses").status, "fail");

  const wrongModel = await doctor({ home, data, server: serverOf({ caps: { status: 200, body: { ...caps, models: { ...caps.models, needs: "model" } } } }) });
  assert.match(wrongModel.check("models").fix[0], /AGENT_MODEL names a model/);
});

test("Models without the token: skipped, saying why, and Docker asked of docker info instead", async () => {
  const { home, data } = homeOf();
  const run = await doctor({ home, data, readToken: () => undefined, exec: execOf((command) => (command === "docker" ? { status: 1, stderr: "permission denied while trying to connect to the Docker daemon socket\n" } : undefined)) });
  assert.equal(run.check("models").status, "skip");
  assert.match(run.check("models").summary, /no token to read the server's capabilities with: .*\.token is not there/);
  assert.equal(run.check("docker").status, "warn");
  assert.ok(run.check("docker").fix.some((f) => f.includes("usermod -aG docker someone")));
  assert.equal(run.report.exit, 0);
});

test("Switches: listed as info, on and off; a server without them says so", async () => {
  const { home, data } = homeOf();
  const listed = await doctor({ home, data });
  assert.equal(listed.check("switches").status, "info");
  assert.match(listed.check("switches").summary, /AGENTRUN_MCP_ALLOW_LOOPBACK off, AGENTRUN_BOX_CPUS on \(2\)/);
  assert.deepEqual(listed.check("switches").details.AGENTRUN_BOX_CPUS, { on: true, value: "2", allows: "A Docker computer's CPUs." });
  const { switches: _switches, ...older } = HEALTHY_CAPS;
  const before = await doctor({ home, data, server: serverOf({ caps: { status: 200, body: older } }) });
  assert.equal(before.check("switches").status, "info");
  assert.match(before.check("switches").summary, /does not list its start-time switches/);
});

test("Docker: no box warns with the reason and the fix", async () => {
  const { home, data } = homeOf();
  const caps = { ...HEALTHY_CAPS, places: { boxes: [{ id: "docker", available: false, reason: "Docker does not answer here" }] } };
  const run = await doctor({ home, data, server: serverOf({ caps: { status: 200, body: caps } }) });
  assert.equal(run.check("docker").status, "warn");
  assert.match(run.check("docker").summary, /Docker does not answer here/);
  assert.match(run.check("docker").fix.join("\n"), /docker info must answer/);
  assert.equal(run.report.exit, 0);
  // Another box ready (a remote computer): Docker's absence is info, and no install is asked for.
  const remoteBox = { ...HEALTHY_CAPS, places: { boxes: [{ id: "docker", available: false, reason: "Docker does not answer here" }, { id: "daytona", available: true }, { id: "modal", available: false }] } };
  const elsewhere = await doctor({ home, data, server: serverOf({ caps: { status: 200, body: remoteBox } }) });
  assert.equal(elsewhere.check("docker").status, "info");
  assert.match(elsewhere.check("docker").summary, /runs in daytona instead/);
  assert.deepEqual(elsewhere.check("docker").fix, []);
  const missing = await doctor({ home, data, readToken: () => undefined, exec: execOf((command) => (command === "docker" ? { status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) } : undefined)) });
  assert.match(missing.check("docker").summary, /Docker is not installed/);
});

/** A port probe at `port`: the `GET /` another process on the machine may send to any new loopback listener. Its status. */
async function portProbe(port) {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  await res.arrayBuffer();
  return res.status;
}

/** `agentrun doctor` through the CLI, as the bin runs it, against a small server on loopback. */
async function cli(argv, env) {
  const out = [];
  const err = [];
  const io = { stdout: { write: (text) => out.push(text), on() {}, isTTY: false }, stderr: { write: (text) => err.push(text) } };
  const code = await main(argv, env, io);
  return { code, out: out.join(""), err: err.join("") };
}

test("through the CLI: --json's shape and exit codes, the token sent only to capabilities and never printed, --base-url refused", async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/v2/health") return send(200, { status: "ok", checks: { store: "ok", disk: "ok" } });
    if (req.url === "/v2/auth/session") return send(200, { accounts: true, password_set: true, signed_in: false });
    if (req.url === "/v2/capabilities") return req.headers.authorization === `Bearer ${CANARY}` ? send(200, { ...HEALTHY_CAPS, models: { source: "providers", default: null, ready: false, needs: "key" } }) : send(401, {});
    send(404, {});
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const data = fresh();
  writeFileSync(join(data, ".server.json"), `${JSON.stringify({ base_url: `http://127.0.0.1:${server.address().port}/v2`, pid: process.pid, token_file: join(data, ".token") })}\n`, { mode: 0o600 });
  writeFileSync(join(data, ".token"), `${CANARY}\n`, { mode: 0o600 });
  // An empty PATH: every command the doctor runs (systemctl, docker, tailscale) is not found, the same on every machine.
  const env = { PATH: fresh(), DISPLAY: ":0" };

  const json = await cli(["doctor", "--data", data, "--json"], env);
  assert.equal(json.code, 1, json.err);
  const report = JSON.parse(json.out);
  assert.equal(report.exit, 1);
  assert.equal(report.data, data);
  assert.deepEqual(report.server, { url: `http://127.0.0.1:${server.address().port}/`, version: "9.9.9" });
  assert.deepEqual(report.checks.map((c) => c.id), ["node", "server", "service", "address", "owner", "models", "harnesses", "switches", "docker"]);
  for (const check of report.checks) {
    assert.ok(["ok", "warn", "fail", "info", "skip"].includes(check.status), check.id);
    assert.equal(typeof check.title, "string");
    assert.equal(typeof check.summary, "string");
    assert.ok(Array.isArray(check.fix));
  }
  assert.equal(report.checks.find((c) => c.id === "models").status, "fail");
  assert.ok(!json.out.includes(CANARY) && !json.err.includes(CANARY));

  const text = await cli(["doctor", "--data", data], env);
  assert.equal(text.code, 1);
  assert.match(text.out, /^fail  Models/m);
  assert.ok(!text.out.includes(CANARY) && !text.err.includes(CANARY));

  for (const request of seen) {
    assert.equal(request.method, "GET");
    assert.equal(request.authorization, request.url === "/v2/capabilities" ? `Bearer ${CANARY}` : undefined, request.url);
  }

  // A record another user could have written (group- and world-readable here) is refused: nothing goes to its address.
  // Its mode is set after the write, which a umask such as 077 would otherwise take the read bits from.
  const loose = fresh();
  writeFileSync(join(loose, ".server.json"), `${JSON.stringify({ base_url: `http://127.0.0.1:${server.address().port}/v2`, pid: process.pid, token_file: join(loose, ".token") })}\n`);
  chmodSync(join(loose, ".server.json"), 0o644);
  writeFileSync(join(loose, ".token"), `${CANARY}\n`, { mode: 0o600 });
  const asked = seen.length;
  assert.equal(await portProbe(server.address().port), 404, "a port probe is answered 404");
  const refused = await cli(["doctor", "--data", loose], env);
  assert.equal(refused.code, 1, refused.err);
  assert.match(refused.out, /^fail  Server .*is not a private file of yours.*nothing is sent to the address it names/m);
  assert.equal(seen.length, asked, "a refused record's address was sent a request");

  // A record whose process has exited: its address is sent nothing, though a server answers there.
  const dead = fresh();
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  writeFileSync(join(dead, ".server.json"), `${JSON.stringify({ base_url: `http://127.0.0.1:${server.address().port}/v2`, pid: exited, token_file: join(dead, ".token") })}\n`, { mode: 0o600 });
  writeFileSync(join(dead, ".token"), `${CANARY}\n`, { mode: 0o600 });
  const before = seen.length;
  assert.equal(await portProbe(server.address().port), 404, "a port probe is answered 404");
  const staleRun = await cli(["doctor", "--data", dead], env);
  assert.equal(staleRun.code, 3, staleRun.err);
  assert.match(staleRun.out, new RegExp(`is not running \\(its process, pid ${exited}, has exited\\)`));
  assert.equal(seen.length, before, "a stale record's address was sent a request");

  const none = await cli(["doctor", "--data", fresh()], env);
  assert.equal(none.code, 3);
  assert.match(none.out, /No AgentRun server is running for/);

  const remote = await cli(["doctor", "--base-url", "https://agentrun.example.test/v2"], env);
  assert.equal(remote.code, 2);
  assert.match(remote.err, /takes no --base-url/);

  const help = await cli(["doctor", "--help"], env);
  assert.equal(help.code, 0);
  assert.match(help.out, /exit 0 ok or warnings, 1 a check failed, 3 no server answering/);
  assert.match(help.out, /--json/);
});
