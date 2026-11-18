// `agentrun doctor`: how this AgentRun is set up, checked in one go, each problem with what to change. It reads and never
// writes: no file is changed, nothing is started or stopped, and every request is a GET. The server is the one the data
// directory's record names (DIR/.server.json, as `agentrun service status` reads it: service.mjs healthOf); its routes
// that take no credential (/v2/health, /v2/auth/session) come first, and capabilities are read with the server's own
// token (DIR/.token) only where that file is there. No token, key, setup code or other secret is ever printed: the token
// goes in a header to this machine's own server and nowhere else, and the log that holds the setup link is named, never
// read.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { healthOf, INSTALL_COMMAND, managerOf } from "./service.mjs";

const OWN = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const REPO = "https://github.com/Parcha-ai/agentrun/blob/main/packages";
export const DOCS = {
  launcher: `${REPO}/agentrun/README.md`,
  health: `${REPO}/serve/README.md#capacity-and-health`,
  address: `${REPO}/serve/README.md#quick-start-no-key-no-network`,
  password: `${REPO}/serve/README.md#your-password`,
  models: `${REPO}/serve/README.md#models`,
  harnesses: `${REPO}/serve/README.md#harnesses`,
  safety: `${REPO}/serve/README.md#safety`,
  docker: `${REPO}/serve/README.md#a-run-in-a-docker-box`,
};
const REQUEST_MS = 3_000;
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/** A check's line: `ok`, `warn` (works, with a gap), `fail` (something will not work), `info` (a fact, nothing to fix) or
 *  `skip` (could not be checked, and why). */
const line = (id, title, status, summary, { fix = [], docs, details } = {}) => ({ id, title, status, summary, fix, ...(docs ? { docs } : {}), ...(details ? { details } : {}) });

/** `version` against a floor ">=MAJOR.MINOR.PATCH": true when it is that or newer. */
export function meetsFloor(version, engines) {
  const floor = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(engines ?? "");
  if (!floor) return true;
  const need = floor.slice(1).map(Number);
  const have = String(version).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) > need[i];
  return true;
}

/** Every check, from what this machine and its server say. Each dependency can be replaced (tests): `exec` has
 *  spawnSync's shape, `get` fetch's, `readToken` returns the server's token or undefined (and may throw, which skips the
 *  capabilities read). */
