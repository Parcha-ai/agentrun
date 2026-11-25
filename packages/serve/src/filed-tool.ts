// The per-tool file option: an MCP tool whose answers the agent's own tool setting files (`mcp:<server>/<tool>: {file:
// {folder, show}}`, written by a package's `mcp[].file` at apply, or by the owner). The gateway writes each answer that
// is not an error, scrubbed and whole, at <folder>/<tool>-<time>-<id>.json in the run's files, and the model reads only
// a summary: how many bytes, where it is filed, the values of the paths `show` names, and the answer's shape (keys and
// types to depth 2, array lengths), never another value (mcp-gateway.ts forward). So a template whose tool answers hold
// what the model must not read (a customer's descriptions, say) hands its code the whole answer and its model the
// values it needs to go on (the next page's cursor). A show path that names a free-text field shows that text: the
// option holds only as far as its paths do.
import type { InputIssue } from "./errors.js";

/** A tool's file setting: the folder of the run's files its answers are filed in, and the paths of each answer the
 *  model reads. */
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

/** The issues of `given` as a file setting, its fields under `at`: none when it is one. */
export function fileIssues(given: unknown, at: string): InputIssue[] {
  if (!isPlain(given) || Object.keys(given).some((key) => key !== "folder" && key !== "show") || given.folder === undefined || given.show === undefined) {
    return [{ field: at, reason: "wrong_type", message: `${at} is {folder, show}: the folder of the run's files each answer of the tool is filed in, whole, and the paths of it the model reads (at most ${MAX_SHOW_PATHS}); the model reads no other value of it` }];
  }
  const issues: InputIssue[] = [];
  const folder = given.folder;
  const segments = typeof folder === "string" ? folder.split("/") : [];
  if (!(segments.length >= 1 && segments.length <= 3 && segments.every((segment) => FOLDER_SEGMENT.test(segment)))) issues.push({ field: `${at}.folder`, reason: "not_an_option", message: `${at}.folder is a folder in the run's files: ${FOLDER_WORDS}` });
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

/** The file setting of `server`'s `tool` in an agent's tool settings as its revision keeps them (body.toolSettings), when
 *  it has one that reads; else undefined (the tool answers the model as it always has). */
export function filedBy(toolSettings: unknown): (server: string, tool: string) => FileSetting | undefined {
  return (server, tool) => {
    const key = `mcp:${server}/${tool}`;
    const setting = isPlain(toolSettings) && Object.hasOwn(toolSettings, key) ? toolSettings[key] : undefined;
    const file = isPlain(setting) ? setting.file : undefined;
    if (file === undefined || fileIssues(file, "file").length) return undefined;
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

/** `value`'s shape: types, each array's length and what it holds, an object's keys while `depth` is under 2; never a
 *  value. */
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
    const named = keys.slice(0, SHAPE_KEYS).map((key) => `${JSON.stringify(key)}: ${shapeOf(value[key], depth + 1)}`);
    return `{${named.join(", ")}${keys.length > SHAPE_KEYS ? `, … ${keys.length - SHAPE_KEYS} more keys` : ""}}`;
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? typeof value : "unknown";
}

/** The model's text of an answer filed at `path` (in the run's files): its bytes, where it is, the values `show` names,
 *  and its shape. */
export function filedSummary(tool: string, text: string, path: string, show: readonly string[]): string {
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
    `${tool} answered ${Buffer.byteLength(text, "utf8").toLocaleString("en-US")} bytes, filed whole at ${path}. Its values are not shown here (the agent's setting files this tool's answers); only these are:`,
    shown,
    `Shape: ${shape.length > SHAPE_CHARS ? `${shape.slice(0, SHAPE_CHARS)}…` : shape}`,
  ].join("\n");
}

/** The model's text when an answer could not be filed: none of it, the Workspace's words why. */
export const unfiledSummary = (tool: string, text: string, folder: string, why: string): string =>
  `${tool} answered ${Buffer.byteLength(text, "utf8").toLocaleString("en-US")} bytes, which could not be filed in ${folder}/ (${why}). The agent's setting files this tool's answers, so none of it is shown here.`;
