// `--tailscale` (install.sh, `agentrun service install`): AgentRun on the person's own tailnet, over HTTPS at this
// machine's MagicDNS name, through `tailscale serve` in front of the server on loopback. Never Funnel: a serve entry with
// Funnel on is refused by name and left as it is. Tailscale itself is never installed, logged in or given sudo here;
// what it lacks is said as steps, and AgentRun runs on this machine meanwhile. The entry added is recorded in
// ~/.agentrun/tailscale.json, so `off` removes that entry and no other serve setting.
//
// Run as a script, it is the installer's step where AgentRun runs in the background (no service manager):
//   node tailscale.mjs address PORT AGAIN      prints the https address to start the server with, or nothing
//   node tailscale.mjs serve PORT AGAIN URL    serves the loopback PORT at URL, the address printed, and says where
//   node tailscale.mjs off                     removes the entry it added
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The port AgentRun is served on when --tailscale names none: fixed, so the serve entry and the server agree after a
 *  restart, where "the first free port" could land on another of this machine's services. */
export const TAILNET_PORT = "7340";
export const PRICE = "Tailscale's Personal plan is free: up to 6 users, unlimited user devices (https://tailscale.com/pricing).";
const MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const DENIED = /Access denied/i;

/** The proxy target of the server on `port`. */
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule serve proxies to the server on this machine
export const targetOf = (port) => `http://${LOOPBACK}:${port}`;

