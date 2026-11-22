// `--tailscale`: AgentRun on the person's own tailnet through `tailscale serve`, with a fake `tailscale` first on PATH
// (fake-tailscale.sh), so no tailnet is touched. Logged in, missing, logged out, not running, no HTTPS certificates,
// operator rights refused, Funnel already on, the address taken by another service, the entry removed alone (and kept on
// record while Tailscale is stopped), and a sharing flag that keeps the installed service's data folder and port.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serviceOf, UNIT, unitArgs } from "../lib/service.mjs";
import { PRICE, tailnetOf } from "../lib/tailscale.mjs";
import { removeAtEnd } from "./support.mjs";

const FAKE = new URL("fake-tailscale.sh", import.meta.url).pathname;
const HOST = "box.tail1234.example";
const AGAIN = "agentrun service install --tailscale";

class Fail extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => new Fail(code, message);

/** A home with the installer's command, and a fake tailscale in `mode` (none: not installed). */
function machine(mode = "ok") {
  const home = mkdtempSync(join(tmpdir(), "agentrun-tailscale-"));
  removeAtEnd(home);
  const root = join(home, ".agentrun");
  const fakes = join(home, "fakes");
  const state = join(home, "fake-state");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "agentrun"), "#!/bin/sh\n", { mode: 0o755 });
  mkdirSync(fakes);
  mkdirSync(state);
  if (mode !== "none") {
    copyFileSync(FAKE, join(fakes, "tailscale"));
    writeFileSync(join(state, "mode"), `${mode}\n`);
  }
  // The fake alone on PATH: this machine's own tailscale, if it has one, is never found.
  const env = { PATH: fakes, FAKE_TAILSCALE_DIR: state };
  // stdout is piped here, so Tailscale's own words are kept with the rest.
  const exec = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", env, ...options, stdio: "pipe" });
  const out = [];
  const say = (line) => out.push(line);
  const tailnet = tailnetOf({ platform: "linux", root, uid: 1000, exec, say, fail, again: AGAIN });
  const file = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8") : "");
  const calls = () => file("calls").split("\n").filter(Boolean);
  return { home, root, state, env, exec, out, said: () => out.join("\n"), tailnet, file, calls };
}

test("logged in: the address is the machine's MagicDNS name, serve proxies it to the loopback port, and the entry is recorded", () => {
  const box = machine();
  assert.deepEqual(box.tailnet.address("http://127.0.0.1:7340"), { host: HOST, url: `https://${HOST}/` });
  assert.equal(box.tailnet.serve("7340", HOST), true);
  assert.equal(box.file("served"), "http://127.0.0.1:7340\n");
  assert.deepEqual(box.calls(), ["status --json", "serve status --json", "serve --bg --https=443 http://127.0.0.1:7340", "serve status --json"]);
  assert.deepEqual(JSON.parse(readFileSync(join(box.root, "tailscale.json"), "utf8")), { url: `https://${HOST}/`, proxy: "http://127.0.0.1:7340" });
  assert.match(box.said(), new RegExp(`AgentRun is on your tailnet at https://${HOST.replace(/\./g, "\\.")}/ \\(tailscale serve\\): only your devices on your tailnet open it; nothing is on the public internet\\.`));
  assert.match(box.said(), /asks for a setup code on the first visit: the newest "Set up this server" line in .*agentrun\.log has the link/);
  assert.ok(box.said().includes(PRICE));
  assert.doesNotMatch(box.calls().join("\n"), /funnel|reset|up|login|set /, "never Funnel, a reset, a login or a setting");
  // Run again, as an install again does: its own entry is no conflict.
  assert.equal(box.tailnet.address("http://127.0.0.1:7340")?.host, HOST);
});

