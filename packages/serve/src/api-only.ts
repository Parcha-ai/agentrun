// The API-only profile (AGENTRUN_API_ONLY=1): a server that runs behind its caller's backend serves the run routes alone
// and refuses every other address before anything else reads the request: the console at "/" and its assets, sign-in
// and setup, settings, MCP, triggers and their webhook hooks, agents, templates and the rest. Off by default.
import type { Route } from "./server.js";

/** The variable that turns the profile on. */
export const API_ONLY_ENV = "AGENTRUN_API_ONLY";

/** The routes (server.ts ROUTES, by name) an API-only server serves: a run's launch, read, list, timeline, messages,
 *  stop, cancel, cap raise and grade; its files and the uploads a launch names; an agent's Archil disk, read and removed (the
 *  agent layer of a run's disk, archil-routes.ts); the delete of an agent its inline runs made (agent-delete.ts), which
 *  the backend that made it is the one to send; capabilities, health and usage; the two reads of the computer settings a
 *  backend checks before it launches, each by the token and naming keys and whether each is saved, never a value: the
 *  computer providers and whether each is ready (GET /computers, computers.ts) and the Archil settings, whether runs'
 *  folders are on Archil (GET /workspace/archil, archil-routes.ts), while their writes, tests and key choices stay the
 *  console's; and a run's hosted machine that dials fetching this server's computerd with its own token
 *  (computer-attach.ts), as it dials the attach socket, which the upgrade takes for such a machine alone (a paired
 *  computer is the console's). */
export const API_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "createRun", "createInlineRun", "getComputerDaemon",
  "listComputers", "getWorkspaceArchil",
  "getAgentArchil", "deleteAgentArchil", "deleteAgent",
  "getRun", "listRuns", "listAllRuns", "getTimeline",
  "sendMessage", "stopRun", "cancelRun", "raiseRunCap", "gradeRun",
  "listRunFiles", "readRunFile",
  "createFile", "listFiles", "getFile", "uploadFile", "deleteFile",
  "getCapabilities", "getHealth", "getUsage",
]);

/** Whether `env` turns the profile on: `1` or `true` on; unset, empty, `0` or `false` off. Any other value is refused in
 *  words (a TypeError), so a typo never leaves the console open on a server meant to be API-only. */
export function apiOnlyFrom(env: NodeJS.ProcessEnv = process.env): boolean {
  const given = env[API_ONLY_ENV]?.trim().toLowerCase() ?? "";
  if (given === "1" || given === "true") return true;
  if (given === "" || given === "0" || given === "false") return false;
  throw new TypeError(`${API_ONLY_ENV} is 1 (serve the run API only) or 0 (the whole server), not ${JSON.stringify(env[API_ONLY_ENV])}`);
}

/** Whether an API-only server serves `method` on `raw` (the path as sent, its query cut): a /v2 path one of
 *  API_ONLY_ROUTES matches for that method (HEAD as GET). */
export function servedApiOnly(routes: readonly Route[], method: string | undefined, raw: string): boolean {
  if (!raw.startsWith("/v2/")) return false;
  const path = raw.slice(3);
  const asked = method === "HEAD" ? "GET" : method;
  return routes.some((route) => API_ONLY_ROUTES.has(route.name) && route.method === asked && route.pattern.test(path));
}

/** The refusal's words for `raw` on an API-only server. */
export const apiOnlyRefusal = (raw: string): string => `this server serves the run API only (${API_ONLY_ENV}=1): ${raw} is not served here`;
