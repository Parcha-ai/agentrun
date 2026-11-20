// The API-only profile (AGENTRUN_API_ONLY=1): a server that runs behind its caller's backend serves the run routes alone
// and refuses every other address before anything else reads the request: the console at "/" and its assets, sign-in
// and setup, settings, MCP, triggers and their webhook hooks, agents, templates and the rest. Off by default.
import type { Route } from "./server.js";

/** The variable that turns the profile on. */
export const API_ONLY_ENV = "AGENTRUN_API_ONLY";

/** The routes (server.ts ROUTES, by name) an API-only server serves. Past a run's own, why each group is here:
 *  - a run's hosted machine fetches computerd with the token its create minted, not the server's;
 *  - the computers list and the Archil settings are read before a launch, naming keys, never a value;
 *  - an agent its inline runs made has its disk and its delete sent by the backend that made it;
 *  - a run's computer, take-over, hand-back and viewer link go to the backend, which has no owner's session here;
 *  - a backend reads what its agents learned (loop, promotions, cost per run, a run's learning), cut as the console's;
 *  - an operator or a scaler reads the runners' capacity (getCapacity, capacity.ts) from the server whose runners run apart. */
export const API_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "createRun", "createInlineRun", "getComputerDaemon",
  "getRunComputer", "takeOverRunComputer", "handBackRunComputer", "createRunComputerViewer",
  "listComputers", "getWorkspaceArchil",
  "getAgentArchil", "deleteAgentArchil", "deleteAgent",
  "getLearningLoop", "listLearningPromotions", "getLearningCost", "getRunLearning",
  "getRun", "listRuns", "listAllRuns", "getTimeline",
  "sendMessage", "stopRun", "cancelRun", "raiseRunCap", "gradeRun",
  "listRunFiles", "readRunFile",
  "createFile", "listFiles", "getFile", "uploadFile", "deleteFile",
  "getCapabilities", "getHealth", "getUsage", "getCapacity",
]);

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
