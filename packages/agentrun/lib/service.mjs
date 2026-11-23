// `agentrun service install|status|start|stop|restart|logs|upgrade|uninstall`: AgentRun as a service of this user, so it
// keeps running after the terminal closes and starts again at login. A launchd LaunchAgent on macOS, a systemd --user
// unit on Linux; never a system service, never sudo. The service runs the installer's command (~/.agentrun/bin/agentrun,
// install.sh), which brings its own Node, with --no-open and the interactive launcher's rules for the data directory and
// port, and writes to ~/.agentrun/logs/agentrun.log. With --tailscale it is also served on the person's tailnet
// (tailscale.mjs); with --env, on a local model, an Ollama off its default address or with a start-time switch on (SERVICE_ENV). `agentrun stop` stops the AgentRun the installer starts in the
// background where there is no service manager (a container): its pid is in ~/.agentrun/agentrun.pid.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicUrlOf } from "./public-url.mjs";
import { TAILNET_PORT, tailnetOf, targetOf } from "./tailscale.mjs";

export const LABEL = "ai.agentrun.server";
export const UNIT = "agentrun.service";
export const INSTALL_COMMAND = "curl -fsSL https://agentrun.ai/install | sh";
/** How long a start waits for the server to answer /health before it says it did not. */
export const HEALTH_WAIT_MS = 90_000;
/** How long `agentrun stop` waits for the background AgentRun to end after its SIGTERM before it sends a SIGKILL: past the
 *  server's own drain (--drain-timeout, 30 s by default), so a busy run gets its turn and the server cleans up. */
export const STOP_WAIT_MS = 45_000;
const INSTALLER = fileURLToPath(new URL("../install.sh", import.meta.url));

const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unxml = (text) => text.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/** The LaunchAgent: started at login (RunAtLoad), started again when it exits with a failure (KeepAlive), its output in
 *  `log`, with the PATH of the shell that installed it (launchd's own has no Homebrew, so no docker) and `env`. */
export function plistText({ program, args, path, log, env = {} }) {
  const strings = [program, ...args].map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
  const vars = Object.entries({ PATH: path, ...env }).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** The command and arguments a plist made by plistText runs. */
export const plistArgs = (text) => [...(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "").matchAll(/<string>([^<]*)<\/string>/g)].map((match) => unxml(match[1]));

/** The variables a plist made by plistText sets. */
export const plistEnv = (text) =>
  Object.fromEntries([...(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(text)?.[1] ?? "").matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)].map((match) => [unxml(match[1]), unxml(match[2])]));

/** One word of a systemd command line or setting: quoted when it needs to be, its specifiers (%) and variables ($)
 *  escaped, as systemd.syntax(7) reads them. */
export const systemdWord = (word) => {
  const escaped = word.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[\w@+=:,./-]+$/.test(escaped) ? escaped : `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

/** The words of an ExecStart line systemdWord wrote. */
export function systemdWords(line) {
  const words = [];
  for (const [, quoted, plain] of line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    words.push((quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : plain).replace(/\$\$/g, "$").replace(/%%/g, "%"));
  }
  return words;
}

/** The systemd --user unit: started at login (default.target) and at boot when lingering is on, started again when it
 *  fails, its output appended to `log`, with the PATH of the shell that installed it and `env`. */
export function unitText({ program, args, path, log, env = {} }) {
  return `[Unit]
Description=AgentRun, an open-source platform for your agents
After=network-online.target

[Service]
ExecStart=${[program, ...args].map(systemdWord).join(" ")}
${Object.entries({ PATH: path, ...env }).map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`)}`).join("\n")}
Restart=on-failure
RestartSec=2
StandardOutput=append:${log.replace(/%/g, "%%")}
StandardError=append:${log.replace(/%/g, "%%")}

