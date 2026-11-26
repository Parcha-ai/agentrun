// The per-tool file option: an MCP tool whose answers the agent's own tool setting files (`mcp:<server>/<tool>: {file:
// {folder, show}}`, written by a package's `mcp[].file` at apply, or by the owner). The gateway writes each answer, an
// error answer and a protocol error too, scrubbed and whole, at <folder>/<tool>-<time>-<id>.json in the run's files, and the tool's result is
// only a summary: how many bytes, where it is filed (for the skill's code), the values of the paths `show` names, and
// the answer's shape (keys that read as plain names and types to depth 2, array lengths), never another value; for an
// error, a last line of what its structure gives (errorLine) (mcp-gateway.ts forward). The answer goes through neither the clip nor evidence/mcp/. So a template whose tool answers
// hold what the model must not read (a customer's descriptions, say) hands its code the whole answer and its model the
// values it needs to go on (the next page's cursor). The tool gate refuses the agent's own read, write and edit,
// web_save's and browser_upload's paths, and a learned workflow call node's (pdf_pages), at or under the folder (tool-gate.ts filedRefusal), by the path's words as given
// and as pi's file tools take them (pdf_pages' as pdf_pages opens it: pdfWorkPath; a screenshot's save_as as the kernel saves it: savePathOf), each segment folded. On a computer that mounts the run's folder, while a folder is
// filed, a script's file ops must name an absolute path inside /workspace (tool-gate.ts keptRefusal): the computer
// reaches the folder by names no word check follows (/proc/self/root, /proc/self/cwd, /dev/fd), and is handed the path
// as written, so a relative path, the rest of its disk, and the run folder's names on the runner's machine are refused
// to them. Outside the gate: bash (a command, a link it made, any program the run starts), which only bash set to deny
// stops, since shell.run and processes.start follow bash's setting, not whether bash is among the agent's tools; the
// computer's screen (input on a terminal or file manager, apps.open with a path or file:// URL), which a desktop's
// scripts reach with no screen tools too (surface code); a link already inside
// /workspace; a harness's own reads that never ask the host (Cursor's); and any other tool that opens the run's files.
// Opening a script's file beneath /workspace on the computer with links refused (openat2 with RESOLVE_BENEATH and
// RESOLVE_NO_MAGICLINKS) is a follow-up. A template that must keep the model off the answer sets bash to deny and gives
// the run no desktop or sets the desktop kind to deny, or runs its skill's code where the model can't read the output. A show path that names a free-text field shows that text:
// the option holds only as far as its paths do. A stored setting that no longer reads refuses every call of its tool.
import type { InputIssue } from "./errors.js";

/** A tool's file setting: the folder of the run's files its answers are filed in, and the paths of each answer the
 *  tool's result shows. */
export type FileSetting = { folder: string; show: string[] };

/** The most show paths, and the most segments of one. */
export const MAX_SHOW_PATHS = 8;
export const MAX_SHOW_SEGMENTS = 6;
/** The longest shown string, in characters. */
export const SHOWN_CHARS = 200;
/** A folder segment: no dot first (no `..`, no hidden folder), nothing that names another place. */
const FOLDER_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** A show path's segment: a key's name, an array's index, or -1 (its last item). */
const SHOW_SEGMENT = /^(?:[A-Za-z_$][A-Za-z0-9_$-]{0,63}|0|[1-9][0-9]{0,8}|-1)$/;
const FOLDER_WORDS = "1 to 3 segments joined by /, each letters, digits, _, - or . and never starting with a dot (no .., no hidden folder)";
const PATH_WORDS = `a path of 1 to ${MAX_SHOW_SEGMENTS} segments joined by ., each a key (a letter, _ or $ first), an index (0, 1, ...) or -1 (the last item)`;

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** Whether `folder` reads as a file setting's folder: FOLDER_WORDS. */
const folderReads = (folder: unknown): folder is string => {
  const segments = typeof folder === "string" ? folder.split("/") : [];
  return segments.length >= 1 && segments.length <= 3 && segments.every((segment) => FOLDER_SEGMENT.test(segment));
};

/** The folders an agent's own tool settings (its revision's body.toolSettings) file answers in, each with its setting's
 *  key (`mcp:<server>/<tool>`): what the tool gate keeps the agent's own file tools out of (tool-gate.ts filedRefusal).
 *  A setting whose folder reads counts whether or not the rest of it does (one that does not refuses its tool's calls,
 *  but a runner older than the setting may have filed there). */
export function filedFolders(toolSettings: unknown): { key: string; folder: string }[] {
  if (!isPlain(toolSettings)) return [];
  return Object.entries(toolSettings).flatMap(([key, setting]) => {
    const folder = key.startsWith("mcp:") && isPlain(setting) && isPlain(setting.file) ? setting.file.folder : undefined;
    return folderReads(folder) ? [{ key, folder }] : [];
  });
}

