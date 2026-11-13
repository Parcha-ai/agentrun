// What a template's GitHub MCP tools need of Connect GitHub's App, against what each installation of the App holds right
// now (GET /app/installations/{id}'s `permissions`, github-connection.ts installationPermissions). A tool that needs more
// than the installation holds is refused by GitHub at every call; applying a template that grants one says so first, in
// words, naming what is missing from the map GitHub gave, where the github MCP server runs on the App's tokens (auth
// github_app). When the map cannot be read, the warning says it could not check: never a guess either way. A server whose
// github MCP server holds the owner's own token is the owner's to scope: no warning. Widening the App is the owner's call,
// never made here.
import type { InputIssue } from "./errors.js";
import { NOT_SET_UP } from "./runnable.js";
import type { McpNeed } from "./templates.js";

export type Level = "read" | "write";

/** What the App's installations hold, as GitHub says now: each one's account and permissions map; or why it could not be
 *  read (in words that end a sentence's clause, with no full stop). */
export type Held = { readonly installations: readonly { readonly account: string; readonly permissions: Readonly<Record<string, Level>> }[] } | { readonly unreadable: string };

/** Each GitHub MCP tool a template may grant that needs more than reading what the App's metadata gives: the permission
 *  and level GitHub's permission table for its request names, and what the template does instead when it can't. */
export const TOOL_PERMISSIONS: Record<string, { permission: string; level: Level; instead: string }> = {
  issue_write: { permission: "issues", level: "write", instead: "keeps its draft in its answer" },
};

/** Each permission as GitHub's App settings name it. */
const LABELS: Record<string, string> = { issues: "Issues", pull_requests: "Pull requests", contents: "Contents", metadata: "Metadata" };

const holds = (has: Level | undefined, needs: Level) => has === "write" || (has === "read" && needs === "read");

/** The warnings applying `pkg` adds: one for each GitHub MCP tool it grants that needs a permission an installation of the
 *  App does not hold (naming each installation's account and what it holds), on an MCP server `onApp` says runs on the App's
 *  tokens; or, where `held` could not be read, one saying it could not check. `held` is asked once, and only when a tool
 *  with a need is granted on such a server. */
export async function appPermissionWarnings(pkg: { name: string; mcp: readonly McpNeed[] }, onApp: (server: string) => boolean, held: () => Promise<Held>): Promise<InputIssue[]> {
  const asked: { server: string; tool: string; wants: (typeof TOOL_PERMISSIONS)[string] }[] = [];
  for (const need of pkg.mcp) {
    if (!onApp(need.server)) continue;
    for (const tool of need.tools) {
      const wants = TOOL_PERMISSIONS[tool];
      if (wants) asked.push({ server: need.server, tool, wants });
    }
  }
  if (!asked.length) return [];
  const map = await held();
  const warnings: InputIssue[] = [];
  for (const { server, tool, wants } of asked) {
    // One of the grants.<tool> family (a tool the server denies is another): its field and its shape.
    const label = LABELS[wants.permission] ?? wants.permission;
    const name = `mcp:${server}/${tool}`;
    if ("unreadable" in map) {
      warnings.push({ field: `grants.${name}`, reason: NOT_SET_UP, message: `${name} needs ${label}: ${wants.level} of the GitHub App, and this server could not check whether it has it (${map.unreadable}): if ${pkg.name} can't use it, it ${wants.instead}.` });
      continue;
    }
    const short = map.installations.filter((installation) => !holds(installation.permissions[wants.permission], wants.level));
    if (!short.length) continue;
    const holding = short.map(({ account, permissions }) => `${permissions[wants.permission] ? `${label}: ${permissions[wants.permission]}` : `no ${label} permission`} on ${account}`).join(", ");
    warnings.push({ field: `grants.${name}`, reason: "not_allowed", message: `${name} needs ${label}: ${wants.level}, and this server's GitHub App has ${holding}, so GitHub refuses it: ${pkg.name} ${wants.instead}. The App's owner can add ${label}: ${wants.level} to it on GitHub.` });
  }
  return warnings;
}
