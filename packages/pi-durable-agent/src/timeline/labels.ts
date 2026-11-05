import { cut, firstLine, json, list, obj, scrubUrls, str, where, type Obj } from "./util.js";

/** A tool result as a label sees it: its text blocks joined, its `details`, its error flag. */
export type ToolResultView = { text: string; details: unknown; isError: boolean };
export type LabelFn = (args: Obj, result?: ToolResultView) => string | undefined;
/** How calls of one tool fold into one line; `subject` names one call from its input and output previews. */
export type FoldSpec = {
  many: (count: number) => string;
  subject?: (input: string | null, output: string | null) => string | undefined;
  /** The input preview is the call's file path: a host's `path` option names it, as the call's own row does. */
  path?: boolean;
};

const labels = new Map<string, LabelFn>();
const folds = new Map<string, FoldSpec>();
const names = new Map<string, string>();

/** Registers the label of one tool, in the past tense, and with `name` what the tool is called where calls are counted
 *  (a run's analytics). A host adds its own tools here. */
export function registerLabel(tool: string, label: LabelFn, fold?: FoldSpec, { name }: { name?: string } = {}): void {
  labels.set(tool, label);
  if (fold) folds.set(tool, fold);
  if (name) names.set(tool, name);
}

/** What a tool is called where its calls are counted, in plain words: its registered name, else the name it was called by. */
export const nameOf = (tool: string): string => names.get(tool) ?? tool;

/** A finished call's outcome, when its own result says more than that the call returned: a tool that answers a refusal
 *  or a failure as its result, not as an error (a fetch's `{ok: false, refused}`), reads as refused or failed. */
export type OutcomeFn = (result: { text: string; isError: boolean }) => { failed: boolean; text: string } | undefined;
const outcomes = new Map<string, OutcomeFn>();

/** Registers how one tool's result tells its outcome. A host adds its own tools here. */
export function registerOutcome(tool: string, outcome: OutcomeFn): void {
  outcomes.set(tool, outcome);
}

/** The outcome of a call that returned (not one that errored), when its tool tells one. */
export const outcomeOf = (tool: string, result: { text: string; isError: boolean }) => (result.isError ? undefined : outcomes.get(tool)?.(result));

/** Whether a finished call failed: an error, or a result its tool's outcome reads as failed (a refused fetch). The one
 *  rule a call's row and a run's tool counts both read; `outcome` is the result's own (outcomeOf), so a caller that has
 *  read it already (a row, which also shows it) reads it once: a fetch's outcome parses its whole page. */
export const failedWith = (result: { isError: boolean }, outcome: ReturnType<OutcomeFn>): boolean => result.isError || outcome?.failed === true;

/** failedWith, the outcome read here. */
export const callFailed = (tool: string, result: { text: string; isError: boolean }): boolean => failedWith(result, outcomeOf(tool, result));

const turnEnding = new Set<string>();

/** Registers a tool that ends its turn (pi's `terminate`): what the person sends after a round of such tools is their
 *  next message, never a steer into a running turn. A host adds its own tools here. */
export function registerTurnEnding(tool: string): void {
  turnEnding.add(tool);
}

/** Whether `tool` ends its turn (registerTurnEnding). */
export const endsTurn = (tool: string): boolean => turnEnding.has(tool);

/** The label of a call; `result` is given once the call has finished. Unknown tools get Grep's own fallback. */
export function labelOf(tool: string, args: Obj, result?: ToolResultView, extra?: Record<string, LabelFn>): string {
  const own = extra && Object.hasOwn(extra, tool) ? extra[tool] : undefined;
  return (own ?? labels.get(tool))?.(args, result) ?? `Using tool: ${tool}`;
}

/** One line for several calls of one tool: `Read 4 pages: a.example, b.example, +2 more`. */
export function foldLabel(tool: string, calls: readonly { input: string | null; output: string | null }[], options: { path?: (path: string) => string } = {}): string {
  const spec = folds.get(tool);
  const head = spec ? spec.many(calls.length) : `Used ${tool} ${calls.length} times`;
  // A file path is named as the host names it (`path`), as the call's own row is; the preview itself stays the call's.
  const named = (input: string | null) => (input !== null && spec?.path && options.path ? options.path(input) : input);
  const subjects = calls.flatMap((call) => spec?.subject?.(named(call.input), call.output) ?? []);
  return subjects.length ? `${head}: ${list(subjects)}` : head;
}

/** The input worth showing: Grep's keys first, then the browser and file ones. */
export function inputPreview(args: Obj, max: number): string | null {
  for (const key of ["description", "command", "query", "file_path", "url", "path", "code"]) {
    const value = str(args[key]);
    if (value) return cut(scrubUrls(value), max);
  }
  return null;
}

/** Files a finished call put in the workspace. */
export function savedPaths(tool: string, args: Obj, result: ToolResultView): string[] {
  if (tool === "write" || tool === "edit") {
    const file = str(args.path) ?? str(args.file_path);
    return file ? [file] : [];
  }
  if (tool !== "browser_downloads") return [];
  const fetched = json(result.text)?.fetched;
  return Array.isArray(fetched) ? fetched.flatMap((file) => str(obj(file)?.path) ?? []) : [];
}

/** Tools that use the browser session; the first of them opens one. */
export const BROWSER_OPENERS: ReadonlySet<string> = new Set(["snapshot", "run", "screenshot", "browser_read", "browser_downloads"]);
/** Every tool of the browser (pi-browser's): the calls a browser charge with no call of its own may fold into. */
export const BROWSER_STEPS: ReadonlySet<string> = new Set([...BROWSER_OPENERS, "browser_release", "browser_relaunch", "browser_upload", "browser_request_handoff"]);

