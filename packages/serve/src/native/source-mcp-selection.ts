/** Native MCP selection without contacting a server or opening credentials. Codex 0.171.0's
 * ToolFilter uses exact names. Claude 2.1.322's agent selectors use qualified mcp__ names;
 * keeping the whole name avoids confusing a server containing __ with another server's tool. */
import type { SourceMcpSelection } from "./source-snapshot-types.js";

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/.test(value);
export const claudeMcpSelector = (value: unknown): value is string => text(value) && value.startsWith("mcp__") && value.length > 5 && !/[()\[\]{}?\\]/.test(value);
export function sourceMcpSelection(value: unknown): value is SourceMcpSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["dialect", "allow", "deny"].includes(key)) || !["exact", "claude"].includes(v.dialect as string)) return false;
  const names = (items: unknown) => Array.isArray(items) && items.length <= 1000 && items.every(v.dialect === "claude" ? claudeMcpSelector : text) && new Set(items).size === items.length;
  return (v.allow === null || names(v.allow)) && names(v.deny);
}
/** Literal chunks and * only. Each search advances through the name; no regexp backtracking on an upstream name. */
const glob = (pattern: string, value: string): boolean => {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === value;
  const first = parts[0]!, last = parts.at(-1)!;
  if (!value.startsWith(first) || !value.endsWith(last)) return false;
  const end = value.length - last.length;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    if (!part) continue;
    const found = value.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
    if (at > end) return false;
  }
  return at <= end;
};
function claudeMatches(pattern: string, qualified: string, deny = false): boolean {
  if (glob(pattern, qualified)) return true;
  // A bare server deny is a prefix in Claude; a server named reports__v2 is consequently
  // excluded by mcp__reports as documented. Allow entries do not get this implicit wildcard.
  return deny && !pattern.includes("*") && !pattern.slice(5).includes("__") && qualified.startsWith(`${pattern}__`);
}
export function selectedMcpTool(selection: SourceMcpSelection, server: string, tool: string): boolean {
  if (selection.dialect === "exact") return (selection.allow === null || selection.allow.includes(tool)) && !selection.deny.includes(tool);
  const qualified = `mcp__${server}__${tool}`;
  return (selection.allow === null || selection.allow.some(pattern => claudeMatches(pattern, qualified))) && !selection.deny.some(pattern => claudeMatches(pattern, qualified, true));
}
/** Whether a server can contribute a selected tool, before its destination catalog is opened. */
export function selectedMcpServer(selection: SourceMcpSelection, server: string): boolean {
  if (selection.dialect === "exact") return selection.allow === null || selection.allow.some(name => !selection.deny.includes(name));
  const prefix = `mcp__${server}__`;
  if (selection.deny.some(pattern => pattern === "mcp__*" || pattern === `${prefix}*`
    || !pattern.includes("*") && !pattern.slice(5).includes("__") && prefix.startsWith(`${pattern}__`))) return false;
  return selection.allow === null || selection.allow.some(pattern => {
    const fixed = pattern.split("*", 1)[0]!;
    return fixed.startsWith(prefix) || pattern.includes("*") && prefix.startsWith(fixed);
  });
}
/** Exact, positively selected names must exist. Wildcards mean the available pool, possibly empty;
 * a deny always wins, including an exact name present in both lists. */
export function missingMcpTools(selection: SourceMcpSelection, server: string, available: readonly string[]): string[] {
  if (selection.allow === null) return [];
  if (selection.dialect === "exact") return selection.allow.filter(name => !selection.deny.includes(name) && !available.includes(name));
  const prefix = `mcp__${server}__`;
  return selection.allow.filter(name => !name.includes("*") && name.startsWith(prefix)
    && !selection.deny.some(pattern => claudeMatches(pattern, name, true)) && !available.includes(name.slice(prefix.length)));
}
export const nativeToolNames = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === "string") ? value
  : typeof value === "string" ? value.split(/[,\s]+/).filter(Boolean) : undefined;