export async function doctorOf({
  data,
  env = process.env,
  platform = process.platform,
  home = homedir(),
  uid = process.getuid?.(),
  user = userInfo().username,
  exec = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 10_000, env }),
  get = fetch,
  nodeVersion = process.versions.node,
  engines = OWN.engines.node,
  readToken = () => undefined,
}) {
  data = resolve(data ?? join(home, ".agentrun"));
  const root = join(home, ".agentrun");
  const floor = engines.replace(/^>=/, "");
  const checks = [];
  const add = (...args) => checks.push(line(...args));
  const getJson = async (url, headers = {}) => {
    try {
      const response = await get(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(REQUEST_MS) });
      const body = await response.json().catch(() => undefined);
      return { status: response.status, body };
    } catch (error) {
      return { status: 0, error: error?.cause?.code ?? error?.name ?? "error" };
    }
  };

  // 1. Node: this command's, and the `node` on PATH, which `npx @parcha/agentrun` runs on.
  const fromPath = exec("node", ["--version"]);
  const pathVersion = fromPath.status === 0 ? String(fromPath.stdout ?? "").trim().replace(/^v/, "") : undefined;
  const nodeFix = [`Install AgentRun with a Node.js of its own: ${INSTALL_COMMAND}`, `Or install Node.js ${floor} or newer (https://nodejs.org).`];
  if (!meetsFloor(nodeVersion, engines)) add("node", "Node", "fail", `This command runs on Node.js v${nodeVersion}; AgentRun needs ${floor} or newer.`, { fix: nodeFix, docs: DOCS.launcher });
  else if (pathVersion !== undefined && pathVersion !== nodeVersion && !meetsFloor(pathVersion, engines)) {
    add("node", "Node", "warn", `This command runs on Node.js v${nodeVersion}, but the node on PATH is v${pathVersion}, older than ${floor}: npx @parcha/agentrun refuses to start on it.`, { fix: nodeFix, docs: DOCS.launcher });
  } else add("node", "Node", "ok", `Node.js v${nodeVersion} (AgentRun needs ${floor} or newer).`);

  // 2. Server: the record's address, /v2/health there.
  let record;
  try {
    record = JSON.parse(readFileSync(join(data, ".server.json"), "utf8"));
  } catch {}
  const health = await healthOf(data, { fetch: get });
  const base = typeof record?.base_url === "string" && URL.canParse(record.base_url) ? record.base_url.replace(/\/+$/, "") : undefined;
  const answering = health.health !== undefined && !health.health.startsWith("not answering");
  const program = join(root, "bin", "agentrun");
  const manager = managerOf({ platform, home, uid, user, env, exec, fail: (_code, message) => new Error(message) });
  // The service counts only when it serves this data directory: one installed for another is said, and left out.
  const unitText = manager !== undefined && existsSync(manager.file) ? readFileSync(manager.file, "utf8") : undefined;
  const unitArgs = unitText === undefined ? [] : manager.args(unitText);
  const serviceData = unitText === undefined ? undefined : resolve(unitArgs.includes("--data") ? unitArgs[unitArgs.indexOf("--data") + 1] : root);
  const installed = serviceData === data;
  const dataFlag = data === root ? "" : ` --data ${data}`;
  const startFix = installed ? ["agentrun service start", "agentrun service logs  (if it does not come up: the log says why)"]
    : existsSync(program) ? [`${program}${dataFlag}  (in a terminal), or agentrun service install${dataFlag}  (keeps it running)`]
    : dataFlag ? [`npx @parcha/agentrun${dataFlag}  (in a terminal)`] : [`${INSTALL_COMMAND}  (installs and starts it)`, "Or, in a terminal: npx @parcha/agentrun"];

  // Capabilities, with the server's own token, read only from this data directory's private token file.
  let caps;
  let capsWhy;
  if (answering && base) {
    let token;
    try {
      token = readToken({ data, record, env });
    } catch (error) {
      capsWhy = error.message;
    }
    if (token) {
      const answer = await getJson(`${base}/capabilities`, { authorization: `Bearer ${token}` });
      if (answer.status === 200 && answer.body && typeof answer.body === "object") caps = answer.body;
      else capsWhy = `GET /v2/capabilities answered ${answer.status || answer.error}`;
    } else capsWhy ??= `no token to read the server's capabilities with: ${join(data, ".token")} is not there${record?.token_file ? "" : " (the server was started with AGENTRUN_TOKEN; set AGENTRUN_API_KEY to it)"}`;
  }
  const version = caps?.server?.version;

  if (health.health === "ok") add("server", "Server", "ok", `${health.url} answers /v2/health ok${version ? `, version ${version}` : ""}.`, { details: { url: health.url, version: version ?? null } });
  else if (answering) {
    const why = Object.entries(health.checks ?? {}).filter(([, value]) => value !== "ok").map(([name, value]) => `${name} ${value}`).join(", ");
    const fix = [];
    if (health.checks?.disk === "below_floor") fix.push(`Free disk space where ${data} is (the server needs 64 MiB free, or AGENTRUN_MIN_FREE_MB).`);
    if (health.checks?.store === "does_not_open") fix.push("The store does not answer: agentrun service logs (or the terminal it runs in) says why; then agentrun service restart.");
    if (!fix.length) fix.push("agentrun service logs, then agentrun service restart");
    add("server", "Server", "fail", `${health.url} answers /v2/health ${health.health}${why ? ` (${why})` : ""}.`, { fix, docs: DOCS.health, details: { url: health.url, version: version ?? null } });
  } else {
    const where = base ? `The server recorded in ${join(data, ".server.json")} (${health.url}) is ${health.health}.` : `No AgentRun server is running for ${data} (no ${join(data, ".server.json")}).`;
    add("server", "Server", "fail", where, { fix: startFix, docs: DOCS.launcher });
  }
  const skip = (id, title) => add(id, title, "skip", "No server answering to ask.");
  const noCaps = (id, title) => add(id, title, "skip", `Not checked: ${capsWhy}.`);

  // 3. Service: installed? running? lingering?
  if (manager === undefined) add("service", "Service", "info", `AgentRun runs as a service on macOS (launchd) and Linux (systemd); this is ${platform}.`);
  else if (serviceData !== undefined && !installed) add("service", "Service", "info", `AgentRun's service (${manager.name}) serves another data directory, ${serviceData}, not this one.`);
  else if (installed) {
    const state = manager.state();
    const notes = manager.notes();
    if (!state.active) {
      add("service", "Service", answering ? "warn" : "fail", `${manager.name} is installed but ${state.words}${answering ? "; the server that answers was started another way" : ""}.`, { fix: ["agentrun service start", "agentrun service logs  (why it stopped)"], docs: DOCS.launcher });
    } else if (notes.length) add("service", "Service", "warn", `${manager.name}, ${state.words}. ${notes.join(" ").split(". To keep")[0]}.`, { fix: notes.map((note) => note.replace(/^.*run once: /, "")), docs: DOCS.launcher });
    else add("service", "Service", "ok", `${manager.name}, ${state.words}: it starts again at login${platform === "linux" ? " and at boot" : ""}.`);
  } else {
    const why = manager.available();
    const background = existsSync(join(root, "agentrun.pid"));
    if (why !== undefined) add("service", "Service", "info", `Not a service: ${why}.${background ? " The installer started AgentRun in the background; agentrun stop stops it." : ""}`);
    else add("service", "Service", "warn", "AgentRun is not installed as a service: it stops when its terminal closes or this machine restarts.", { fix: [existsSync(program) ? "agentrun service install" : `${INSTALL_COMMAND}  (installs it as a service)`], docs: DOCS.launcher });
  }

  // 4. Address: who can open it.
  if (!answering || !base) skip("address", "Address");
  else {
    const at = new URL(base);
    const port = at.port || (at.protocol === "https:" ? "443" : "80");
    // A public address or another Host name: from capabilities, else from the service's own settings and the tailnet record.
    const named = installed && (/AGENTRUN_PUBLIC_URL=/.test(unitText) || unitArgs.includes("--allow-host"));
    let tailnet;
    try {
      // The tailnet entry the launcher added serves the service's port: this server's only when it is the service's.
      if (installed) tailnet = JSON.parse(readFileSync(join(root, "tailscale.json"), "utf8"));
    } catch {}
    const reachable = caps?.features?.triggers?.public_url === true || named || typeof tailnet?.url === "string";
    const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY) || (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY);
    if (!LOOPBACK.test(at.hostname)) add("address", "Address", "ok", `It listens at ${at.host}, which other machines that reach this one can open; the token and the password are its only lock, so put TLS in front of it.`);
    else if (reachable) add("address", "Address", "ok", `It listens on loopback (${at.host}) and is served at a name of its own${typeof tailnet?.url === "string" ? ` (${tailnet.url}, on your tailnet)` : " (AGENTRUN_PUBLIC_URL or --allow-host)"}.`);
    else if (!remote) add("address", "Address", "ok", `It listens on loopback (${at.host}): a browser on this machine opens it.`);
    else {
      const fix = [`From your own computer, a tunnel: ssh -L ${port}:localhost:${port} <this machine>, then open http://localhost:${port}/`];
      const status = exec("tailscale", ["status", "--json"]);
      let ts;
      try {
        ts = status.status === 0 ? JSON.parse(status.stdout) : undefined;
      } catch {}
      const host = String(ts?.Self?.DNSName ?? "").replace(/\.$/, "");
      if (ts?.BackendState === "Running" && host) {
        fix.push(`On your tailnet only (never Funnel): tailscale serve --bg ${port}, then restart AgentRun with AGENTRUN_PUBLIC_URL=https://${host} so it answers at that name`);
        // The launcher's own --tailscale serves the default data directory's AgentRun.
        if (data === root) fix.push(installed || existsSync(program) ? "Or let AgentRun do both, as a service: agentrun service install --tailscale" : `Or let the installer do both: ${INSTALL_COMMAND} -s -- --tailscale`);
      }
      fix.push("Behind a proxy or another name: restart it with AGENTRUN_PUBLIC_URL=https://<name> (or --allow-host <name>); it refuses any other Host name");
      add("address", "Address", "warn", `It listens on loopback only (${at.host}), and this session looks remote${env.SSH_CONNECTION || env.SSH_TTY ? " (SSH)" : " (no display)"}: a browser on another computer cannot open it.`, { fix, docs: DOCS.address });
    }
  }

  // 5. Owner: is the console's password set?
  if (!answering || !base) skip("owner", "Owner");
  else {
    const session = await getJson(`${base}/auth/session`);
    if (session.status === 200 && session.body?.password_set === true) add("owner", "Owner", "ok", "The console's password is set.");
    else if (session.status === 200 && session.body?.password_set === false) {
      const log = join(root, "logs", "agentrun.log");
      add("owner", "Owner", "warn", "No password yet: whoever opens the console first sets it. Set it now.", {
        fix: installed
          ? [`Open the setup link: the newest "Set up this server:" line in ${log}`, "agentrun service logs --lines 200 | grep 'Set up this server'"]
          : [`Open the setup link: the newest "Set up this server:" line where AgentRun started (its terminal, or ${log} when the installer started it)`],
        docs: DOCS.password,
      });
    } else if (session.status === 404) add("owner", "Owner", "info", "This server has no accounts (AGENTRUN_ACCOUNTS=0): its token opens the console.");
    else add("owner", "Owner", "skip", `GET /v2/auth/session answered ${session.status || session.error}.`);
  }

  // 6. Models and harnesses.
  if (!answering || !base) skip("models", "Models"), skip("harnesses", "Harnesses");
  else if (!caps) noCaps("models", "Models"), noCaps("harnesses", "Harnesses");
  else {
    const models = caps.models ?? {};
    if (models.ready === true) {
      const through = { gateway: "through the gateway (AGENT_MODEL_BASE_URL)", chatgpt: "on the ChatGPT plan", faux: "on the faux model", providers: "on a provider's key" }[models.source] ?? `from ${models.source}`;
      add("models", "Models", "ok", `A model is ready ${through}${models.default ? `: ${models.default}` : ""}.`, { details: { source: models.source ?? null, default: models.default ?? null } });
    } else {
      const fix = models.needs === "model"
        ? ["AGENT_MODEL names a model no key here runs: set it to provider/model-id of a provider you have a key for, or add that provider's key in the console (Settings → Model keys)"]
        : [
            "In the console: Settings → Model keys (an Anthropic, OpenAI or OpenRouter key, or Continue with ChatGPT)",
            "Or a gateway (LiteLLM, OpenRouter, ...): restart AgentRun with AGENT_MODEL_BASE_URL=<its base URL>, AGENT_MODEL=<its model id>, AGENT_MODEL_GATEWAY_IDS=bare when it names models without a provider/ prefix, and AGENT_MODEL_API_KEY when it takes a key",
          ];
      add("models", "Models", "fail", `No model is ready (it needs ${models.needs === "model" ? "another model" : "a model key"}): no run can start.`, { fix, docs: DOCS.models, details: { source: models.source ?? null, needs: models.needs ?? null } });
    }
    const harnesses = Array.isArray(caps.harnesses) ? caps.harnesses : [];
    const ready = harnesses.filter((h) => h.available).map((h) => h.id);
    const not = harnesses.filter((h) => !h.available);
    // A reason that starts with its harness's name is said as it is.
    const notWords = not.map((h) => { const why = String(h.reason ?? "not available").replace(/\.$/, ""); return why.startsWith(h.id) ? why : `${h.id}: ${why}`; });
    const details = { ready, not_ready: Object.fromEntries(not.map((h) => [h.id, h.reason ?? null])) };
    if (!ready.length) add("harnesses", "Harnesses", "fail", `No harness runs here: ${notWords.join("; ")}.`, { fix: ["Add a model key (Models, above); each harness says what it needs"], docs: DOCS.harnesses, details });
    else add("harnesses", "Harnesses", not.length ? "info" : "ok", `Ready: ${ready.join(", ")}.${not.length ? ` Not ready: ${notWords.join("; ")}.` : ""}`, { ...(not.length ? { docs: DOCS.harnesses } : {}), details });
  }

  // 7. Start-time switches (a server from before they were listed has none).
  if (!answering || !base) skip("switches", "Switches");
  else if (!caps) noCaps("switches", "Switches");
  else if (!caps.switches || typeof caps.switches !== "object") add("switches", "Switches", "info", "This server does not list its start-time switches (a version from before they were listed).");
  else {
    const entries = Object.entries(caps.switches);
    const words = entries.map(([name, s]) => `${name} ${s?.on ? `on${s.value !== null && s.value !== "1" ? ` (${s.value})` : ""}` : "off"}`);
    add("switches", "Switches", "info", `${words.join(", ")}. Each is set where AgentRun starts and takes a restart.`, {
      docs: DOCS.safety,
      details: Object.fromEntries(entries.map(([name, s]) => [name, { on: Boolean(s?.on), value: s?.value ?? null, allows: s?.allows ?? null }])),
    });
  }

  // 8. Docker: the box a run's computer runs in.
  const dockerFix = (why) => {
    if (/permission denied/i.test(why) && platform === "linux") return [`Let this user use Docker: sudo usermod -aG docker ${user}, then log in again`, "Then restart AgentRun (agentrun service restart)"];
    return [platform === "darwin" ? "Install and start Docker Desktop (or OrbStack, Colima): docker info must answer" : "Install Docker Engine and start it (https://docs.docker.com/engine/install/): docker info must answer", "Then restart AgentRun (agentrun service restart): it looks for Docker at its start"];
  };
  const box = Array.isArray(caps?.places?.boxes) ? caps.places.boxes.find((b) => b.id === "docker") : undefined;
  if (box?.available) add("docker", "Docker", "ok", "Docker boxes are ready: an agent with a computer runs its tools in one.");
  else if (box) add("docker", "Docker", "warn", `No Docker box: ${box.reason ?? "unavailable"}. An agent that needs a computer (bash, files) fails to start, and new agents run on the runner.`, { fix: dockerFix(box.reason ?? ""), docs: DOCS.docker });
  else {
    const info = exec("docker", ["info", "--format", "{{.ServerVersion}}"]);
    const said = `${info.stderr ?? ""}`.trim().split("\n")[0];
    if (info.status === 0) add("docker", "Docker", "ok", `docker info answers (Docker ${String(info.stdout ?? "").trim()}).`);
    else if (info.error?.code === "ENOENT") add("docker", "Docker", "warn", "Docker is not installed: an agent that needs a computer (bash, files) fails to start.", { fix: dockerFix(""), docs: DOCS.docker });
    else add("docker", "Docker", "warn", `docker info does not answer${said ? ` (${said})` : ""}: an agent that needs a computer (bash, files) fails to start.`, { fix: dockerFix(said), docs: DOCS.docker });
  }

  const exit = !answering ? 3 : checks.some((c) => c.status === "fail") ? 1 : 0;
  return { data, launcher: OWN.version, server: answering ? { url: health.url, version: version ?? null } : null, exit, checks };
}

