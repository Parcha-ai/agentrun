// The API-only profile (AGENTRUN_API_ONLY=1): a server that runs behind its caller's backend serves the run routes and a
// deploy's routes alone, and refuses every other address before anything else reads the request: the console at "/" and
// its assets, sign-in and setup, settings but the MCP servers' names, a Composio server's save and the delete of a server
// (the secret-write gate lets the token save over or delete only a server it saved, mcp-secret-writes.ts), the MCP
// endpoint, triggers but their reads, their turn on or off (apiOnlyTriggerEdit) and a firing's release (which the launch
// hook's host sends), their webhook hooks, the rest of agents and templates. Off by default.
import { API_ONLY_ENV } from "./env-switch.js";
import type { InputIssue } from "./errors.js";
import { NOT_SET_UP } from "./runnable.js";
import type { Route } from "./server.js";
import { LAUNCH_HOOK_SECRET_ENV, LAUNCH_HOOK_URL_ENV } from "./trigger-launch-hook.js";

/** The routes (server.ts ROUTES, by name) an API-only server serves. Past a run's own, why each group is here:
 *  - a run's hosted machine fetches computerd with the token its create minted, not the server's;
 *  - the computers list and the Archil settings are read before a launch, naming keys, never a value;
 *  - an agent its inline runs made has its disk, its delete and its runs' purges sent by the backend that made it. A run
 *    of an agent made here is purged too (deleteRun): the token may archive and delete that whole agent below, every
 *    run of it purged, so one run of it is no more;
 *  - a run's computer, take-over, hand-back and viewer link go to the backend, which has no owner's session here;
 *  - a backend reads what its agents learned (loop, promotions, audits, cost per run, a run's learning), cut as the
 *    console's, and resets it (deleteAgentLearning: the agent and its runs kept) when it erases what an agent learned;
 *  - a run's usage lines (what its cost.usd joins, by meter) are a read of that run alone, cut as the run's read is;
 *  - a backend shares a run it ran (getRunExport, run-export.ts): an ended run's agentrun.share/1 bundle, every string
 *    cut by the scrubber as on the full server, its ?restore= a stateless re-export of cuts a preview may restore. A
 *    workflow run's bundle carries its graph, cut, though getRunGraph stays refused here; the share page (/share/{run})
 *    is the console's, refused with the rest of it;
 *  - an operator or a scaler reads the runners' capacity (getCapacity, capacity.ts) from the server whose runners run apart;
 *  - a backend reads the saved MCP servers' names (listMcpServerNames), never a URL or a credential;
 *  - a backend reads the prices this server meters computer and browser time at (getPrices, prices.ts), to bound a run's
 *    budget in this server's figures before its launch: decimal prices and their source, never a key or an address;
 *  - a backend uploads an agent's package (importTemplate, as {files} alone: a GitHub source is refused in this profile's
 *    words, template-import.ts), which an apply then makes into its agent;
 *  - a backend that deploys agents here applies their template, reads the agent and its revisions, moves its current
 *    revision back, and archives it before its delete (or unarchives it, the schedule and feed triggers its archive
 *    turned off on again when the server has the launch hook). That is more than inline runs give its token: it makes
 *    agents and revisions that stay, archives and deletes any agent made here and purges any run of one, as the whole
 *    server's token does, and with the launch hook its apply makes schedule and feed triggers. A trigger the apply can't
 *    make here is skipped, and said (apiOnlyTriggerSkipped). One the agent had before the profile stays as it was:
 *    without the hook, an enabled one still fires here on this server's keys until it is turned off (below) or the agent
 *    is archived;
 *  - a backend reads the triggers (their list, one, its firings) and turns one on or off (updateTrigger, `enabled` alone:
 *    apiOnlyTriggerEdit), since a trigger whose firings failed FAILURES_TO_PAUSE times in a row turns itself off and
 *    there is no console here to turn it on in. It turns one on under the apply's rule: a schedule or a feed, with the
 *    launch hook. Making, deleting, firing a trigger and its secret stay refused;
 *  - an API-only server has no owner, so the token is the backend's own, as with take-over: it saves the Composio servers
 *    its agents need through the preset (saveComposioServer), saves over or deletes only a server it saved
 *    (mcp-secret-writes.ts tokenWriteOverRefused), and never writes a secret (secret-writes.ts). A Composio server names
 *    its key by api_key_env (COMPOSIO_API_KEY, on the launcher's list of secrets, read at each use through secrets.ts
 *    secret, sent to Composio's origin alone: composio-made.ts composioEnvKey), and its body names no address or headers.
 *    There is no list or read of the servers here (listMcpServerNames above is the listing). The generic save
 *    (saveMcpServer) is apiOnlyMcpSave: the serve README's API-only section states it. Previews, refreshes, sign-ins
 *    and Composio's triggers stay refused;
 *  - the launch hook's host (the backend in front of this server) releases a firing it took and will start no run for
 *    (releaseTriggerFiring, triggers.ts release), so its trigger's room frees at once; with no launch hook the route is
 *    the route's own 422. */
