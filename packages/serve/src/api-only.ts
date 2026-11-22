// The API-only profile (AGENTRUN_API_ONLY=1): a server that runs behind its caller's backend serves the run routes and a
// deploy's routes alone, and refuses every other address before anything else reads the request: the console at "/" and
// its assets, sign-in and setup, settings, MCP, triggers and their webhook hooks, the rest of agents and templates.
// Off by default.
import type { Route } from "./server.js";

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
 *  - a backend uploads an agent's package (importTemplate, as {files} alone: a GitHub source is refused in this profile's
 *    words, template-import.ts), which an apply then makes into its agent;
 *  - a backend that deploys agents here applies their template, reads the agent and its revisions, moves its current
 *    revision back, and archives it before its delete (or unarchives it): its token already makes agents through inline
 *    runs, so it gains no new power. The apply makes no trigger, each skipped and said (apiOnlyTriggerSkipped). */
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
  "getCapabilities", "getHealth", "getUsage", "getCapacity",
  "importTemplate", "applyTemplate", "getAgent", "listRevisions", "setCurrent", "archiveAgent", "unarchiveAgent",
]);

/** What an apply on an API-only server (and its dry run's plan) says of `trigger` of the `packageName` template, which it
 *  does not make. It makes none, of any source: a run here starts through the backend in front of it, on that backend's
 *  keys and budget, never on this server's own clock or model key (a schedule's or a feed's), nor from a hook or a
 *  setting the profile refuses (a webhook's, GitHub's, Composio's, the email account's). */
export function apiOnlyTriggerSkipped(packageName: string, trigger: { name?: unknown; source?: unknown }): string {
  const kind = trigger.source !== null && typeof trigger.source === "object" ? String((trigger.source as { kind?: unknown }).kind) : "";
  return `The ${packageName} template's trigger ${String(trigger.name).trim()} (${kind}) was not made: this server serves the run API only (${API_ONLY_ENV}=1), so a run starts here through the API alone, never on a trigger. Start its runs through the API instead.`;
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
