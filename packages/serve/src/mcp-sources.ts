// What a saved MCP server is, for a template's apply to map its MCP needs onto (templates.ts serversFor): where its tools
// come from (`source`: composio, github or url) and the toolkit they are (`toolkit`, a template's own name for them,
// mcp:<toolkit>/<tool>). The Composio preset records composio and its toolkit; a server on the GitHub App's tokens (auth
// github_app) is always github/github, and one at GitHub's hosted MCP address is github/github unless its owner says
// otherwise; any other is url with the toolkit its owner gives it in Settings, else none. What the owner (or the preset)
// said is one row of store.settings per server (mcpSourceKey), written by a save that names it, removed with the server.
// That row is a write of its own after the server's: it names the server row it was written for (`of`, the row's
// created_at, which a save over the row keeps), and is read only for that row. One left behind by a removal that raced a
// save, or by a removal cut short, is never read as what a server saved again under the name is.
import type { InputIssue } from "./errors.js";
import { githubMcpUrl } from "./github.js";
import { MCP_SERVER_NAME } from "./tool-names.js";
import { isObject } from "./validate.js";

export const MCP_SOURCES = ["composio", "github", "url"] as const;
export type McpSource = (typeof MCP_SOURCES)[number];
/** A saved server's source and toolkit (none: a url server its owner has said nothing of). */
export type SourceRecord = { source: McpSource; toolkit: string | null };

/** The store.settings key a server's record lives under. */
export const mcpSourceKey = (name: string): string => `mcp.source/${name}`;

const GITHUB: SourceRecord = { source: "github", toolkit: "github" };

/** A saved server row as its record is bound to it: created_at, kept by every save over the row (none: no row yet). */
export type RecordedRow = { url: string; auth: string; createdAt?: number };

/** The settings value a record is stored as, bound to the server row it was written for. */
export const storedSource = (record: SourceRecord, row: { createdAt: number }): SourceRecord & { of: number } => ({ ...record, of: row.createdAt });

/** Whether the stored value `value` was written for another server row than the one created at `createdAt`: a record left
 *  behind, which a removal of this row leaves for the row it is. */
export const recordedForAnother = (value: unknown, createdAt: number): boolean => isObject(value) && typeof value.of === "number" && value.of !== createdAt;

/** A stored record read for the row created at `createdAt`, or undefined when it is not one or was written for another row
 *  (fail to the default, never to another server's toolkit). */
function recordOf(value: unknown, createdAt: number | undefined): SourceRecord | undefined {
  if (!isObject(value) || createdAt === undefined || value.of !== createdAt || !(MCP_SOURCES as readonly unknown[]).includes(value.source)) return undefined;
  const toolkit = value.toolkit === null ? null : typeof value.toolkit === "string" && MCP_SERVER_NAME.test(value.toolkit) ? value.toolkit : undefined;
  return toolkit === undefined ? undefined : { source: value.source as McpSource, toolkit };
}

/** Whether `url` is on Composio's own hosts (composio.dev and its subdomains), where its MCP servers are served. */
const composioUrl = (url: string): boolean => {
  try {
    return /(^|\.)composio\.dev$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** What a server with no record of its own is: github/github at GitHub's hosted MCP address; composio with no toolkit yet
 *  on Composio's hosts (one saved before records were, or by hand: its owner names the toolkit, as a composio record
 *  must, for a template's need to match it); else url with no toolkit. */
const derived = (row: { url: string; auth: string }, githubOrigin: string): SourceRecord =>
  row.auth === "github_app" || githubMcpUrl(row.url, githubOrigin) ? { ...GITHUB } : { source: composioUrl(row.url) ? "composio" : "url", toolkit: null };

/** What the saved server `row` is: github/github whatever was recorded when it runs on the GitHub App's tokens, else its
 *  record (the one written for this row), else what its address says (derived). */
export function sourceOf(row: RecordedRow, recorded: unknown, githubOrigin: string): SourceRecord {
  if (row.auth === "github_app") return { ...GITHUB };
  return recordOf(recorded, row.createdAt) ?? derived(row, githubOrigin);
}

/** A save body's `source` and `toolkit`, each checked when given (a toolkit of null clears it); an issue for each that is
 *  not one. Neither given: nothing to write, and the server keeps what it has. */
export function sourceGiven(body: Record<string, unknown>, issues: InputIssue[]): { source?: McpSource; toolkit?: string | null } {
  const out: { source?: McpSource; toolkit?: string | null } = {};
  if (body.source !== undefined) {
    if ((MCP_SOURCES as readonly unknown[]).includes(body.source)) out.source = body.source as McpSource;
    else issues.push({ field: "source", reason: "not_an_option", message: `source is one of ${MCP_SOURCES.join(", ")}: where the server's tools come from, which a template's MCP needs are matched on` });
  }
  if (body.toolkit !== undefined) {
    if (body.toolkit === null || (typeof body.toolkit === "string" && MCP_SERVER_NAME.test(body.toolkit))) out.toolkit = body.toolkit as string | null;
    else issues.push({ field: "toolkit", reason: "bad_format", message: `toolkit is the toolkit its tools are, as a template names them (mcp:<toolkit>/<tool>): ${MCP_SERVER_NAME.source}, or null for none` });
  }
  return out;
}

/** The record a save writes: what it gives over what the server is now (`was`, sourceOf), held to the rules a record keeps:
 *  a github_app server is github/github, a github one's toolkit is github, a composio one names its toolkit. Undefined
 *  when the save gives neither (the server keeps what it has). */
export function sourceToWrite(given: { source?: McpSource; toolkit?: string | null }, was: SourceRecord, auth: string, issues: InputIssue[]): SourceRecord | undefined {
  if (given.source === undefined && given.toolkit === undefined) return undefined;
  const source = given.source ?? was.source;
  const toolkit = given.toolkit !== undefined ? given.toolkit : source === "github" ? "github" : given.source !== undefined && given.source !== was.source ? null : was.toolkit;
  if (auth === "github_app" && (source !== "github" || toolkit !== "github")) {
    issues.push({ field: given.source !== undefined && given.source !== "github" ? "source" : "toolkit", reason: "not_an_option", message: "A server on the GitHub App's tokens is GitHub's hosted MCP: its source and toolkit are github." });
    return undefined;
  }
  if (source === "github" && toolkit !== "github") issues.push({ field: "toolkit", reason: "not_an_option", message: "A github server's toolkit is github: GitHub's MCP server's tools are one toolkit." });
  else if (source === "composio" && !toolkit) issues.push({ field: "toolkit", reason: "missing", message: "A composio server names its toolkit, as Composio slugs it (gmail, slack, hackernews...)." });
  else return { source, toolkit };
  return undefined;
}