/** Tailscale on this machine, driven through `exec` (spawnSync's shape); `again` is the command that runs this step again. */
export function tailnetOf({ platform = process.platform, root = join(homedir(), ".agentrun"), uid = process.getuid?.(), exec, say, fail, again }) {
  // The Mac app's CLI is in the app, and on PATH only when someone put it there.
  let bin;
  const run = (args, options) => {
    bin ??= platform === "darwin" && exec("tailscale", ["version"]).error?.code === "ENOENT" && existsSync(MAC_APP) ? MAC_APP : "tailscale";
    return exec(bin, args, options);
  };
  const state = join(root, "tailscale.json");
  const json = (result) => {
    try {
      return JSON.parse(result.stdout?.trim() || "{}");
    } catch {
      return undefined;
    }
  };
  const errorOf = (result) => `${result.error?.message ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0];
  const up = platform === "darwin" ? "open the Tailscale app and log in" : uid === 0 ? "tailscale up" : "sudo tailscale up --operator=$USER";
  const steps = (why, ...todo) => {
    say(`${why}, so AgentRun is on this machine only for now. To open it from your phone and laptop, on your tailnet only:`);
    todo.forEach((step, i) => say(`  ${i + 1}. ${step}`));
    say(`Then run again: ${again}`);
    say(PRICE);
  };
  const operator = () => {
    say("Tailscale on Linux lets only root or its operator change what it serves. Run once:");
    say("  sudo tailscale set --operator=$USER");
    say(`Then run again: ${again}`);
  };
  const serveConfig = () => {
    const result = run(["serve", "status", "--json"]);
    if (result.status !== 0) return { denied: DENIED.test(result.stderr ?? ""), error: errorOf(result) };
    return { config: json(result) ?? {} };
  };
  const recorded = () => {
    try {
      return JSON.parse(readFileSync(state, "utf8"));
    } catch {
      return undefined;
    }
  };
  const handlerOf = (config, host) => config.Web?.[`${host}:443`]?.Handlers?.["/"];

  return {
    state,
    recorded,
    /** The https address to serve AgentRun at, its server to be `target`: `{ host, url }`, or undefined once what Tailscale
     *  lacks is said. Throws, changing nothing, when Funnel is on there or another service has it. */
    address(target) {
      const status = run(["status", "--json"]);
      if (status.error?.code === "ENOENT") {
        const link = platform === "darwin" ? "https://tailscale.com/download/mac" : "https://tailscale.com/download/linux";
        return steps("Tailscale is not installed here", `Install Tailscale: ${link}`, `Connect this machine to your tailnet: ${up}`);
      }
      const st = status.status === 0 ? json(status) : undefined;
      if (st === undefined) {
        const start = platform === "darwin" ? "open the Tailscale app" : "sudo systemctl enable --now tailscaled";
        return steps(`Tailscale is installed but not running (${errorOf(status) || "no status"})`, `Start it: ${start}`, `Connect this machine to your tailnet: ${up}`);
      }
      if (st.BackendState !== "Running") return steps(`Tailscale is installed but this machine is not on a tailnet (${st.BackendState ?? "no state"})`, `Connect it: ${up}`);
      const host = (st.Self?.DNSName ?? "").replace(/\.$/, "");
      if (!host || !(st.CertDomains ?? []).includes(host)) {
        return steps(`tailscale serve needs an HTTPS certificate, and your tailnet gives none to this machine${host ? ` (${host})` : ""}`, "Turn on MagicDNS and HTTPS Certificates: https://login.tailscale.com/admin/dns");
      }
      const { config, denied, error } = serveConfig();
      if (denied) return operator();
      if (config === undefined) throw fail(1, `tailscale serve status failed: ${error}.`);
      if (config.AllowFunnel?.[`${host}:443`]) {
        throw fail(1, `Tailscale Funnel is on for https://${host}/ (tailscale funnel status), which puts it on the public internet. AgentRun is served on your tailnet only, so nothing was changed. Turn that Funnel off, then run again: ${again}`);
      }
      const handler = handlerOf(config, host);
      const tcp = config.TCP?.["443"];
      const ours = [target, recorded()?.proxy].filter(Boolean);
      if ((handler && !ours.includes(handler.Proxy)) || (tcp && !tcp.HTTPS)) {
        const what = handler ? handler.Proxy ?? handler.Path ?? "text" : tcp.TCPForward;
        throw fail(1, `https://${host}/ already serves ${what} on your tailnet (tailscale serve status), so AgentRun left it as it is and changed nothing. Free it, then run again: ${again}`);
      }
      return { host, url: `https://${host}/` };
    },
    /** Serves the server on `port` at `host`'s https address; false once what stops it is said (operator rights). */
    serve(port, host) {
      const target = targetOf(port);
      // Tailscale's own words (a link to turn something on, say) go to the terminal as it writes them.
      const result = run(["serve", "--bg", "--https=443", target], { stdio: ["ignore", "inherit", "pipe"] });
      if (result.status !== 0) {
        if (DENIED.test(result.stderr ?? "")) return operator(), false;
        throw fail(1, `tailscale serve --bg --https=443 ${target} failed: ${errorOf(result)}.`);
      }
      const { config } = serveConfig();
      if (handlerOf(config ?? {}, host)?.Proxy !== target) throw fail(1, `tailscale serve did not serve ${target} at https://${host}/ (tailscale serve status shows what it serves).`);
      writeFileSync(state, `${JSON.stringify({ url: `https://${host}/`, proxy: target })}\n`, { mode: 0o600 });
      say(`AgentRun is on your tailnet at https://${host}/ (tailscale serve): only your devices on your tailnet open it; nothing is on the public internet.`);
      say(`It asks for a setup code on the first visit: the newest "Set up this server" line in ${join(root, "logs", "agentrun.log")} has the link.`);
      say(PRICE);
      return true;
    },
    /** Removes the serve entry this added, when it is still the one there; never another. */
    off() {
      const had = recorded();
      if (!had) return;
      const host = URL.canParse(had.url) ? new URL(had.url).hostname : "";
      const { config, denied } = serveConfig();
      if (denied) return operator();
      if (config !== undefined && handlerOf(config, host)?.Proxy === had.proxy) {
        const result = run(["serve", "--https=443", "off"]);
        if (result.status !== 0) {
          if (DENIED.test(result.stderr ?? "")) return operator();
          throw fail(1, `tailscale serve --https=443 off failed: ${errorOf(result)}.`);
        }
        say(`Removed AgentRun from your tailnet (tailscale serve --https=443 off): https://${host}/ serves nothing now.`);
      }
      rmSync(state, { force: true });
    },
  };
}

/** The installer's step for an AgentRun in the background. Exit 1 on a refusal, said on stderr. */
function script([verb, port, again, url]) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  // `address` prints the address alone on stdout, for the installer to read; what it says goes to stderr.
  const say = (line) => (verb === "address" ? process.stderr : process.stdout).write(`${line}\n`);
  const exec = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });
  const tailnet = tailnetOf({ exec, say, fail, again });
  try {
    if (verb === "address") {
      const at = tailnet.address(targetOf(port));
      if (at) process.stdout.write(`${at.url}\n`);
    } else if (verb === "serve") tailnet.serve(port, new URL(url).hostname);
    else if (verb === "off") tailnet.off();
    else throw fail(2, `tailscale.mjs takes address, serve or off, not ${verb}`);
    return 0;
  } catch (error) {
    process.stderr.write(`agentrun: ${error.message}\n`);
    return error.code ?? 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = script(process.argv.slice(2));