[Install]
WantedBy=default.target
`;
}

/** The command and arguments a unit made by unitText runs. */
export const unitArgs = (text) => systemdWords(/^ExecStart=(.*)$/m.exec(text)?.[1] ?? "");

/** The variables a unit made by unitText sets. */
export const unitEnv = (text) =>
  Object.fromEntries([...text.matchAll(/^Environment=(.*)$/gm)].map((match) => systemdWords(match[1])[0] ?? "").map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));

/** The variables `service install --env` sets, and an installed service keeps through a re-install: each name, with the
 *  values it takes alone, or null for any value. `KEY=` removes one. Never a model key: a unit file is plain text, and keys
 *  are sealed in the console.
 *  - A local model's (AGENT_MODEL_BASE_URL in front of a gateway such as Ollama's), and its key at `none`: a server that
 *    holds no key for its gateway refuses each run that brings none (run-model-key.ts, model_key_required).
 *  - Where Ollama listens (OLLAMA_HOST, read as the ollama CLI reads it), for an Ollama off its default address: the
 *    server lists its models itself (serve's ollama-provider.ts).
 *  - The start-time switches (the server's start-switches.ts), on at `1` alone, for a machine its owner alone uses. A
 *    server reads them at its start, so the service restarts.
 *  - The usage counts' switches (docs/telemetry.md). A service never sees the shell that installed it, so install writes
 *    these into it as that shell set them, and AGENTRUN_TELEMETRY=0 under CI. */
export const SERVICE_ENV = {
  AGENT_MODEL_BASE_URL: null,
  AGENT_MODEL_GATEWAY_IDS: null,
  AGENT_MODEL: null,
  AGENT_MODEL_PRICE: null,
  AGENT_MODEL_API_KEY: ["none"],
  OLLAMA_HOST: null,
  AGENTRUN_MCP_ALLOW_LOOPBACK: ["1"],
  AGENTRUN_WEBHOOK_PRIVATE_TARGETS: ["1"],
  AGENTRUN_TELEMETRY: null,
  DO_NOT_TRACK: null,
};
const SERVICE_NAMES = Object.keys(SERVICE_ENV);
/** The usage counts' two switches in SERVICE_ENV, which install also copies from its own shell. */
const TELEMETRY_NAMES = ["AGENTRUN_TELEMETRY", "DO_NOT_TRACK"];

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The service manager of this platform, driven through `exec` (spawnSync's shape). */
export function managerOf({ platform, home, uid, user, env, exec, fail }) {
  const run = (command, args, { ok = false } = {}) => {
    const result = exec(command, args);
    if (!ok && result.status !== 0) {
      const said = `${result.error?.message ?? ""}${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split("\n").slice(-3).join(" ");
      throw fail(1, `${command} ${args.join(" ")} failed${said ? `: ${said}` : ""}.`);
    }
    return result;
  };
  if (platform === "darwin") {
    const domain = `gui/${uid}`;
    const target = `${domain}/${LABEL}`;
    const loaded = () => run("launchctl", ["print", target], { ok: true }).status === 0;
    // A job just booted out can still be going: bootstrap again, a few times, until launchd takes it.
    const bootstrap = (file) => {
      for (let tries = 1; ; tries++) {
        const result = run("launchctl", ["bootstrap", domain, file], { ok: true });
        if (result.status === 0) return;
        if (tries === 10) run("launchctl", ["bootstrap", domain, file]);
        sleep(500);
      }
    };
    const file = join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    return {
      file,
      name: `launchd ${target}`,
      text: plistText,
      args: plistArgs,
      env: plistEnv,
      available: () => (run("launchctl", ["print", domain], { ok: true }).status === 0 ? undefined : `this user has no launchd session (${domain}): a login over ssh has none; log in at the Mac`),
      install() {
        if (loaded()) run("launchctl", ["bootout", target], { ok: true });
        run("launchctl", ["enable", target], { ok: true });
        bootstrap(file);
      },
      start: () => (loaded() ? run("launchctl", ["kickstart", target]) : bootstrap(file)),
      stop: () => loaded() && run("launchctl", ["bootout", target]),
      restart: () => (loaded() ? run("launchctl", ["kickstart", "-k", target]) : bootstrap(file)),
      remove: () => loaded() && run("launchctl", ["bootout", target]),
      state() {
        const result = run("launchctl", ["print", target], { ok: true });
        if (result.status !== 0) return { active: false, words: "not loaded" };
        const state = /^\s*state = (.+)$/m.exec(result.stdout)?.[1]?.trim() ?? "unknown";
        const pid = /^\s*pid = (\d+)$/m.exec(result.stdout)?.[1];
        return { active: state === "running", words: pid ? `${state}, pid ${pid}` : state };
      },
      notes: () => [],
    };
  }
  if (platform === "linux") {
    const systemctl = (...args) => run("systemctl", ["--user", ...args]);
    return {
      file: join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", UNIT),
      name: `systemd --user ${UNIT}`,
      text: unitText,
      args: unitArgs,
      env: unitEnv,
      available() {
        const result = run("systemctl", ["--user", "show-environment"], { ok: true });
        if (result.error?.code === "ENOENT") return "this machine has no systemd";
        return result.status === 0 ? undefined : "this user has no systemd user session (a container, or a login without one)";
      },
      install() {
        systemctl("daemon-reload");
        systemctl("enable", UNIT);
        systemctl("restart", UNIT);
      },
      start: () => systemctl("start", UNIT),
      stop: () => systemctl("stop", UNIT),
      restart: () => systemctl("restart", UNIT),
      remove() {
        run("systemctl", ["--user", "disable", "--now", UNIT], { ok: true });
        run("systemctl", ["--user", "reset-failed", UNIT], { ok: true });
      },
      removed: () => systemctl("daemon-reload"),
      state() {
        const out = run("systemctl", ["--user", "show", UNIT, "--property=ActiveState,SubState,MainPID"], { ok: true }).stdout ?? "";
        const field = (name) => new RegExp(`^${name}=(.*)$`, "m").exec(out)?.[1]?.trim();
        const pid = field("MainPID");
        return { active: field("ActiveState") === "active", words: `${field("ActiveState") ?? "unknown"} (${field("SubState") ?? "?"})${pid && pid !== "0" ? `, pid ${pid}` : ""}` };
      },
      // Without lingering, a user's services stop at their last logout and start at their first login.
      notes() {
        const linger = run("loginctl", ["show-user", user, "--property=Linger", "--value"], { ok: true });
        return linger.status === 0 && linger.stdout.trim() === "no"
          ? [`It stops when you log out and starts when you log in. To keep it running, and start it at boot, run once: sudo loginctl enable-linger ${user}`]
          : [];
      },
    };
  }
  return undefined;
}

