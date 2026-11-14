// What a saved MCP server is, for a template's apply to map its MCP needs onto (templates.ts serversFor): where its tools
// come from (`source`: composio, github or url) and the toolkit they are (`toolkit`, a template's own name for them,
// mcp:<toolkit>/<tool>). It is recorded when the server is saved, from what made it, and never read off its address or
// its name: the Composio preset records composio and its toolkit; a server on the GitHub App's tokens (auth github_app)
// is github/github; anything else is url, with the toolkit its owner gives it (a save's `toolkit`, Settings), else none.
// The record is one row of store.settings per server (mcpSourceKey), a write of its own after the server's: it names the
// server row it was written for (`of`, the row's created_at, which a save over the row keeps), and is read only for that
// row. One left behind by a removal that raced a save, or by a removal cut short, is never read as what a server saved
// again under the name is.
import type { InputIssue } from "./errors.js";
import { MCP_SERVER_NAME } from "./tool-names.js";
import { isObject } from "./validate.js";

export const MCP_SOURCES = ["composio", "github", "url"] as const;
export type McpSource = (typeof MCP_SOURCES)[number];
/** A saved server's source and toolkit (none: a url server its owner has said nothing of). */
export type SourceRecord = { source: McpSource; toolkit: string | null };

/** What a save body's `source` says a fake MCP server stands in for, with the body's `toolkit` (an eval's own server
 *  alone takes it: ServeOptions.mcpStandIns), or an issue. Undefined: the body names none. */
export function standInGiven(body: Record<string, unknown>, toolkit: string | null | undefined, issues: InputIssue[]): SourceRecord | undefined {
  if (body.source === undefined) return undefined;
  if (typeof body.source !== "string" || !(MCP_SOURCES as readonly string[]).includes(body.source)) issues.push({ field: "source", reason: "not_an_option", message: `source is what the fake stands in for: ${MCP_SOURCES.join(", ")}` });
  else if (!toolkit) issues.push({ field: "toolkit", reason: "missing", message: "A fake standing in for a package's need names the need's toolkit." });
  else return { source: body.source as McpSource, toolkit };
  return undefined;
}

/** The store.settings key a server's record lives under. */
export const mcpSourceKey = (name: string): string => `mcp.source/${name}`;

const GITHUB: SourceRecord = { source: "github", toolkit: "github" };
const NONE: SourceRecord = { source: "url", toolkit: null };

/** A saved server row as its record is bound to it: created_at, kept by every save over the row (none: no row yet). */
export type RecordedRow = { auth: string; createdAt?: number };

/** The settings value a record is stored as, bound to the server row it was written for. `standIn`: an eval's fake
 *  standing in for a need (standInGiven), the one record that may say github. */
export const storedSource = (record: SourceRecord, row: { createdAt: number }, standIn = false): SourceRecord & { of: number; stand_in?: true } => ({ ...record, of: row.createdAt, ...(standIn ? { stand_in: true as const } : {}) });

/** Whether the stored value `value` was written for another server row than the one created at `createdAt`: a record left
 *  behind, which a removal of this row leaves for the row it is. */
export const recordedForAnother = (value: unknown, createdAt: number): boolean => isObject(value) && typeof value.of === "number" && value.of !== createdAt;

/** A stored record read for the row created at `createdAt`, or undefined when it is not one or was written for another row
 *  (fail to url with none, never to another server's toolkit). Only composio and url are recorded: github is the auth's,
 *  but for an eval's fake that stands in for it (its record marked stand_in, written on the eval's own server alone). */
function recordOf(value: unknown, createdAt: number | undefined): SourceRecord | undefined {
  if (!isObject(value) || createdAt === undefined || value.of !== createdAt) return undefined;
  if (value.source !== "composio" && value.source !== "url" && !(value.source === "github" && value.stand_in === true)) return undefined;
  const toolkit = value.toolkit === null ? null : typeof value.toolkit === "string" && MCP_SERVER_NAME.test(value.toolkit) ? value.toolkit : undefined;
  return toolkit === undefined ? undefined : { source: value.source, toolkit };
}

/** What the saved server `row` is: github/github on the GitHub App's tokens, else its record (the one written for this
 *  row), else url with no toolkit. */
export function sourceOf(row: RecordedRow, recorded: unknown): SourceRecord {
  if (row.auth === "github_app") return { ...GITHUB };
  return recordOf(recorded, row.createdAt) ?? { ...NONE };
}

/** A save body's `toolkit`, checked when given (null clears it); an issue when it is not one. Absent: nothing to write. */
export function toolkitGiven(body: Record<string, unknown>, issues: InputIssue[]): string | null | undefined {
  if (body.toolkit === undefined) return undefined;
  if (body.toolkit === null || (typeof body.toolkit === "string" && MCP_SERVER_NAME.test(body.toolkit))) return body.toolkit as string | null;
  issues.push({ field: "toolkit", reason: "bad_format", message: `toolkit is the toolkit its tools are, as a template names them (mcp:<toolkit>/<tool>): ${MCP_SERVER_NAME.source}, or null for none` });
  return undefined;
}

/** The record a save writes, from what made it: the preset's (`made`: composio and its toolkit), else, for the owner's
 *  `toolkit`, the server's source as it is (a composio one stays composio; any other is url) with that toolkit. None on the
 *  GitHub App's tokens (always github/github, whose toolkit is github), nor when nothing is given (the server keeps what
 *  it has). */
export function sourceToWrite(made: SourceRecord | undefined, toolkit: string | null | undefined, was: SourceRecord, auth: string, issues: InputIssue[]): SourceRecord | undefined {
  if (auth === "github_app") {
    if (made || (toolkit !== undefined && toolkit !== "github")) issues.push({ field: "toolkit", reason: "not_an_option", message: "A server on the GitHub App's tokens is GitHub's hosted MCP: its source and toolkit are github." });
    return undefined;
  }
  if (made) return made;
  if (toolkit === undefined) return undefined;
  const source = was.source === "composio" ? "composio" : "url";
  if (source === "composio" && !toolkit) {
    issues.push({ field: "toolkit", reason: "missing", message: "A composio server names its toolkit, as Composio slugs it (gmail, slack, hackernews...)." });
    return undefined;
  }
  return { source, toolkit };
}