test("missing, not running, logged out, no HTTPS certificate: the steps, the command to run again, and no address", () => {
  const cases = {
    none: [/^Tailscale is not installed here, so AgentRun/, /1\. Install Tailscale: https:\/\/tailscale\.com\/download\/linux/, /2\. Connect this machine to your tailnet: sudo tailscale up --operator=\$USER/],
    down: [/Tailscale is installed but not running \(failed to connect to local tailscaled/, /1\. Start it: sudo systemctl enable --now tailscaled/, /2\. Connect this machine to your tailnet: sudo tailscale up/],
    "logged-out": [/this machine is not on a tailnet \(NeedsLogin\)/, /1\. Connect it: sudo tailscale up --operator=\$USER/],
    "missing-https": [/your tailnet gives none to this machine \(box\.tail1234\.example\)/, /1\. Turn on MagicDNS and HTTPS Certificates: https:\/\/login\.tailscale\.com\/admin\/dns/],
  };
  for (const [mode, lines] of Object.entries(cases)) {
    const box = machine(mode);
    assert.equal(box.tailnet.address("http://127.0.0.1:7340"), undefined, mode);
    for (const line of lines) assert.match(box.said(), line, mode);
    assert.match(box.said(), /\), so AgentRun is on this machine only for now\.|here, so AgentRun is on this machine only for now\./, mode);
    assert.match(box.said(), new RegExp(`Then run again: ${AGAIN}`), mode);
    assert.ok(box.said().includes(PRICE), mode);
    assert.ok(!box.calls().some((call) => call.startsWith("serve")), `${mode}: nothing served`);
  }
  const mac = machine("none");
  const steps = [];
  tailnetOf({ platform: "darwin", root: mac.root, uid: 501, exec: mac.exec, say: (line) => steps.push(line), fail, again: AGAIN }).address("http://127.0.0.1:7340");
  assert.match(steps.join("\n"), /download\/mac[\s\S]*open the Tailscale app and log in/);
});

test("operator rights refused (Linux, not root): the one sudo line, serve stops there, nothing recorded", () => {
  const box = machine("denied");
  assert.equal(box.tailnet.address("http://127.0.0.1:7340")?.host, HOST);
  assert.equal(box.tailnet.serve("7340", HOST), false);
  assert.equal(box.said(), ["Tailscale on Linux lets only root or its operator change what it serves. Run once:", "  sudo tailscale set --operator=$USER", `Then run again: ${AGAIN}`].join("\n"));
  assert.equal(existsSync(join(box.root, "tailscale.json")), false);
  assert.equal(box.file("served"), "");
});

test("Funnel already on, or the address serving something else: refused by name, nothing changed", () => {
  const funnel = machine();
  writeFileSync(join(funnel.state, "served"), "http://127.0.0.1:7340\n");
  writeFileSync(join(funnel.state, "funnel"), "");
  assert.throws(() => funnel.tailnet.address("http://127.0.0.1:7340"), (error) => error.code === 1 && /Tailscale Funnel is on for https:\/\/box\.tail1234\.example\/ .*nothing was changed\. Turn that Funnel off, then run again: agentrun service install --tailscale/.test(error.message));
  assert.deepEqual(funnel.calls(), ["status --json", "serve status --json"]);

  const taken = machine();
  writeFileSync(join(taken.state, "served"), "http://127.0.0.1:3000\n");
  assert.throws(() => taken.tailnet.address("http://127.0.0.1:7340"), (error) => error.code === 1 && /already serves http:\/\/127\.0\.0\.1:3000 on your tailnet .*changed nothing/.test(error.message));
  assert.equal(taken.file("served"), "http://127.0.0.1:3000\n");
});

test("off removes only the entry it added: another port's entry stays, and an entry someone changed since stays too", () => {
  const box = machine();
  writeFileSync(join(box.state, "other"), "");
  box.tailnet.serve("7340", HOST);
  box.tailnet.off();
  assert.equal(box.file("served"), "");
  assert.ok(existsSync(join(box.state, "other")));
  assert.ok(box.calls().includes("serve --https=443 off"));
  assert.ok(!box.calls().some((call) => call.includes("reset")));
  assert.equal(existsSync(join(box.root, "tailscale.json")), false);
  assert.match(box.said(), /Removed AgentRun from your tailnet \(tailscale serve --https=443 off\)/);

  box.tailnet.serve("7340", HOST);
  writeFileSync(join(box.state, "served"), "http://127.0.0.1:3000\n");
  const before = box.calls().length;
  box.tailnet.off();
  assert.equal(box.file("served"), "http://127.0.0.1:3000\n");
  assert.deepEqual(box.calls().slice(before), ["serve status --json"]);
  assert.equal(existsSync(join(box.root, "tailscale.json")), false);
  // Nothing recorded: off asks Tailscale nothing.
  box.tailnet.off();
  assert.deepEqual(box.calls().slice(before), ["serve status --json"]);
});