/** The issues of `given` as a file setting, its fields under `at`: none when it is one. */
export function fileIssues(given: unknown, at: string): InputIssue[] {
  if (!isPlain(given) || Object.keys(given).some((key) => key !== "folder" && key !== "show") || given.folder === undefined || given.show === undefined) {
    return [{ field: at, reason: "wrong_type", message: `${at} is {folder, show}: the folder of the run's files each answer of the tool is filed in, whole, and the paths of it the tool's result shows (at most ${MAX_SHOW_PATHS}); the result shows no other value of it` }];
  }
  const issues: InputIssue[] = [];
  if (!folderReads(given.folder)) issues.push({ field: `${at}.folder`, reason: "not_an_option", message: `${at}.folder is a folder in the run's files: ${FOLDER_WORDS}` });
  const show = given.show;
  if (!Array.isArray(show) || show.length > MAX_SHOW_PATHS) {
    issues.push({ field: `${at}.show`, reason: "not_an_option", message: `${at}.show is a list of at most ${MAX_SHOW_PATHS} paths, each ${PATH_WORDS}` });
    return issues;
  }
  show.forEach((path, i) => {
    const parts = typeof path === "string" ? path.split(".") : [];
    if (!(parts.length >= 1 && parts.length <= MAX_SHOW_SEGMENTS && parts.every((part) => SHOW_SEGMENT.test(part)))) issues.push({ field: `${at}.show[${i}]`, reason: "not_an_option", message: `${at}.show[${i}] ${JSON.stringify(path)} is ${PATH_WORDS}` });
  });
  const twice = show.find((path, i) => show.indexOf(path) !== i);
  if (twice !== undefined) issues.push({ field: `${at}.show`, reason: "not_an_option", message: `${at}.show names ${String(twice)} twice` });
  return issues;
}

/** A stored file setting that does not read (a rule tightened since it was written, a runner older than the server that
 *  wrote it): every call of its tool is refused, never answered unfiled (mcp-gateway.ts unsendable). */
export const UNREADABLE = "unreadable";

/** The file setting of `server`'s `tool` in an agent's tool settings as its revision keeps them (body.toolSettings):
 *  undefined when it has none (the tool answers the model as it always has), UNREADABLE when it has one that does not
 *  read. */
export function filedBy(toolSettings: unknown): (server: string, tool: string) => FileSetting | typeof UNREADABLE | undefined {
  return (server, tool) => {
    const key = `mcp:${server}/${tool}`;
    const setting = isPlain(toolSettings) && Object.hasOwn(toolSettings, key) ? toolSettings[key] : undefined;
    const file = isPlain(setting) ? setting.file : undefined;
    if (file === undefined) return undefined;
    if (fileIssues(file, "file").length) return UNREADABLE;
    const { folder, show } = file as FileSetting;
    return { folder, show: [...show] };
  };
}

/** The value at `path` in `value`, as the model reads it: a scalar (a string cut at SHOWN_CHARS, … marking the cut),
 *  else null (absent, or an object or array). */
export function shownAt(value: unknown, path: string): string | number | boolean | null {
  let at: unknown = value;
  for (const part of path.split(".")) {
    if (Array.isArray(at)) at = part === "-1" ? at[at.length - 1] : /^\d+$/.test(part) ? at[Number(part)] : undefined;
    else if (isPlain(at)) at = Object.hasOwn(at, part) ? at[part] : undefined;
    else at = undefined;
  }
  if (typeof at === "string") {
    const chars = Array.from(at);
    return chars.length > SHOWN_CHARS ? `${chars.slice(0, SHOWN_CHARS).join("")}…` : at;
  }
  return typeof at === "number" || typeof at === "boolean" ? at : null;
}

/** The most keys of one object the shape names, and the longest shape. */
const SHAPE_KEYS = 40;
const SHAPE_CHARS = 2_000;
/** A key the shape names: a plain name, lowercase words joined by _ (has_more) or camelCase (pageInfo), with any _
 *  first (_id), at most SHAPE_KEY_CHARS. Any other key can be data (an email, an id with digits or capitals after a
 *  prefix like cus_NffrFeUfNV2Hib, an all-capitals code), so it is counted, never named. A key that is a plain word and
 *  data too (a username like marisol_q) still reads as a name: what a key looks like is all the shape can go by. */
const SHAPE_KEY = /^_*[a-z]+(?:(?:_[a-z]+)*|(?:[A-Z][a-z]+)+)$/;
const SHAPE_KEY_CHARS = 32;

/** `value`'s shape: types, each array's length and what it holds, an object's keys that are plain names (SHAPE_KEY) while `depth`
 *  is under 2 (the rest counted); never a value. */