const path = (args: Obj) => str(args.path) ?? str(args.file_path);
const GOTO = /page\.goto\(\s*["'`]([^"'`]+)/;

registerLabel("read", (a) => `Read ${path(a) ?? "a file"}`, { many: (n) => `Read ${n} files`, subject: (input) => input ?? undefined, path: true }, { name: "Read files" });
registerLabel("write", (a) => `Wrote ${path(a) ?? "a file"}`, { many: (n) => `Wrote ${n} files`, subject: (input) => input ?? undefined, path: true }, { name: "Write files" });
registerLabel("edit", (a) => `Edited ${path(a) ?? "a file"}`, { many: (n) => `Edited ${n} files`, subject: (input) => input ?? undefined, path: true }, { name: "Edit files" });
registerLabel("bash", (a) => `Ran \`${cut(scrubUrls(firstLine(str(a.command) ?? "")), 60)}\``, { many: (n) => `Ran ${n} commands` }, { name: "Run commands" });
/** A fetch that answered its page as a result with `ok: false`: refused (the public-host guard said no, `refused`) or
 *  failed (`error`, or a message). Undefined for a page it fetched. The page is the result's JSON, or its first line's
 *  when a line for the model follows it (serve's web_fetch, saying why a picked Parallel gave no page). */
const unfetched = (result: { text: string } | undefined) => {
  const page = result && obj(json(result.text) ?? json(firstLine(result.text)));
  if (page?.ok !== false) return undefined;
  const refused = str(page.refused);
  return refused !== undefined ? { refused: true, detail: refused.replace(/^refused:\s*/, "") } : { refused: false, detail: str(page.error) ?? str(page.message) ?? "no detail" };
};
const fetchLabel: LabelFn = (a, result) => `${unfetched(result) ? "Tried to fetch" : "Fetched"} ${where(str(a.url) ?? "a page")}`;
const fetchFold: FoldSpec = { many: (n) => `Fetched ${n} pages`, subject: (input) => (input ? where(input) : undefined) };
const fetchOutcome: OutcomeFn = (result) => {
  const failure = unfetched(result);
  return failure && { failed: true, text: `${failure.refused ? "refused" : "failed"}: ${failure.detail}` };
};
// web_fetch and fetch_page answer the same page, `{ok, url, status, title, text, links, refused?, error?}`.
for (const tool of ["web_fetch", "fetch_page"]) {
  registerLabel(tool, fetchLabel, fetchFold, { name: "Fetch web pages" });
  registerOutcome(tool, fetchOutcome);
}
registerLabel("web_search", (a) => {
  const query = str(a.query);
  return query ? `Searched the web for "${cut(scrubUrls(query), 60)}"` : "Searched the web";
}, { many: (n) => `Searched the web ${n} times`, subject: (input) => (input ? `"${cut(input, 40)}"` : undefined) }, { name: "Search the web" });
// web_search answers its results and a line asking for citations, or `{error}` when the search gave no answer: failed.
registerOutcome("web_search", (result) => {
  const error = str(obj(json(result.text))?.error);
  return error !== undefined ? { failed: true, text: `failed: ${error}` } : undefined;
});
registerLabel(
  "browser_read",
  (_a, result) => {
    const title = result && /^title: (.+)$/m.exec(result.text)?.[1];
    return title ? `Read the page "${cut(scrubUrls(title), 60)}"` : "Read the page";
  },
  { many: (n) => `Read ${n} pages`, subject: (_input, output) => { const url = output && /^url: (\S+)/m.exec(output)?.[1]; return url ? where(url) : undefined; } },
  { name: "Read the browser's page" },
);
registerLabel("snapshot", () => "Looked at the page structure", { many: (n) => `Looked at the page structure ${n} times` }, { name: "Look at the page structure" });
registerLabel("screenshot", () => "Took a screenshot", { many: (n) => `Took ${n} screenshots` }, { name: "Take screenshots" });
registerLabel(
  "run",
  (a, result) => {
    const goto = GOTO.exec(str(a.code) ?? "")?.[1];
    if (goto) return `Opened ${where(goto)}`;
    const sent = obj(result?.details)?.sent;
    const requests = Array.isArray(sent)
      ? sent.flatMap((request) => { const r = obj(request); const [method, url] = [str(r?.method), str(r?.url)]; return method && url ? `${method} ${where(url)}` : []; })
      : [];
    return requests.length ? `Acted on the page (${requests.length} request${requests.length === 1 ? "" : "s"} sent: ${list(requests)})` : "Acted on the page";
  },
  { many: (n) => `Acted on the page ${n} times` },
  { name: "Open or act on a page in the browser" },
);
registerLabel(
  "browser_downloads",
  (_a, result) => {
    const fetched = result && json(result.text)?.fetched;
    const names = Array.isArray(fetched) ? fetched.flatMap((file) => str(obj(file)?.name) ?? []) : [];
    return names.length === 1 ? `Downloaded ${names[0]}` : names.length ? `Downloaded ${names.length} files` : "Downloaded files";
  },
  { many: (n) => `Downloaded files ${n} times` },
  { name: "Download files in the browser" },
);
registerLabel("browser_release", () => "Released the browser session", undefined, { name: "Release the browser session" });
registerLabel("browser_relaunch", () => "Started a fresh browser session", undefined, { name: "Start a fresh browser session" });
registerLabel("submit", () => "Submitted the answer", undefined, { name: "Submit the answer" });
registerLabel("codemode", () => "Ran a script", { many: (n) => `Ran ${n} scripts` }, { name: "Run scripts" });
registerLabel("request_sign_in", () => "Asked you to sign in", undefined, { name: "Ask you to sign in" });