/** The checks as a person reads them: one line each, then its fix and docs when it is not ok. */
export function textOf(report, home = homedir()) {
  const tilde = (path) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
  const width = Math.max(...report.checks.map((c) => c.title.length));
  const out = [`AgentRun doctor (agentrun ${report.launcher}, data directory ${tilde(report.data)})`, ""];
  for (const check of report.checks) {
    out.push(`${check.status.padEnd(4)}  ${check.title.padEnd(width)}  ${check.summary}`);
    const pad = " ".repeat(6 + width + 2);
    for (const fix of check.fix) out.push(`${pad}Fix: ${fix}`);
    if (check.docs && check.status !== "ok") out.push(`${pad}Docs: ${check.docs}`);
  }
  const counts = ["fail", "warn"].map((status) => [status, report.checks.filter((c) => c.status === status).length]).filter(([, n]) => n);
  out.push("", report.exit === 3 ? "No server is answering: start it first (Server, above)." : counts.length ? `${counts.map(([status, n]) => `${n} ${status === "fail" ? "failed" : n === 1 ? "warning" : "warnings"}`).join(", ")}.` : "All good.");
  return `${out.join("\n")}\n`;
}

/** `agentrun doctor` (cli.mjs LOCAL). */
export const DOCTOR = {
  command: ["doctor"],
  pathParams: [],
  summary: "Check how this AgentRun is set up (Node, the server, its service, address, password, models, switches, Docker) and print what to change; read-only (exit 0 ok or warnings, 1 a check failed, 3 no server answering)",
  help: [["--data DIR", "the data directory whose server it checks (default ~/.agentrun)"], ["--json", "print the checks as JSON: {exit, server, checks: [{id, status, summary, fix, docs}]}"]],
  options: { json: { type: "boolean" } },
  async run({ values, io, env, cli }) {
    if (values["base-url"] !== undefined) throw cli.fail(2, "agentrun doctor checks the AgentRun on this machine, the server of --data (default ~/.agentrun); it takes no --base-url.");
    const readToken = ({ data, record, env: vars }) => {
      if (record && !record.token_file) return vars.AGENTRUN_API_KEY || undefined;
      return cli.privateFile(join(data, ".token"))?.trim() || undefined;
    };
    const report = await doctorOf({ data: values.data, env, readToken });
    io.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : textOf(report));
    return report.exit;
  },
};
