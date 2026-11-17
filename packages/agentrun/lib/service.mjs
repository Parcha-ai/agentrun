// `agentrun service install|status|start|stop|restart|logs|upgrade|uninstall`: AgentRun as a service of this user, so it
// keeps running after the terminal closes and starts again at login. A launchd LaunchAgent on macOS, a systemd --user
// unit on Linux; never a system service, never sudo. The service runs the installer's command (~/.agentrun/bin/agentrun,
// install.sh), which brings its own Node, with --no-open and the interactive launcher's rules for the data directory and
// port, and writes to ~/.agentrun/logs/agentrun.log. `agentrun stop` stops the AgentRun the installer starts in the
// background where there is no service manager (a container): its pid is in ~/.agentrun/agentrun.pid.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LABEL = "ai.agentrun.server";
export const UNIT = "agentrun.service";
export const INSTALL_COMMAND = "curl -fsSL https://agentrun.ai/install | sh";
/** How long a start waits for the server to answer /health before it says it did not. */
export const HEALTH_WAIT_MS = 90_000;
/** How long `agentrun stop` waits for the background AgentRun to end after its SIGTERM before it sends a SIGKILL. */
export const STOP_WAIT_MS = 20_000;
const INSTALLER = fileURLToPath(new URL("../install.sh", import.meta.url));

const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unxml = (text) => text.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/** The LaunchAgent: started at login (RunAtLoad), started again when it exits with a failure (KeepAlive), its output in
 *  `log`, with the PATH of the shell that installed it (launchd's own has no Homebrew, so no docker). */
