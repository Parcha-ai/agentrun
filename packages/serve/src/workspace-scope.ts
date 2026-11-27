// A request's workspace: an opaque name a backend in front of an API-only server (AGENTRUN_API_ONLY=1) sends in the
// AgentRun-Workspace header, so each of its tenants sees and makes only its own agents, runs and imported template
// packages. The server keeps nothing about who the tenant is: the backend authenticates its callers, and this server
// trusts the name because a server token (AGENTRUN_TOKENS) opened the request. A token named in AGENTRUN_WORKSPACE_TOKENS
// must send it on every request, so a backend that forgot it is refused, never handed every tenant's rows. A request
// with no header is served as before, every row in reach.
//
// A scoped request is served only for an operation in WORKSPACE_ROUTES (api-only.ts); a row of another workspace reads as
// a missing one, with the same 404; lists hold the workspace's rows alone; what it makes is stamped with the workspace.
import { AsyncLocalStorage } from "node:async_hooks";
import { API_ONLY_ENV } from "./env-switch.js";

/** The header a scoped request carries, as its words name it, and lower case, as Node keeps request headers. */
export const WORKSPACE_NAME = "AgentRun-Workspace";
export const WORKSPACE_HEADER = "agentrun-workspace";
/** The token ids (AGENTRUN_TOKENS) that must carry the header. */
export const WORKSPACE_TOKENS_ENV = "AGENTRUN_WORKSPACE_TOKENS";
/** A workspace's name: 1 to 128 letters, digits, `:`, `.`, `_` or `-`. */
export const WORKSPACE = /^[A-Za-z0-9:._-]{1,128}$/;

const scope = new AsyncLocalStorage<string>();

/** The workspace of the request being served, or undefined for an unscoped one. */
export const workspaceNow = (): string | undefined => scope.getStore();

/** `work` run as a request in `workspace` (unscoped when undefined). */
export const inWorkspace = <T>(workspace: string | undefined, work: () => T): T => (workspace === undefined ? work() : scope.run(workspace, work));

/** Whether a row in `held` (null: in none) is out of reach of the request being served: never for an unscoped one. */
export const outOfScope = (held: string | null | undefined): boolean => {
  const workspace = workspaceNow();
  return workspace !== undefined && held !== workspace;
};

/** An idempotency slot's prefix: the request's workspace, so one workspace's key never replays another's answer. */
export const scopedSlot = (slot: string): string => {
  const workspace = workspaceNow();
  return workspace === undefined ? slot : `${workspace}|${slot}`;
};

/** The request path an idempotency slot (`[<workspace>|]<path>\n<key>`) was kept for, its workspace cut. */
export const slotPath = (slot: string): string => {
  const path = slot.slice(0, slot.indexOf("\n"));
  return path.startsWith("/") ? path : path.slice(path.indexOf("|") + 1);
};

/** AGENTRUN_WORKSPACE_TOKENS' ids: separated by commas or whitespace; none when unset. */
export const workspaceTokenIds = (text: string | undefined): string[] => [...new Set((text ?? "").split(/[\s,]+/).filter((id) => id !== ""))];

/** The token ids of AGENTRUN_WORKSPACE_TOKENS (workspaceTokenIds), each one of `known` (the ids of the tokens the server
 *  takes). Throws, in words that name the variable, on an id no token has or on a server that is not API-only
 *  (`apiOnly`), where the header is refused. */
export function workspaceTokensFrom(text: string | undefined, known: readonly string[], apiOnly: boolean): string[] {
  const ids = workspaceTokenIds(text);
  if (ids.length === 0) return [];
  if (!apiOnly) throw new Error(`${WORKSPACE_TOKENS_ENV} is set on a server that is not API-only: set ${API_ONLY_ENV}=1, where a request's workspace is taken, or unset it`);
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length) throw new Error(`${WORKSPACE_TOKENS_ENV} names ${unknown.join(", ")}, which no token in AGENTRUN_TOKENS is`);
  return ids;
}