/** The data directory a service's arguments name, else the launcher's default. */
const dataOf = (args, home) => {
  const at = args.indexOf("--data");
  return resolve(at >= 0 ? args[at + 1] : join(home, ".agentrun"));
};

/** The server a data directory's record names, and whether it answers /health ok: `{ url, health, record }`. */
async function healthOf(data, { fetch: get = fetch, since = 0 } = {}) {
  const file = join(data, ".server.json");
  let record;
  try {
    // A record from before this start is the last server's. A second's slack: a file's time can trail the clock.
    if (statSync(file).mtimeMs < since - 1_000) return {};
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof record?.base_url !== "string" || !URL.canParse(record.base_url)) return {};
  const url = `${new URL(record.base_url).origin}/`;
  try {
    const response = await get(`${record.base_url.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(3_000) });
    const body = await response.json().catch(() => ({}));
    return { url, answered: true, health: response.ok && body?.status === "ok" ? "ok" : `${response.status} ${body?.status ?? ""}`.trim(), checks: body?.checks };
  } catch (error) {
    return { url, answered: false, health: `not answering (${error?.cause?.code ?? error?.name})` };
  }
}

/** Whether a browser can be opened here: not in CI, and on Linux or FreeBSD only with a display (serve's host.ts canOpen). */
export const canOpen = (env, platform) => !env.CI && (platform === "darwin" || (["linux", "freebsd"].includes(platform) && Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)));
/** Starts `command` on `args` for the browser and leaves it running: an opener can stay in the foreground until the
 *  browser it starts closes, so nothing waits for its exit (serve's --open spawns it the same way). True once it started,
 *  false when it could not (no such command). */
export const launchOpener = (command, args, env) => new Promise((done) => {
  const child = spawn(command, args, { env, stdio: "ignore", detached: true });
  child.once("error", () => done(false));
  child.once("spawn", () => {
    child.unref();
    done(true);
  });
});
/** The newest setup link a server printed to `log` (`Set up this server: <link> ...`), or undefined. */
export const SETUP_LINE = /^Set up this server: (https?:\/\/\S+\/setup#code=[A-Za-z0-9_-]+)/;
const SETUP_TAIL = 2_000;

/** The last `count` lines of a file, read back from its end only as far as they go: the log is appended to forever. */
const tailOf = (file, count) => {
  if (count === 0) return [];
  let fd;
  try {
    fd = openSync(file, "r");
    const chunks = [];
    let start = fstatSync(fd).size;
    let newlines = 0;
    while (start > 0 && newlines <= count) {
      const chunk = Buffer.alloc(Math.min(65_536, start));
      start -= chunk.length;
      readSync(fd, chunk, 0, chunk.length, start);
      chunks.unshift(chunk);
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) newlines++;
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (start > 0) lines.shift();
    return lines.slice(-count);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** Every service command, given what it runs on; the entries below bind it to this machine. */
export function serviceOf({ platform = process.platform, home = homedir(), uid = process.getuid?.(), user = userInfo().username, env = process.env, exec, io, fail, get = fetch, waitMs = HEALTH_WAIT_MS, kill = process.kill.bind(process), stopWaitMs = STOP_WAIT_MS, launch = launchOpener }) {
  exec ??= (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });
  const root = join(home, ".agentrun");
  const program = join(root, "bin", "agentrun");
  const log = join(root, "logs", "agentrun.log");
  const say = (line) => io.stdout.write(`${line}\n`);
  const manager = managerOf({ platform, home, uid, user, env, exec, fail });
  const need = () => {
    if (manager === undefined) throw fail(1, `AgentRun runs as a service on macOS (launchd) and Linux (systemd); this is ${platform}.`);
    return manager;
  };
  const installed = () => manager !== undefined && existsSync(manager.file);
  const needInstalled = () => {
    if (!installed()) throw fail(3, "AgentRun's service is not installed: agentrun service install installs it.");
    return manager;
  };
  const argsNow = () => manager.args(readFileSync(manager.file, "utf8")).slice(1);

  /** Waits for the server started at `since` to answer /health ok, then says where it is, runs `ready` and opens its
   *  setup page while it has no owner; exit 0, or 1 with the log's last lines. */
  async function started(since, data, ready = () => {}) {
    const deadline = Date.now() + waitMs;
    let last = {};
    while (Date.now() < deadline) {
      last = await healthOf(data, { fetch: get, since });
      if (last.health === "ok") {
        say(`AgentRun is running at ${last.url} (${manager.name}).`);
        say(`Logs: ${log}`);
        for (const note of manager.notes()) say(note);
        // The tailnet's serve entry first: the setup link names that address.
        ready();
        // A server with no owner yet: its setup page, open in the browser with the code filled in.
        await openPage(data, { setupOnly: true, url: last.url });
        return 0;
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    const lines = tailOf(log, 20);
    io.stderr.write(`AgentRun's service did not answer /health ok within ${waitMs / 1000} s${last.health ? ` (${last.health})` : ""}. Its state: ${manager.state().words}.\n`);
    if (lines.length) io.stderr.write(`The last lines of ${log}:\n${lines.map((line) => `  ${line}`).join("\n")}\n`);
    return 1;
  }

  /** The newest setup link in the service's log. */
  const newestSetup = () => {
    for (const line of tailOf(log, SETUP_TAIL).reverse()) {
      const found = SETUP_LINE.exec(line);
      if (found) return found[1];
    }
    return undefined;
  };

  /** `agentrun open`, and the end of a start: the page to open first, in this machine's browser. With no owner yet, the
   *  setup page: its code filled in when setup takes one (a code still good is kept; an expired or spent one is replaced
   *  first, as the page's Get a new code does), or `/setup` where setup takes none. With an owner, the console, unless
   *  `setupOnly`. The link is printed for the person at this terminal as well, for when no browser opens (an opener can
   *  start and still find none): theirs to open, and a setup code works once and for 30 minutes, unlike the API token,
   *  which never leaves its file. The code comes from the log the service (or the installer's background start) writes,
   *  so only for the data folder that log is for: another server prints its own elsewhere. Exit 0, or 1 when no server
   *  answers. */
  async function openPage(data, { setupOnly = false, url = undefined } = {}) {
    let unwell;
    if (url === undefined) {
      // A record a crash or a forced stop left behind names an address no server answers. A server that answers with a
      // failed check (low disk is a 503) still serves its console and its setup page: it opens, and the check is said.
      const now = await healthOf(data, { fetch: get });
      if (now.answered) url = now.url;
      if (now.answered && now.health !== "ok") {
        const failing = Object.entries(now.checks ?? {}).filter(([, value]) => value !== "ok").map(([name, value]) => `${name}: ${value}`);
        unwell = failing.length ? `${now.health} (${failing.join(", ")})` : now.health;
      }
    }
    if (!url) {
      if (setupOnly) return 0;
      io.stderr.write(`No AgentRun answers for ${data}: start it with agentrun service start, or agentrun.\n`);
      return 1;
    }
    const record = JSON.parse(readFileSync(join(data, ".server.json"), "utf8"));
    const api = record.base_url.replace(/\/+$/, "");
    const ask = async (path, init) => {
      try {
        const response = await get(`${api}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
        return response.ok ? await response.json().catch(() => ({})) : undefined;
      } catch {
        return undefined;
      }
    };
    if (unwell) say(`Its health check answers ${unwell}; agentrun service status says more.`);
    const logged = resolve(data) === (installed() ? dataOf(argsNow(), home) : resolve(root));
    const session = await ask("/auth/session");
    let link;
    let coded = false;
    if (session?.accounts !== false && session?.password_set === false) {
      if (session.setup_code) {
        const before = logged ? newestSetup() : undefined;
        const renewed = await ask("/setup/code", { method: "POST" });
        // A new code goes to the log as the answer is sent: wait for its line.
        for (let waited = 0; logged && renewed?.printed && newestSetup() === before && waited < 3_000; waited += 100) await new Promise((done) => setTimeout(done, 100));
        link = logged ? newestSetup() : undefined;
        coded = link !== undefined;
        if (!link) {
          link = url;
          say(`Its setup code is in the log of the terminal or service AgentRun runs in: the newest line "Set up this server:".`);
        }
      } else link = `${url}setup`;
    } else if (setupOnly) return 0;
    else link = url;
    const opener = platform === "darwin" ? "open" : "xdg-open";
    const opened = canOpen(env, platform) && (await launch(opener, [link], env));
    const setup = !(link === url && session?.password_set !== false);
    if (opened) {
      say(setup ? "Opened the setup page in your browser: set the owner password there." : "Opened the console in your browser.");
      say(`If no browser opened, open ${link}`);
    } else say(setup ? `Set the owner password at the setup page: ${link}` : `The console: ${link}`);
    if (coded) say("Its setup code works once and for 30 minutes; agentrun open gives a new one after that.");
    return 0;
  }

  return {
    open: ({ data, "setup-only": setupOnly }) => openPage(resolve(data ?? root), { setupOnly }),
    async install({ data, port, tailscale, env: sets = [], "public-url": given }) {
      if (port !== undefined && !/^\d+$/.test(port)) throw fail(2, `--port takes a port number, not ${port}.`);
      const changes = sets.map((pair) => {
        const at = pair.indexOf("=");
        if (at < 1) throw fail(2, `--env takes KEY=VALUE, not ${pair}.`);
        const key = pair.slice(0, at);
        if (!Object.hasOwn(SERVICE_ENV, key)) throw fail(2, `--env takes ${SERVICE_NAMES.slice(0, -1).join(", ")} or ${SERVICE_NAMES.at(-1)}, not ${key}: a key goes in the console (Settings → Model keys), never in a service file.`);
        if (/[\0-\x1f]/.test(pair)) throw fail(2, `${key}'s value has a line break or another control character.`);
        const takes = SERVICE_ENV[key];
        // The value is never echoed: it may be a key.
        if (takes && pair.slice(at + 1) !== "" && !takes.includes(pair.slice(at + 1))) throw fail(2, `${key} takes ${takes.join(" or ")} alone, or nothing to remove it: a model key goes in the console (Settings → Model keys), never in a service file.`);
        return [key, pair.slice(at + 1)];
      });
      // --public-url goes on the service's command line, so every start of it (a restart, a login) has it, and with it
      // the launcher's AGENTRUN_TRUSTED_PROXIES=loopback.
      let publicUrl = given === undefined ? undefined : publicUrlOf(given);
      if (publicUrl?.error !== undefined) throw fail(2, publicUrl.error);
      need();
      if (!existsSync(program)) throw fail(1, `AgentRun's service runs the installed command, ${program}, and it is not there. Install it first: ${INSTALL_COMMAND}`);
      const why = manager.available();
      if (why !== undefined) throw fail(1, `AgentRun can't run as a service here: ${why}. Start it in a terminal with ${program}.`);
      // An installed service keeps its local model's variables, its start-time switches and its usage counts' switches; the switches set in this
      // shell reach it (and under CI, AGENTRUN_TELEMETRY=0), then --env KEY=VALUE sets one and KEY= removes it.
      const model = installed() ? Object.fromEntries(Object.entries(manager.env(readFileSync(manager.file, "utf8"))).filter(([key]) => Object.hasOwn(SERVICE_ENV, key))) : {};
      for (const key of TELEMETRY_NAMES) if ((env[key] ?? "") !== "" && !/[\0-\x1f]/.test(env[key])) model[key] = env[key];
      if (env.CI && model.AGENTRUN_TELEMETRY === undefined) model.AGENTRUN_TELEMETRY = "0";
      for (const [key, value] of changes) {
        if (value === "") delete model[key];
        else model[key] = value;
      }
      // --tailscale, --no-tailscale, --env or --public-url on an installed service changes that only: its data folder, port
      // and public address stay unless named (the installer passes the flag alone). --tailscale names its own address instead.
      if ((tailscale !== undefined || changes.length > 0 || given !== undefined) && installed()) {
        const now = argsNow();
        const option = (name) => (now.includes(name) ? now[now.indexOf(name) + 1] : undefined);
        data ??= option("--data");
        port ??= option("--port");
        const kept = option("--public-url");
        if (publicUrl === undefined && tailscale !== true && kept !== undefined && publicUrlOf(kept).url !== undefined) publicUrl = publicUrlOf(kept);
      }
      const again = (flag) => [`agentrun service install ${flag}`, ...(port !== undefined ? [`--port ${port}`] : []), ...(data !== undefined ? [`--data ${resolve(data)}`] : [])].join(" ");
      const tailnet = tailnetOf({ platform, root, uid, exec, say, fail, again: again("--tailscale") });
      // --no-tailscale takes it off the tailnet; with neither flag, a service on the tailnet stays there.
      const share = tailscale ?? tailnet.recorded() !== undefined;
      // On the tailnet the port is fixed, so the serve entry and the server still agree after a restart.
      const served = share ? (port ?? TAILNET_PORT) : port;
      if (share && Number(served) === 0) throw fail(2, `--tailscale serves a fixed port, and --port 0 has the system pick another at each start: name a port, or leave --port out for ${TAILNET_PORT}.`);
      if (share && publicUrl !== undefined) {
        throw fail(2, `--public-url and --tailscale each set the address people open, and --tailscale names its own (this machine's tailnet name). Leave out --public-url, or take AgentRun off the tailnet with --no-tailscale.`);
      }
      if (!share) tailnet.off(again("--no-tailscale"));
      // The server knows the address people open: its host check takes the name, and its setup takes the printed code.
      const at = share ? tailnet.address(targetOf(served)) : undefined;
      const args = ["--no-open", ...(data !== undefined ? ["--data", resolve(data)] : []), ...(served !== undefined ? ["--port", served] : []), ...(publicUrl !== undefined ? ["--public-url", publicUrl.url] : [])];
      const vars = { ...model, ...(at ? { AGENTRUN_PUBLIC_URL: at.url, AGENTRUN_TRUSTED_PROXIES: "loopback" } : {}) };
      mkdirSync(join(root, "logs"), { recursive: true, mode: 0o700 });
      mkdirSync(join(manager.file, ".."), { recursive: true });
      writeFileSync(manager.file, manager.text({ program, args, path: env.PATH ?? "/usr/bin:/bin", log, env: vars }));
      const since = Date.now();
      manager.install();
      say(`Installed AgentRun's service (${manager.file}): it keeps running after this terminal closes, and starts again at login.`);
      return started(since, dataOf(args, home), () => {
        if (at) tailnet.serve(served, at.host);
      });
    },
    async status() {
      need();
      if (!installed()) {
        say("AgentRun's service is not installed: agentrun service install installs it.");
        return 3;
      }
      const state = manager.state();
      const { url, health } = state.active ? await healthOf(dataOf(argsNow(), home), { fetch: get }) : {};
      say(`Service: ${manager.name}, ${state.words}`);
      if (url) say(`Console: ${url}`);
      say(`Health: ${health ?? "not running"}`);
      say(`Logs: ${log}`);
      for (const note of manager.notes()) say(note);
      return state.active && health === "ok" ? 0 : 1;
    },
    async start() {
      needInstalled();
      // Starting a running service leaves it as it is, its record included.
      const since = manager.state().active ? 0 : Date.now();
      manager.start();
      return started(since, dataOf(argsNow(), home));
    },
    async restart() {
      needInstalled();
      const since = Date.now();
      manager.restart();
      return started(since, dataOf(argsNow(), home));
    },
    async stop() {
      needInstalled();
      manager.stop();
      say(`Stopped AgentRun's service (${manager.name}). agentrun service start starts it again; it also starts again at login.`);
      return 0;
    },
    async logs({ follow, lines }) {
      const count = lines === undefined ? 50 : Number(lines);
      if (!Number.isInteger(count) || count < 0) throw fail(2, `--lines takes a whole number, not ${lines}.`);
      if (!existsSync(log)) throw fail(1, `There is no service log yet (${log}).`);
      if (!follow) {
        for (const line of tailOf(log, count)) say(line);
        return 0;
      }
      return exec("tail", ["-n", String(count), "-f", log], { stdio: "inherit" }).status ?? 1;
    },
    async upgrade({ version }) {
      const args = ["--no-start", ...(version !== undefined ? ["--version", version] : [])];
      const result = exec("sh", [INSTALLER, ...args], { stdio: "inherit" });
      if (result.status !== 0) throw fail(1, `The installer stopped (${result.error?.message ?? `exit ${result.status}`}); the service was not restarted.`);
      if (!installed()) return say(`The service is not installed: ${program} service install starts it.`), 0;
      // The new version's own command restarts it, as the service's code may have changed with it.
      return exec(program, ["service", "restart"], { stdio: "inherit" }).status ?? 1;
    },
    async uninstall() {
      need();
      tailnetOf({ platform, root, uid, exec, say, fail, again: "agentrun service uninstall" }).off();
      if (!installed()) return say("AgentRun's service is not installed."), 0;
      manager.remove();
      unlinkSync(manager.file);
      manager.removed?.();
      say(`Removed AgentRun's service (${manager.file}). Its data stays in ${root}.`);
      return 0;
    },
    /** `agentrun stop`: the AgentRun install.sh started in the background, stopped as Ctrl-C would (SIGTERM, which the
     *  launcher passes on to the server), then SIGKILL past stopWaitMs. Exit 0 once the launcher and its server have
     *  ended, 3 when none is running, 1 when one outlives its SIGKILL or runs in the foreground (named, and left running). install.sh stops it with the same steps in sh, so an
     *  install of a version with no `agentrun stop` stops it too. */
    async background() {
      const file = join(root, "agentrun.pid");
      let pid;
      try {
        pid = Number(readFileSync(file, "utf8").trim());
      } catch {}
      // A process's state letter and command line: from /proc where there is one (a container may have no ps), else from
      // ps. Undefined once it is gone. A process that ended is a zombie (Z) until its parent reaps it, and in a container
      // with no init nothing does, so a zombie counts as ended.
      const processOf = (n) => {
        try {
          const stat = readFileSync(`/proc/${n}/stat`, "utf8");
          return { state: stat.slice(stat.lastIndexOf(")") + 2)[0], args: readFileSync(`/proc/${n}/cmdline`, "utf8").replaceAll("\0", " ") };
        } catch {
          if (existsSync("/proc/self/stat")) return undefined;
        }
        const ps = exec("ps", ["-o", "stat=", "-o", "args=", "-p", String(n)]);
        const [, state, args] = (ps.status === 0 && /^\s*(\S)\S*\s+(.*)$/s.exec(ps.stdout ?? "")) || [];
        return state === undefined ? undefined : { state, args };
      };
      // A pid file outlives a crash, and its pid can be another process's by now: only a running process that runs this
      // install's files counts.
      const ours = (n) => {
        const now = Number.isInteger(n) && n > 1 ? processOf(n) : undefined;
        return now !== undefined && now.state !== "Z" && now.args.includes(`${root}/`);
      };
      if (!ours(pid)) {
        rmSync(file, { force: true });
        // A server in the foreground (`npx @parcha/agentrun` in a terminal) has no pid file, only the record every server
        // writes, and it runs from npm's folder, not this install's. One whose process runs and whose recorded address
        // answers /health ok is named, with how to stop it, and left running: Ctrl-C there is its stop. A service writes the
        // same record and no pid file, so while one runs its server is the service's, and the hint below says so; with the
        // service stopped (service stop, then npx), a server that answers is in a terminal.
        let record;
        try {
          record = JSON.parse(readFileSync(join(root, ".server.json"), "utf8"));
        } catch {}
        const live = Number.isInteger(record?.pid) && record.pid > 1 && ![undefined, "Z"].includes(processOf(record.pid)?.state);
        if (live && !(installed() && manager.state().active) && (await healthOf(root, { fetch: get })).health === "ok") {
          say(`AgentRun is running in the foreground (pid ${record.pid}); press Ctrl-C in its terminal.`);
          return 1;
        }
        say(`No AgentRun started in the background is running.${installed() ? " AgentRun runs as a service here: agentrun service stop stops it." : ""}`);
        return 3;
      }
      // The launcher passes its SIGTERM on to the server it started (the pid in the server's record) and waits for it.
      // The server is waited for too: without setsid the two share no process group of their own, and a SIGKILL to the
      // launcher alone would leave the server running.
      let server;
      try {
        server = JSON.parse(readFileSync(join(root, ".server.json"), "utf8")).pid;
      } catch {}
      const until = async (ms) => {
        const deadline = Date.now() + ms;
        while ([pid, server].some(ours) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200));
        return [pid, server].filter(ours);
      };
      kill(pid, "SIGTERM");
      const running = await until(stopWaitMs);
      if (running.length > 0) {
        // The installer starts it with setsid where there is one, so it leads a process group, the server's too.
        try {
          kill(-pid, "SIGKILL");
        } catch {}
        for (const each of running) {
          try {
            kill(each, "SIGKILL");
          } catch {}
        }
        say(`AgentRun (pid ${running.join(", ")}) was still running ${stopWaitMs / 1000} s after its SIGTERM, so it was sent a SIGKILL.`);
        const still = await until(5_000);
        if (still.length > 0) return say(`AgentRun (pid ${still.join(", ")}) still runs after its SIGKILL; ${file} stays.`), 1;
      }
      rmSync(file, { force: true });
      say(`Stopped AgentRun (pid ${pid}).`);
      return 0;
    },
  };
}

