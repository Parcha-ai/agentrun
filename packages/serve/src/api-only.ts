// The API-only profile (AGENTRUN_API_ONLY=1): a server that runs behind its caller's backend serves the run routes and a
// deploy's routes alone, and refuses every other address before anything else reads the request: the console at "/" and
// its assets, sign-in and setup, settings but its MCP servers, the MCP endpoint, triggers and their webhook hooks, the
// rest of agents and templates. Off by default.
import type { Route } from "./server.js";
import { LAUNCH_HOOK_SECRET_ENV, LAUNCH_HOOK_URL_ENV } from "./trigger-launch-hook.js";

/** runnable.ts NOT_SET_UP, spelled here: the CLI reads this module before the server loads, so it imports no more. */
const NOT_SET_UP = "not_set_up_here";

/** The variable that turns the profile on. */
export const API_ONLY_ENV = "AGENTRUN_API_ONLY";

/** The routes (server.ts ROUTES, by name) an API-only server serves. Past a run's own, why each group is here:
 *  - a run's hosted machine fetches computerd with the token its create minted, not the server's;
 *  - the computers list and the Archil settings are read before a launch, naming keys, never a value;
 *  - an agent its inline runs made has its disk, its delete and its runs' purges sent by the backend that made it (a run
 *    of an agent made here is refused by the purge's route itself, server.ts deleteRun, in this profile's words);
 *  - a run's computer, take-over, hand-back and viewer link go to the backend, which has no owner's session here;
 *  - a backend reads what its agents learned (loop, promotions, cost per run, a run's learning), cut as the console's,
 *    and resets it (deleteAgentLearning: the agent and its runs kept) when it erases what an agent learned;
 *  - a run's usage lines (what its cost.usd joins, by meter) are a read of that run alone, cut as the run's read is;
 *  - an operator or a scaler reads the runners' capacity (getCapacity, capacity.ts) from the server whose runners run apart;
 *  - a backend that builds runs from the MCP servers saved here reads their names (listMcpServerNames), never a URL or a
 *    credential, to hold back a job whose server isn't saved before its launch is refused for it;
 *  - a backend uploads an agent's package (importTemplate, as {files} alone: a GitHub source is refused in this profile's
 *    words, template-import.ts), which an apply then makes into its agent;
 *  - a backend that deploys agents here applies their template, reads the agent and its revisions, moves its current
 *    revision back, and archives it before its delete (or unarchives it, the schedule and feed triggers its archive
 *    turned off on again when the server has the launch hook): its token already makes agents through inline runs, so it
 *    gains no new power. A trigger the apply can't make here is skipped, and said (apiOnlyTriggerSkipped);
 *  - an API-only server has no owner, so the token is the backend's own, as with take-over: it lists, reads, saves and
 *    deletes the MCP servers its agents need, and never writes a secret (secret-writes.ts). A Composio server names its
 *    key by api_key_env (COMPOSIO_API_KEY, read at each use); any other is a per_run server at an https address, whose
 *    runs each hand their own credential (mcp_auth). It reads each server brief: no credential, no address past its
 *    origin. Previews, refreshes, sign-ins and Composio's triggers stay refused. */
export const API_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "createRun", "createInlineRun", "getComputerDaemon",
  "getRunComputer", "takeOverRunComputer", "handBackRunComputer", "createRunComputerViewer",
  "listComputers", "getWorkspaceArchil",
  "getAgentArchil", "deleteAgentArchil", "deleteAgent", "deleteAgentLearning", "deleteRun",
  "getLearningLoop", "listLearningPromotions", "getLearningCost", "getRunLearning",
  "getRun", "getRunUsage", "listRuns", "listAllRuns", "getTimeline",
  "sendMessage", "stopRun", "cancelRun", "raiseRunCap", "gradeRun",
  "listRunFiles", "readRunFile",
  "createFile", "listFiles", "getFile", "uploadFile", "deleteFile",
  "getCapabilities", "getHealth", "getUsage", "getCapacity", "listMcpServerNames",
  "importTemplate", "applyTemplate", "getAgent", "listRevisions", "setCurrent", "archiveAgent", "unarchiveAgent",
  "listMcpServers", "getMcpServer", "saveComposioServer", "saveMcpServer", "deleteMcpServer",
]);