test("off with Tailscale stopped keeps its record and says to run again; with Tailscale gone, the record goes too", () => {
  const box = machine();
  box.tailnet.serve("7340", HOST);
  writeFileSync(join(box.state, "mode"), "down\n");
  box.tailnet.off("agentrun service uninstall");
  assert.equal(box.file("served"), "http://127.0.0.1:7340\n");
  assert.ok(existsSync(join(box.root, "tailscale.json")), "the record stays for the next run");
  assert.match(box.said(), /AgentRun's entry at https:\/\/box\.tail1234\.example\/ may still be in Tailscale's serve settings, and they can't be read now \(failed to connect to local tailscaled.*\)\. Start Tailscale, then run again: agentrun service uninstall$/);
  // Started again, the next run removes it.
  writeFileSync(join(box.state, "mode"), "ok\n");
  box.tailnet.off();
  assert.equal(box.file("served"), "");
  assert.equal(existsSync(join(box.root, "tailscale.json")), false);

  const gone = machine();
  gone.tailnet.serve("7340", HOST);
  rmSync(join(gone.home, "fakes", "tailscale"));
  gone.tailnet.off();
  assert.equal(existsSync(join(gone.root, "tailscale.json")), false);
});

/** serviceOf on Linux with a fake systemd that "starts" a server by writing its record, and the fake tailscale. */
function serviceBox(mode = "ok", { env = { PATH: "/usr/bin" }, get = async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) }) } = {}) {
  const box = machine(mode);
  const execed = [];
  const exec = (command, args, options) => {
    execed.push([command, ...args].join(" "));
    if (command === "tailscale") return box.exec(command, args, options);
    if (command === "loginctl") return { status: 0, stdout: "yes\n", stderr: "" };
    if (["restart", "start"].includes(args[1])) {
      // The server's record goes in its data folder, as the unit names it.
      const words = unitArgs(unit());
      const data = words.includes("--data") ? words[words.indexOf("--data") + 1] : box.root;
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, ".server.json"), JSON.stringify({ base_url: "http://127.0.0.1:7340/v2", pid: process.pid }));
    }
    return { status: 0, stdout: args[1] === "show" ? "ActiveState=active\nSubState=running\nMainPID=7\n" : "", stderr: "" };
  };
  const out = [];
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => out.push(text) } };
  const launch = async (command, args) => (execed.push([command, ...args].join(" ")), true);
  const service = serviceOf({ platform: "linux", home: box.home, uid: 1000, user: "a", env, exec, io, fail, get, waitMs: 5_000, launch });
  const unit = () => readFileSync(join(box.home, ".config", "systemd", "user", UNIT), "utf8");
  return { ...box, service, unit, said: () => out.join(""), execed };
}

// The setup link a server on the tailnet prints names its tailnet address, which answers only once serve is on: the
// page opens after serve, never before it.
test("service install --tailscale on a server with no owner opens its setup page once serve is on", async () => {
  const session = { accounts: true, password_set: false, signed_in: false, setup_code: true };
  const get = async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith("/auth/session") ? session : url.endsWith("/setup/code") ? { printed: false } : { status: "ok" }) });
  const box = serviceBox("ok", { env: { PATH: "/usr/bin", DISPLAY: ":0" }, get });
  mkdirSync(join(box.root, "logs"), { recursive: true });
  writeFileSync(join(box.root, "logs", "agentrun.log"), `Set up this server: https://${HOST}/setup#code=CODE1 (or paste AGENTRUN_TOKEN)\n`);
  assert.equal(await box.service.install({ tailscale: true }), 0);
  const order = box.execed.filter((call) => call.startsWith("tailscale serve --bg") || call.startsWith("xdg-open"));
  assert.deepEqual(order, ["tailscale serve --bg --https=443 http://127.0.0.1:7340", `xdg-open https://${HOST}/setup#code=CODE1`]);
});

