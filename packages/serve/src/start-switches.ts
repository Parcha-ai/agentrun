// The switches only the server's operator sets, in its environment at its start: never the API's nor the console's, so no
// caller of the API can widen what the server reaches. GET /v2/capabilities lists them (`switches`), and a refusal one of
// them causes names it, the value that allows it and the restart it takes (restartWith).

import { BOX_ALLOW_ENV, boxAllowOf, boxAllowSetIn } from "./box-settings.js";
import { API_ONLY_MCP_ORIGINS_ENV } from "./env-switch.js";
import { PRIVATE_HOSTS_ENV, privateHostsSwitchValue } from "./mcp-private-hosts.js";

/** The env that says this server is a local install (cli.ts), the one kind an MCP server may be on loopback for. */
export const MCP_ALLOW_LOOPBACK_ENV = "AGENTRUN_MCP_ALLOW_LOOPBACK";
/** The env that lets the outbound webhook send to a private network or this machine. */
export const WEBHOOK_PRIVATE_TARGETS_ENV = "AGENTRUN_WEBHOOK_PRIVATE_TARGETS";
/** A Docker computer's size (workspace/computer-deps.ts dockerLimitsOf, which reads them by these names). */
export const BOX_CPUS_ENV = "AGENTRUN_BOX_CPUS";
export const BOX_MEMORY_ENV = "AGENTRUN_BOX_MEMORY";
export const BOX_PIDS_ENV = "AGENTRUN_BOX_PIDS";
/** How many connections a Docker computer's egress proxy holds open at once (workspace/computer-deps.ts boxMaxTunnelsOf). */
export const BOX_MAX_TUNNELS_ENV = "AGENTRUN_BOX_MAX_TUNNELS";

/** Where a switch that opens this machine to every caller of the API is for. */
export const ALONE_WORDS = "only on a machine you alone use";
/** The words that lift a refusal a switch causes: the server reads it only at its start. */
export const restartWith = (setting: string): string => `restart the server with ${setting}`;
/** A yes-or-no switch's words: `name`=1 allows it, at a restart, on a machine its user alone uses. */
export const restartToAllow = (name: string): string => `${restartWith(`${name}=1`)} to allow it, ${ALONE_WORDS}`;

/** One switch as capabilities list it: `on`, whether the operator set it (a yes-or-no one, to 1); `value`, what the server
 *  read (a host list, `none` or a size), null when unset or withheld; `allows`, what it allows, in an operator's words. */
export type StartSwitch = { on: boolean; value: string | null; allows: string };

/** The switches as this server was started: from `env`, but for those the server takes as options (ServeOptions
 *  mcpLoopback and webhookPrivateTargets, which the CLI sets from their variables, and the API-only profile's MCP origins
 *  as the server holds them, `apiOnlyMcpOrigins`). Never a secret: each is a yes or no, a host list or a size. */
export function startSwitches(env: NodeJS.ProcessEnv, { mcpLoopback, webhookPrivateTargets, apiOnlyMcpOrigins = [] }: { mcpLoopback: boolean; webhookPrivateTargets: boolean; apiOnlyMcpOrigins?: readonly string[] }): Record<string, StartSwitch> {
  const flag = (on: boolean, allows: string): StartSwitch => ({ on, value: on ? "1" : null, allows });
  const allow = boxAllowOf(env);
  const size = (name: string, allows: string): StartSwitch => {
    const value = env[name]?.trim() || null;
    return { on: value !== null, value, allows };
  };
  return {
    [MCP_ALLOW_LOOPBACK_ENV]: flag(mcpLoopback, `An MCP server on this machine's loopback (127.0.0.1, localhost), for every caller of this server's API: ${ALONE_WORDS}.`),
    [WEBHOOK_PRIVATE_TARGETS_ENV]: flag(webhookPrivateTargets, `The outbound webhook (Settings → Webhook) sending to a private network or this machine, which any caller who may set it then reaches: ${ALONE_WORDS}.`),
    [PRIVATE_HOSTS_ENV]: ((value) => ({ on: value !== null, value, allows: "The private-network hosts an owner may allow an MCP server or a calendar on (Settings → MCP servers): unset, the owner's list; none, no private host at all (set it on a server or runner many customers share); or a comma list of address ranges every listed host's address must also fall in. Set it on the server and on each runner: each process holds to its own." }))(privateHostsSwitchValue(env)),
    [BOX_ALLOW_ENV]: { on: boxAllowSetIn(env), value: boxAllowSetIn(env) ? (allow === "none" ? "none" : allow.join(",")) : null, allows: "The hosts a run's computer may reach: a comma list of host names, or none for no network. Unset, the package registries and GitHub (capabilities' places.allow)." },
    [BOX_CPUS_ENV]: size(BOX_CPUS_ENV, "A Docker computer's CPUs, such as 2 or 1.5. Unset, the Docker provider's default."),
    [BOX_MEMORY_ENV]: size(BOX_MEMORY_ENV, "A Docker computer's memory, swap included, such as 512m or 4g. Unset, the Docker provider's default."),
    [BOX_PIDS_ENV]: size(BOX_PIDS_ENV, "How many processes and threads a Docker computer may hold at once, such as 1024. Unset, the Docker provider's default."),
    [BOX_MAX_TUNNELS_ENV]: size(BOX_MAX_TUNNELS_ENV, "How many connections a Docker computer's egress proxy holds open at once, from 1 to 256, such as 128; past that a new one is refused with 429. Unset, the proxy's default, 64."),
    // Its origins are withheld: every caller of an API-only server is its token, which learns only whether an origin it
    // saves at is listed (the save's 404 or not). A full server holds no list: off.
    [API_ONLY_MCP_ORIGINS_ENV]: { on: apiOnlyMcpOrigins.length > 0, value: null, allows: "On an API-only server (AGENTRUN_API_ONLY=1), the exact origins (scheme, host and port) its token may save a per_run MCP server at, which keeps no credential: a comma list of https origins, or http ones for a loopback host alone (127.0.0.0/8, ::1, localhost), which also needs AGENTRUN_MCP_ALLOW_LOOPBACK=1. Unset, none. The server keeps the list it started with in its store, and each run's claim of a server the token saved checks it. The list itself is never shown here." },
  };
}