/** The trigger sources an apply on an API-only server makes once the server has the launch hook: the ones that fire on
 *  its own clock and need nothing a refused route sets up. Each firing goes to the backend in front of it
 *  (trigger-launch-hook.ts), which starts the run through the API on its own keys and budget, never on this server's
 *  model key. A webhook, GitHub or Composio trigger is delivered to a hook this profile refuses, and an email trigger
 *  reads the account Settings → Email saves: none of them is made here, hook or not. */
export const API_ONLY_HOOKED_KINDS: ReadonlySet<string> = new Set(["schedule", "feed"]);

/** Why an apply on an API-only server (and its dry run's plan) does not make `trigger` of the `packageName` template, or
 *  undefined for one it makes: a schedule or a feed when the server has the launch hook (`hooked`). Without it, those two
 *  are not_set_up_here (set the hook and apply again); any other source is not_an_option, hook or not. */
export function apiOnlyTriggerSkipped(packageName: string, trigger: { name?: unknown; source?: unknown }, hooked: boolean): { reason: typeof NOT_SET_UP | "not_an_option"; message: string } | undefined {
  const kind = trigger.source !== null && typeof trigger.source === "object" ? String((trigger.source as { kind?: unknown }).kind) : "";
  const named = `The ${packageName} template's trigger ${String(trigger.name).trim()} (${kind}) was not made: this server serves the run API only (${API_ONLY_ENV}=1)`;
  if (!API_ONLY_HOOKED_KINDS.has(kind)) return { reason: "not_an_option", message: `${named}, which serves no route or setting a ${kind} trigger needs. Start its runs through the API instead.` };
  if (hooked) return undefined;
  return { reason: NOT_SET_UP, message: `${named} and has no launch hook, so its firings have nowhere to go. Start its runs through the API, or set the launch hook (${LAUNCH_HOOK_URL_ENV} and ${LAUNCH_HOOK_SECRET_ENV}) and apply again: each firing then goes to your backend, which starts its run.` };
}

/** Whether `env` turns the profile on: `1` or `true` on; unset, empty, `0` or `false` off. Any other value is refused in
 *  words (a TypeError), so a typo never leaves the console open on a server meant to be API-only. */
export function apiOnlyFrom(env: NodeJS.ProcessEnv = process.env): boolean {
  const given = env[API_ONLY_ENV]?.trim().toLowerCase() ?? "";
  if (given === "1" || given === "true") return true;
  if (given === "" || given === "0" || given === "false") return false;
  throw new TypeError(`${API_ONLY_ENV} is 1 (serve the run API only) or 0 (the whole server), not ${JSON.stringify(env[API_ONLY_ENV])}`);
}

/** A run's computer live view: its page, files and socket, which take the viewer credential alone here (server.ts). */
const COMPUTER_LIVE = /^\/v2\/runs\/[^/]+\/computer\/live\//;

/** Whether an API-only server serves `method` on `raw` (the path as sent, its query cut): a /v2 path one of
 *  API_ONLY_ROUTES matches for that method (HEAD as GET), or a GET of a run's computer live view. */
export function servedApiOnly(routes: readonly Route[], method: string | undefined, raw: string): boolean {
  if (!raw.startsWith("/v2/")) return false;
  const path = raw.slice(3);
  const asked = method === "HEAD" ? "GET" : method;
  if (asked === "GET" && COMPUTER_LIVE.test(raw)) return true;
  return routes.some((route) => API_ONLY_ROUTES.has(route.name) && route.method === asked && route.pattern.test(path));
}

/** The refusal's words for `raw` on an API-only server. */
export const apiOnlyRefusal = (raw: string): string => `this server serves the run API only (${API_ONLY_ENV}=1): ${raw} is not served here`;