test("service install --tailscale: the unit names the https address and the fixed port, and serve follows the start", async () => {
  const box = serviceBox();
  assert.equal(await box.service.install({ tailscale: true }), 0);
  assert.deepEqual(unitArgs(box.unit()).slice(1), ["--no-open", "--port", "7340"]);
  assert.match(box.unit(), new RegExp(`^Environment=AGENTRUN_PUBLIC_URL=https://${HOST.replace(/\./g, "\\.")}/$`, "m"));
  assert.match(box.unit(), /^Environment=AGENTRUN_TRUSTED_PROXIES=loopback$/m);
  const order = box.execed.filter((call) => call.startsWith("tailscale serve --bg") || call.includes("restart"));
  assert.deepEqual(order, ["systemctl --user restart agentrun.service", "tailscale serve --bg --https=443 http://127.0.0.1:7340"]);
  assert.match(box.said(), /AgentRun is running at http:\/\/127\.0\.0\.1:7340\/[\s\S]*AgentRun is on your tailnet at https:\/\/box\.tail1234\.example\//);

  // Installed again with neither flag (`--service`, an install with --port): it stays on the tailnet.
  assert.equal(await box.service.install({ port: "7400" }), 0);
  assert.match(box.unit(), /AGENTRUN_PUBLIC_URL=/);
  assert.equal(box.file("served"), "http://127.0.0.1:7400\n");
  // --no-tailscale: the entry goes, and the unit no longer names the address.
  assert.equal(await box.service.install({ tailscale: false }), 0);
  assert.doesNotMatch(box.unit(), /AGENTRUN_PUBLIC_URL/);
  assert.equal(box.file("served"), "");
});

test("a sharing flag alone keeps the installed service's data folder and port; --port 0 is refused on the tailnet", async () => {
  const box = serviceBox();
  const data = join(box.home, "my-data");
  assert.equal(await box.service.install({ data, port: "7400" }), 0);
  assert.equal(await box.service.install({ tailscale: true }), 0);
  assert.deepEqual(unitArgs(box.unit()).slice(1), ["--no-open", "--data", data, "--port", "7400"]);
  assert.equal(box.file("served"), "http://127.0.0.1:7400\n");
  assert.equal(await box.service.install({ tailscale: false }), 0);
  assert.deepEqual(unitArgs(box.unit()).slice(1), ["--no-open", "--data", data, "--port", "7400"]);
  assert.doesNotMatch(box.unit(), /AGENTRUN_PUBLIC_URL/);

  const zero = serviceBox();
  await assert.rejects(zero.service.install({ tailscale: true, port: "0" }), (error) => error.code === 2 && /--tailscale serves a fixed port, and --port 0/.test(error.message));
  assert.equal(existsSync(join(zero.home, ".config", "systemd", "user", UNIT)), false);
  assert.ok(!zero.execed.some((call) => call.startsWith("tailscale")));
});

test("service install --tailscale with Tailscale missing installs AgentRun anyway, exit 0; Funnel on refuses before the unit is written", async () => {
  const missing = serviceBox("none");
  assert.equal(await missing.service.install({ tailscale: true }), 0);
  assert.doesNotMatch(missing.unit(), /AGENTRUN_PUBLIC_URL/);
  assert.match(missing.said(), /Tailscale is not installed here, so[\s\S]*Then run again: agentrun service install --tailscale\n[\s\S]*AgentRun is running at/);

  const funnel = serviceBox();
  writeFileSync(join(funnel.state, "served"), "http://127.0.0.1:7340\n");
  writeFileSync(join(funnel.state, "funnel"), "");
  await assert.rejects(funnel.service.install({ tailscale: true }), (error) => error.code === 1 && /Tailscale Funnel is on/.test(error.message));
  assert.equal(existsSync(join(funnel.home, ".config", "systemd", "user", UNIT)), false);
  assert.ok(!funnel.execed.some((call) => call.startsWith("systemctl --user restart")));
});

test("service uninstall removes the service and its serve entry, and leaves another entry alone", async () => {
  const box = serviceBox();
  writeFileSync(join(box.state, "other"), "");
  await box.service.install({ tailscale: true });
  assert.equal(await box.service.uninstall(), 0);
  assert.equal(box.file("served"), "");
  assert.ok(existsSync(join(box.state, "other")));
  assert.match(box.said(), /Removed AgentRun from your tailnet[\s\S]*Removed AgentRun's service/);
});

test("install.sh: --tailscale is in its help, and an install with no service manager runs the tailnet step as a script", () => {
  const help = spawnSync("sh", [new URL("../install.sh", import.meta.url).pathname, "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /--tailscale +also serve it over HTTPS on your own tailnet only/);
  const box = machine();
  const script = new URL("../lib/tailscale.mjs", import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...box.env, HOME: box.home } });
  const address = run("address", "7340", "again");
  assert.deepEqual([address.status, address.stdout], [0, `https://${HOST}/\n`]);
  const serve = run("serve", "7340", "again", `https://${HOST}/`);
  assert.equal(serve.status, 0);
  assert.match(serve.stdout, /AgentRun is on your tailnet at https:\/\/box\.tail1234\.example\//);
  assert.match(serve.stdout, /the newest "Set up this server" line in .*\.agentrun\/logs\/agentrun\.log has the link/);
  // --vps names where its server's log is: Docker Compose's, not a file of this user's.
  const vps = run("serve", "7340", "again", `https://${HOST}/`, "`docker compose logs` in /opt/agentrun");
  assert.equal(vps.status, 0);
  assert.match(vps.stdout, /the newest "Set up this server" line in `docker compose logs` in \/opt\/agentrun has the link\./);
  writeFileSync(join(box.state, "funnel"), "");
  const refused = run("address", "7340", "curl -fsSL https://agentrun.ai/install | sh -s -- --tailscale");
  assert.deepEqual([refused.status, refused.stdout], [1, ""]);
  assert.match(refused.stderr, /^agentrun: Tailscale Funnel is on .*run again: curl -fsSL https:\/\/agentrun\.ai\/install \| sh -s -- --tailscale\n$/);
  assert.equal(run("off").status, 0);
  assert.equal(box.file("served"), "");
});