export function plistText({ program, args, path, log }) {
  const strings = [program, ...args].map((arg) => `    <string>${xml(arg)}</string>`).join("\n");
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
    <key>PATH</key>
    <string>${xml(path)}</string>
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
 *  fails, its output appended to `log`, with the PATH of the shell that installed it. */
export function unitText({ program, args, path, log }) {
  return `[Unit]
Description=AgentRun, an open-source platform for your agents
After=network-online.target

[Service]
ExecStart=${[program, ...args].map(systemdWord).join(" ")}
Environment=${systemdWord(`PATH=${path}`)}
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
    return { url, health: response.ok && body?.status === "ok" ? "ok" : `${response.status} ${body?.status ?? ""}`.trim(), checks: body?.checks };
  } catch (error) {
    return { url, health: `not answering (${error?.cause?.code ?? error?.name})` };
  }
}

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
export function serviceOf({ platform = process.platform, home = homedir(), uid = process.getuid?.(), user = userInfo().username, env = process.env, exec, io, fail, get = fetch, waitMs = HEALTH_WAIT_MS, kill = process.kill.bind(process), stopWaitMs = STOP_WAIT_MS }) {
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

  /** Waits for the server started at `since` to answer /health ok, then says where it is; exit 0, or 1 with the log's
   *  last lines. */
  async function started(since, data) {
    const deadline = Date.now() + waitMs;
    let last = {};
    while (Date.now() < deadline) {
      last = await healthOf(data, { fetch: get, since });
      if (last.health === "ok") {
        say(`AgentRun is running at ${last.url} (${manager.name}).`);
        say(`Logs: ${log}`);
        for (const note of manager.notes()) say(note);
        return 0;
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    const lines = tailOf(log, 20);
    io.stderr.write(`AgentRun's service did not answer /health ok within ${waitMs / 1000} s${last.health ? ` (${last.health})` : ""}. Its state: ${manager.state().words}.\n`);
    if (lines.length) io.stderr.write(`The last lines of ${log}:\n${lines.map((line) => `  ${line}`).join("\n")}\n`);
    return 1;
  }

  return {
    async install({ data, port }) {
      if (port !== undefined && !/^\d+$/.test(port)) throw fail(2, `--port takes a port number, not ${port}.`);
      need();
      if (!existsSync(program)) throw fail(1, `AgentRun's service runs the installed command, ${program}, and it is not there. Install it first: ${INSTALL_COMMAND}`);
      const why = manager.available();
      if (why !== undefined) throw fail(1, `AgentRun can't run as a service here: ${why}. Start it in a terminal with ${program}.`);
      const args = ["--no-open", ...(data !== undefined ? ["--data", resolve(data)] : []), ...(port !== undefined ? ["--port", port] : [])];
      mkdirSync(join(root, "logs"), { recursive: true, mode: 0o700 });
      mkdirSync(join(manager.file, ".."), { recursive: true });
      writeFileSync(manager.file, manager.text({ program, args, path: env.PATH ?? "/usr/bin:/bin", log }));
      const since = Date.now();
      manager.install();
      say(`Installed AgentRun's service (${manager.file}): it keeps running after this terminal closes, and starts again at login.`);
      return started(since, dataOf(args, home));
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
      if (!installed()) return say("AgentRun's service is not installed."), 0;
      manager.remove();
      unlinkSync(manager.file);
      manager.removed?.();
      say(`Removed AgentRun's service (${manager.file}). Its data stays in ${root}.`);
      return 0;
    },
    /** `agentrun stop`: the AgentRun install.sh started in the background, stopped as Ctrl-C would (SIGTERM, which the
     *  launcher passes on to the server), then SIGKILL past stopWaitMs. Exit 0, or 3 when none is running. */
    async background() {
      const file = join(root, "agentrun.pid");
      let pid;
      try {
        pid = Number(readFileSync(file, "utf8").trim());
      } catch {}
      // Its state letter and command line: from /proc where there is one (a container may have no ps), else from ps.
      // Undefined once it is gone. A process that ended is a zombie (Z) until its parent reaps it, and in a container
      // with no init nothing does, so a zombie counts as ended.
      const processOf = () => {
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          return { state: stat.slice(stat.lastIndexOf(")") + 2)[0], args: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ") };
        } catch {
          if (existsSync("/proc/self/stat")) return undefined;
        }
        const ps = exec("ps", ["-o", "stat=", "-o", "args=", "-p", String(pid)]);
        const [, state, args] = (ps.status === 0 && /^\s*(\S)\S*\s+(.*)$/s.exec(ps.stdout ?? "")) || [];
        return state === undefined ? undefined : { state, args };
      };
      const alive = () => {
        const now = processOf();
        return now !== undefined && now.state !== "Z";
      };
      // A pid file outlives a crash, and its pid can be another process's by now: only a process running this install's
      // files is stopped.
      const ours = Number.isInteger(pid) && pid > 1 && alive() && processOf()?.args.includes(`${root}/`);
      if (!ours) {
        rmSync(file, { force: true });
        say(`No AgentRun started in the background is running.${installed() ? " AgentRun runs as a service here: agentrun service stop stops it." : ""}`);
        return 3;
      }
      kill(pid, "SIGTERM");
      const deadline = Date.now() + stopWaitMs;
      while (alive() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 200));
      if (alive()) {
        // The installer starts it with setsid, so it leads a process group, the server's too.
        try {
          kill(-pid, "SIGKILL");
        } catch {
          kill(pid, "SIGKILL");
        }
        say(`AgentRun (pid ${pid}) was still running ${stopWaitMs / 1000} s after its SIGTERM, so it was sent a SIGKILL.`);
      }
      rmSync(file, { force: true });
      say(`Stopped AgentRun (pid ${pid}).`);
      return 0;
    },
  };
}

const VERBS = [
  ["install", "Install AgentRun as a service of this user and start it: it keeps running after the terminal closes and starts again at login", [["--port N", "the port to listen on (default: the first free from 7340)"], ["--data DIR", "the data directory (default ~/.agentrun)"]], { port: { type: "string" } }],
  ["status", "Say whether the service is installed and running, the console's address and its health (exit 0 healthy, 1 not, 3 not installed)", [], {}],
  ["start", "Start the service and wait until it answers", [], {}],
  ["stop", "Stop the service (it starts again at the next login)", [], {}],
  ["restart", "Restart the service and wait until it answers", [], {}],
  ["logs", "Print the service's log, ~/.agentrun/logs/agentrun.log", [["--lines N", "how many of its last lines (default 50)"], ["--follow", "and keep printing what comes (-f)"]], { lines: { type: "string" }, follow: { type: "boolean", short: "f" } }],
  ["upgrade", "Install another version with the installer, then restart the service on it", [["--version V", "the version or npm tag (default: latest)"]], { version: { type: "string" } }],
  ["uninstall", "Stop the service and remove it; the data directory stays", [], {}],
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

/** `agentrun stop` (cli.mjs LOCAL). */
export const STOP = {
  command: ["stop"],
  pathParams: [],
  summary: "Stop the AgentRun the installer started in the background, where there is no service manager (exit 0 stopped, 3 none running)",
  help: [],
  options: {},
  run: ({ io, env, cli }) => serviceOf({ env, io, fail: cli.fail }).background(),
};