export function shapeOf(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const kinds = new Set(value.map((item) => (item === null ? "null" : Array.isArray(item) ? "array" : typeof item)));
    const kind = kinds.size === 1 ? [...kinds][0]! : "item";
    return `[${value.length} ${kind}${value.length === 1 ? "" : "s"}]`;
  }
  if (isPlain(value)) {
    if (depth >= 2) return "object";
    const keys = Object.keys(value);
    const named = keys.filter((key) => key.length <= SHAPE_KEY_CHARS && SHAPE_KEY.test(key)).slice(0, SHAPE_KEYS).map((key) => `${JSON.stringify(key)}: ${shapeOf(value[key], depth + 1)}`);
    const rest = keys.length - named.length;
    const counted = rest ? `… ${rest} ${named.length ? "more " : ""}key${rest === 1 ? "" : "s"}` : "";
    return `{${[...named, ...(counted ? [counted] : [])].join(", ")}}`;
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? typeof value : "unknown";
}

/** What an error's structure says, never its words: the HTTP status of the server's answer, a JSON-RPC error's code (a
 *  protocol error), and a retry time from the Retry-After header, in seconds. */
export type ErrorFacts = { readonly status?: number; readonly code?: number; readonly retryAfterS?: number };

/** The longest wait a retry line names, in seconds: a day. */
const MOST_RETRY_S = 86_400;
/** A retry time's fields in a JSON error, in seconds or in milliseconds, read at the answer's top, under `error` and
 *  under `data`. */
const RETRY_S = ["retry_after", "retryAfter", "retry_after_seconds"];
const RETRY_MS = ["retry_after_ms", "retryAfterMs"];

const waitOf = (seconds: unknown): number | undefined => (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 && seconds <= MOST_RETRY_S ? Math.ceil(seconds) : undefined);

/** A Retry-After header's wait, in whole seconds (its seconds, or its date from now), or undefined. */
export function retryAfterHeader(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  if (/^\d{1,9}$/.test(value.trim())) return waitOf(Number(value.trim()));
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : waitOf(Math.max(0, (at - now) / 1000));
}

/** The retry time a JSON error names in a known field (RETRY_S, RETRY_MS), in whole seconds: at its top, in its `error`
 *  or `data`, or in its error's `data` (where a JSON-RPC error carries it, as the gateway files a protocol error). */
function retryOf(value: unknown): number | undefined {
  const error = isPlain(value) ? value.error : undefined;
  for (const at of [value, error, isPlain(value) ? value.data : undefined, isPlain(error) ? error.data : undefined]) {
    if (!isPlain(at)) continue;
    for (const key of RETRY_S) if (Object.hasOwn(at, key) && waitOf(at[key]) !== undefined) return waitOf(at[key]);
    for (const key of RETRY_MS) if (Object.hasOwn(at, key) && typeof at[key] === "number") { const wait = waitOf((at[key] as number) / 1000); if (wait !== undefined) return wait; }
  }
  return undefined;
}

/** An error answer's last line: its HTTP status, a JSON-RPC code, and when to retry (a retry field, the Retry-After
 *  header, or "later" for 429 and 503), all from its structure, never its words. */
function errorLine(value: unknown, json: boolean, facts: ErrorFacts): string {
  const parts: string[] = [];
  if (facts.status !== undefined && facts.status >= 400) parts.push(`HTTP ${facts.status}`);
  if (facts.code !== undefined) parts.push(`JSON-RPC error ${facts.code}`);
  const retry = facts.retryAfterS ?? (json ? retryOf(value) : undefined);
  if (retry !== undefined) parts.push(`retry after ${retry} s`);
  else if (facts.status === 429 || facts.status === 503) parts.push("retry later");
  return parts.length ? `Error: ${parts.join(", ")}.` : "Error: no status or retry time given.";
}

/** The tool's result for an answer filed at `path` (in the run's files): its bytes, where it is, the values `show`
 *  names, and its shape; for an error (`error` given), a last line of what its structure says (errorLine). */
export function filedSummary(tool: string, text: string, path: string, show: readonly string[], error?: ErrorFacts): string {
  let value: unknown;
  let json = true;
  try {
    value = JSON.parse(text);
  } catch {
    json = false;
  }
  const shown = `{${show.map((one) => `${JSON.stringify(one)}: ${JSON.stringify(json ? shownAt(value, one) : null)}`).join(", ")}}`;
  const shape = json ? shapeOf(value) : "text, not JSON";
  return [
    `${tool} answered ${Buffer.byteLength(text, "utf8").toLocaleString("en-US")} bytes, filed whole at ${path} for the skill's code; its values are not shown here (the agent's setting files this tool's answers); only these are:`,
    shown,
    `Shape: ${shape.length > SHAPE_CHARS ? `${shape.slice(0, SHAPE_CHARS)}…` : shape}`,
    ...(error ? [errorLine(value, json, error)] : []),
  ].join("\n");
}

/** The model's text when an answer could not be filed: none of it, the Workspace's words why. */
export const unfiledSummary = (tool: string, text: string, folder: string, why: string): string =>
  `${tool} answered ${Buffer.byteLength(text, "utf8").toLocaleString("en-US")} bytes, which could not be filed in ${folder}/ (${why}). The agent's setting files this tool's answers, so none of it is shown here.`;
