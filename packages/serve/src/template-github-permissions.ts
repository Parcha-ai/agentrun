// What a template's GitHub MCP tools need of Connect GitHub's App, against what the App asks for (its manifest's
// APP_PERMISSIONS, github-connection.ts). A tool that needs more than the App holds is refused by GitHub at every call;
// applying a template that grants one says so first, in words, where the github MCP server runs on the App's tokens
// (auth github_app). A server whose github MCP server holds the owner's own token is the owner's to scope: no warning.
// Widening the App is the owner's call, never made here.
import type { InputIssue } from "./errors.js";
import { APP_PERMISSIONS } from "./github-connection.js";
import { NOT_SET_UP } from "./runnable.js";
import type { McpNeed } from "./templates.js";

type Level = "read" | "write";

/** Each GitHub MCP tool a template may grant that needs more than reading what the App's metadata gives: the permission
 *  and level it needs, the thing it acts on, and what the template does instead when it can't. */
export const TOOL_PERMISSIONS: Record<string, { permission: keyof typeof APP_PERMISSIONS; level: Level; things: string; instead: string }> = {
  issue_write: { permission: "issues", level: "write", things: "issues", instead: "keeps its draft in its answer" },
};

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
      const can = has === "read" ? `can read ${wants.things} but not write them` : `can't ${wants.level} ${wants.things}`;
      warnings.push({ field: `grants.mcp:${need.server}/${tool}`, reason: NOT_SET_UP, message: `This server's GitHub App ${can}: ${pkg.name} ${wants.instead}.` });
    }
  }
  return warnings;
}