export const API_ONLY_ROUTES: ReadonlySet<string> = new Set([
  "createRun", "createInlineRun", "getComputerDaemon",
  "getRunComputer", "takeOverRunComputer", "handBackRunComputer", "createRunComputerViewer",
  "listComputers", "listRunningComputers", "getWorkspaceArchil",
  "getAgentArchil", "deleteAgentArchil", "deleteAgent", "deleteAgentLearning", "deleteRun",
  "getLearningLoop", "listLearningPromotions", "listLearningAudits", "getLearningCost", "getRunLearning",
  "getRun", "getRunUsage", "listRuns", "listAllRuns", "getTimeline",
  "sendMessage", "stopRun", "cancelRun", "raiseRunCap", "gradeRun",
  "listRunFiles", "readRunFile", "getRunExport",
  "createFile", "listFiles", "getFile", "uploadFile", "deleteFile",
  "getCapabilities", "getHealth", "getUsage", "getCapacity", "listMcpServerNames", "getPrices",
  "importTemplate", "applyTemplate", "getAgent", "listRevisions", "setCurrent", "archiveAgent", "unarchiveAgent",
  "saveComposioServer", "deleteMcpServer", "releaseTriggerFiring",
  "listTriggers", "getTrigger", "listTriggerFirings", "updateTrigger",
  // Refused in its own words (403): it reads the machine's session files, which a server behind a backend does not have to give.
  "getWrapped",
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

/** Whether an API-only server turns on a trigger whose source is `kind` and whose target is `target` (its PATCH, its
 *  agent's unarchive): only one the apply would make, a source of API_ONLY_HOOKED_KINDS aimed at an agent (start_run),
 *  with the launch hook `hooked`, so each firing goes to the backend. A message_run firing never goes to the hook
 *  (triggers.ts): on, it would open its run on this server's keys. */
export function apiOnlyTurnsOn(kind: string, target: string, hooked: boolean): boolean {
  return hooked && API_ONLY_HOOKED_KINDS.has(kind) && target === "start_run";
}

/** Why an API-only server refuses `body`, a PATCH of a trigger whose source is `kind` and whose target is `target`, each
 *  an issue (none: it goes on to the trigger's own checks). It takes `enabled` alone: a new source or target would let
 *  the token aim a trigger at an address or an agent of its own choosing (a feed's urls fetched by this server, a run of
 *  another agent), which no route here lets it make, and a name or a cap is the console's to edit. Turned off: always,
 *  it stops firings. Turned on: only where the apply would make it (apiOnlyTurnsOn), so its firings go to the backend;
 *  any other would start or open runs on this server's keys, or wait on a hook or setting this profile refuses. */
export function apiOnlyTriggerEdit(body: unknown, kind: string, hooked: boolean, target: string): InputIssue[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  const issues: InputIssue[] = Object.keys(body).filter((key) => key !== "enabled").map((field) => ({ field, reason: "not_allowed", message: `This server serves the run API only (${API_ONLY_ENV}=1), where a trigger is turned on or off alone: send {"enabled": true} or {"enabled": false}, without ${field}.` }));
  if ((body as { enabled?: unknown }).enabled !== true || apiOnlyTurnsOn(kind, target, hooked)) return issues;
  const named = `This server serves the run API only (${API_ONLY_ENV}=1)`;
  if (target !== "start_run") {
    issues.push({ field: "enabled", reason: "not_an_option", message: `${named}, and this trigger messages a run: its firings never go to the launch hook, so each would open that run on this server's keys. It is not turned on here. Send the run its messages through the API instead.` });
    return issues;
  }
  issues.push(API_ONLY_HOOKED_KINDS.has(kind)
    ? { field: "enabled", reason: NOT_SET_UP, message: `${named} and has no launch hook, so this ${kind} trigger's firings would start runs on this server's keys: set the launch hook (${LAUNCH_HOOK_URL_ENV} and ${LAUNCH_HOOK_SECRET_ENV}), then turn it on.` }
    : { field: "enabled", reason: "not_an_option", message: `${named}, which serves no route or setting a ${kind} trigger needs, so it is not turned on here. Start its runs through the API instead.` });
  return issues;
}

/** Whether an API-only server saves `body` through the generic save (saveMcpServer) over the name its path gives: a
 *  per_run server (no credential kept) whose url's origin is one of `origins`, under a name that is not a Composio
 *  preset's (`preset`; Composio's own route saves those). Checked before anything reaches the address. A body that
 *  carries a credential never gets here: the secret-write gate refuses it first (403), as it refuses the token's save
 *  over a server it did not save or one that seals a credential (mcp-secret-writes.ts tokenWriteOverRefused). */
export function apiOnlyMcpSave(body: unknown, preset: boolean, origins: readonly string[]): boolean {
  if (preset || origins.length === 0 || body === null || typeof body !== "object") return false;
  const { url, auth } = body as { url?: unknown; auth?: unknown };
  if (auth === null || typeof auth !== "object" || (auth as { type?: unknown }).type !== "per_run" || typeof url !== "string") return false;
  try {
    return origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/** A run's computer live view: its page, files and socket, which take the viewer credential alone here (server.ts). */
const COMPUTER_LIVE = /^\/v2\/runs\/[^/]+\/computer\/live\//;

/** Whether an API-only server serves `method` on `raw` (the path as sent, its query cut): a /v2 path one of
 *  API_ONLY_ROUTES matches for that method (HEAD as GET), the generic MCP save when the operator names MCP origins
 *  (`mcpSave`, its body checked at the route: apiOnlyMcpSave), or a GET of a run's computer live view. */
export function servedApiOnly(routes: readonly Route[], method: string | undefined, raw: string, mcpSave = false): boolean {
  if (!raw.startsWith("/v2/")) return false;
  const path = raw.slice(3);
  const asked = method === "HEAD" ? "GET" : method;
  if (asked === "GET" && COMPUTER_LIVE.test(raw)) return true;
  const served = (name: string) => API_ONLY_ROUTES.has(name) || (name === "saveMcpServer" && mcpSave);
  return routes.some((route) => served(route.name) && route.method === asked && route.pattern.test(path));
}

/** The refusal's words for `raw` on an API-only server. */
export const apiOnlyRefusal = (raw: string): string => `this server serves the run API only (${API_ONLY_ENV}=1): ${raw} is not served here`;

/** The operations a scoped request (the AgentRun-Workspace header, workspace-scope.ts) is served: its own agents, runs,
 *  imported template packages and uploaded files, and the server's description. Every other is refused with 403 not_scoped, whatever
 *  API_ONLY_ROUTES serves an unscoped request. listAgents, createAgent, updateDefinition, getTemplate, listTemplates,
 *  getOpenapi, getRunGraph, getRunTrace, pauseRun, resumeRun, archiveRun, unarchiveRun and startRun are not in
 *  API_ONLY_ROUTES: an API-only server serves them to a scoped request alone. Every run route here names its run first
 *  in its path, which the route's scope check reads as missing when it is another workspace's. answerApproval is not
 *  here: it takes the owner's session alone, never a token. Nor are the agent extras in API_ONLY_ROUTES; each names its
 *  agent first in its path, as the run routes name their run, and validateWorkflow names none. writeHomeFile is not here:
 *  nothing bounds a home's size on a disk the workspaces share. Nor is forgetSignIn: removing a secret takes the owner's
 *  console session, never a token (secret-writes.ts). */
export const WORKSPACE_ROUTES: ReadonlySet<string> = new Set([
  "listAllRuns", "listRuns", "getRun", "getTimeline", "listRunFiles", "readRunFile", "getRunExport",
  "listAgents", "getAgent", "listRevisions", "createAgent", "updateDefinition", "setCurrent",
  "getAgentPackage", "getRevisionSkills", "validateWorkflow", "listHomeFiles", "readHomeFile", "deleteHomeFile",
  "importTemplate", "applyTemplate", "getTemplate", "listTemplates",
  "createRun", "sendMessage", "stopRun", "cancelRun",
  "deleteRun", "raiseRunCap", "getRunGraph", "getRunTrace", "pauseRun", "resumeRun", "archiveRun", "unarchiveRun", "gradeRun", "startRun",
  "createFile", "listFiles", "getFile", "uploadFile", "deleteFile",
  "getCapabilities", "getHealth", "getOpenapi",
]);

/** How a scoped request for `method` on `raw` is served: "served" for a /v2 path one of WORKSPACE_ROUTES matches,
 *  "not_scoped" for one only another operation matches, "none" for a path no operation has. */
export function servedScoped(routes: readonly Route[], method: string | undefined, raw: string): "served" | "not_scoped" | "none" {
  if (!raw.startsWith("/v2/")) return "none";
  const path = raw.slice(3);
  const asked = method === "HEAD" ? "GET" : method;
  const matched = routes.filter((route) => route.method === asked && route.pattern.test(path));
  if (matched.some((route) => WORKSPACE_ROUTES.has(route.name))) return "served";
  return matched.length || COMPUTER_LIVE.test(raw) ? "not_scoped" : "none";
}