const VERBS = [
  ["install", "Install AgentRun as a service of this user and start it: it keeps running after the terminal closes and starts again at login", [["--port N", "the port to listen on (default: the first free from 7340; 7340 with --tailscale)"], ["--data DIR", "the data directory (default ~/.agentrun)"], ["--tailscale", "also serve it over HTTPS on your own tailnet only (tailscale serve, never Funnel); --no-tailscale takes it off"], ["--env KEY=VALUE", `a local model's variable for the server or where Ollama listens, a start-time switch or the usage counts' switch: ${Object.entries(SERVICE_ENV).map(([name, takes]) => (takes ? `${name} (${takes.join(" or ")})` : name)).join(", ")}; kept until KEY= removes it; repeatable`], ["--public-url URL", "the https address people open it at, through a proxy you run in front of it (your own tailscale serve, a reverse proxy); kept for every restart"]], { port: { type: "string" }, tailscale: { type: "boolean" }, env: { type: "string", multiple: true }, "public-url": { type: "string" } }],
  ["status", "Say whether the service is installed and running, the console's address and its health (exit 0 healthy, 1 not, 3 not installed)", [], {}],
  ["start", "Start the service and wait until it answers", [], {}],
  ["stop", "Stop the service (it starts again at the next login)", [], {}],
  ["restart", "Restart the service and wait until it answers", [], {}],
  ["logs", "Print the service's log, ~/.agentrun/logs/agentrun.log", [["--lines N", "how many of its last lines (default 50)"], ["--follow", "and keep printing what comes (-f)"]], { lines: { type: "string" }, follow: { type: "boolean", short: "f" } }],
  ["upgrade", "Install another version with the installer, then restart the service on it", [["--version V", "the version or npm tag (default: latest)"]], { version: { type: "string" } }],
  ["uninstall", "Stop the service and remove it, and the tailscale serve entry --tailscale added; the data directory stays", [], {}],
];

