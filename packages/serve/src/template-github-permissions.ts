// What a template's GitHub MCP tools need of Connect GitHub's App, against what the App asks for (its manifest's
// APP_PERMISSIONS, github-connection.ts). A tool that needs more than the App holds is refused by GitHub at every call;
// applying a template that grants one says so first, in words, where the github MCP server runs on the App's tokens
// (auth github_app). A server whose github MCP server holds the owner's own token is the owner's to scope: no warning.
// Widening the App is the owner's call, never made here.
import type { InputIssue } from "./errors.js";
import { APP_PERMISSIONS } from "./github-connection.js";
import type { McpNeed } from "./templates.js";

type Level = "read" | "write";

/** Each GitHub MCP tool a template may grant that needs more than reading what the App's metadata gives: the permission
 *  and level it needs, the thing it acts on, and what the template does instead when it can't. */
export const TOOL_PERMISSIONS: Record<string, { permission: keyof typeof APP_PERMISSIONS; level: Level; instead: string }> = {
  issue_write: { permission: "issues", level: "write", instead: "keeps its draft in its answer" },
};

/** Each permission as GitHub's App settings name it. */
const LABELS: Record<string, string> = { issues: "Issues", pull_requests: "Pull requests", contents: "Contents", metadata: "Metadata" };

const holds = (has: Level | undefined, needs: Level) => has === "write" || (has === "read" && needs === "read");

/** The warnings applying `pkg` adds: one for each GitHub MCP tool it grants that needs a permission `permissions` (the
 *  App's manifest) does not hold, on an MCP server `onApp` says runs on the App's tokens. */
export function appPermissionWarnings(pkg: { name: string; mcp: readonly McpNeed[] }, onApp: (server: string) => boolean, permissions: Readonly<Record<string, Level>> = APP_PERMISSIONS): InputIssue[] {
  const warnings: InputIssue[] = [];
  for (const need of pkg.mcp) {
    if (!onApp(need.server)) continue;
    for (const tool of need.tools) {
      const wants = TOOL_PERMISSIONS[tool];
      if (!wants) continue;
      const has = permissions[wants.permission];
      if (holds(has, wants.level)) continue;
      // One of the grants.<tool> family (a tool the server denies is another): its reason and its shape.
      const label = LABELS[wants.permission] ?? wants.permission;
      const name = `mcp:${need.server}/${tool}`;
      const holding = has ? `${label}: ${has}` : `no ${label} permission`;
      warnings.push({ field: `grants.${name}`, reason: "not_allowed", message: `${name} needs ${label}: ${wants.level}, and this server's GitHub App has ${holding}, so GitHub refuses it: ${pkg.name} ${wants.instead}. The App's owner can add ${label}: ${wants.level} to it on GitHub.` });
    }
  }
  return warnings;
}