/** The CLI's entries (cli.mjs LOCAL), one per verb. */
export const SERVICE = VERBS.map(([verb, summary, help, options]) => ({
  command: ["service", verb],
  pathParams: [],
  summary,
  help,
  options,
  run: ({ values, io, env, cli }) => serviceOf({ env, io, fail: cli.fail })[verb](values),
}));

/** `agentrun open` (cli.mjs LOCAL). */
export const OPEN = {
  command: ["open"],
  pathParams: [],
  summary: "Open AgentRun in this machine's browser: the setup page, its code filled in, until the owner's password is set; the console after (where no browser opens, it prints the link)",
  help: [["--data DIR", "the data directory of the AgentRun to open (default ~/.agentrun)"], ["--setup-only", "open nothing once the owner's password is set (the installer's last step)"]],
  options: { "setup-only": { type: "boolean" } },
  run: ({ values, io, env, cli }) => serviceOf({ env, io, fail: cli.fail }).open(values),
};

/** `agentrun stop` (cli.mjs LOCAL). */
export const STOP = {
  command: ["stop"],
  pathParams: [],
  summary: "Stop the AgentRun the installer started in the background, where there is no service manager (exit 0 stopped, 3 none running)",
  help: [],
  options: {},
  run: ({ io, env, cli }) => serviceOf({ env, io, fail: cli.fail }).background(),
};
