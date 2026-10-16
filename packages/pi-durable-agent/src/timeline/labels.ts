import { cut, firstLine, json, list, obj, scrubUrls, str, where, type Obj } from "./util.js";

/** A tool result as a label sees it: its text blocks joined, its `details`, its error flag. */
export type ToolResultView = { text: string; details: unknown; isError: boolean };
export type LabelFn = (args: Obj, result?: ToolResultView) => string | undefined;
/** How calls of one tool fold into one line; `subject` names one call from its input and output previews. */
export type FoldSpec = {
  many: (count: number) => string;
  subject?: (input: string | null, output: string | null) => string | undefined;
};

const labels = new Map<string, LabelFn>();
const folds = new Map<string, FoldSpec>();

/** Registers the label of one tool, in the past tense. A host adds its own tools here. */
export function registerLabel(tool: string, label: LabelFn, fold?: FoldSpec): void {
  labels.set(tool, label);
  if (fold) folds.set(tool, fold);
}

/** The label of a call; `result` is given once the call has finished. Unknown tools get Grep's own fallback. */
export function labelOf(tool: string, args: Obj, result?: ToolResultView, extra?: Record<string, LabelFn>): string {
  const own = extra && Object.hasOwn(extra, tool) ? extra[tool] : undefined;
  return (own ?? labels.get(tool))?.(args, result) ?? `Using tool: ${tool}`;
}

/** One line for several calls of one tool: `Read 4 pages: a.example, b.example, +2 more`. */
export function foldLabel(tool: string, calls: readonly { input: string | null; output: string | null }[]): string {
  const spec = folds.get(tool);
  const head = spec ? spec.many(calls.length) : `Used ${tool} ${calls.length} times`;
  const subjects = calls.flatMap((call) => spec?.subject?.(call.input, call.output) ?? []);
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

const path = (args: Obj) => str(args.path) ?? str(args.file_path);
const GOTO = /page\.goto\(\s*["'`]([^"'`]+)/;

registerLabel("read", (a) => `Read ${path(a) ?? "a file"}`, { many: (n) => `Read ${n} files`, subject: (input) => input ?? undefined });
registerLabel("write", (a) => `Wrote ${path(a) ?? "a file"}`, { many: (n) => `Wrote ${n} files`, subject: (input) => input ?? undefined });
registerLabel("edit", (a) => `Edited ${path(a) ?? "a file"}`, { many: (n) => `Edited ${n} files`, subject: (input) => input ?? undefined });
registerLabel("bash", (a) => `Ran \`${cut(scrubUrls(firstLine(str(a.command) ?? "")), 60)}\``, { many: (n) => `Ran ${n} commands` });
registerLabel("web_fetch", (a) => `Fetched ${where(str(a.url) ?? "a page")}`, {
  many: (n) => `Fetched ${n} pages`,
  subject: (input) => (input ? where(input) : undefined),
});
registerLabel(
  "browser_read",
  (_a, result) => {
    const title = result && /^title: (.+)$/m.exec(result.text)?.[1];
    return title ? `Read the page "${cut(scrubUrls(title), 60)}"` : "Read the page";
  },
  { many: (n) => `Read ${n} pages`, subject: (_input, output) => { const url = output && /^url: (\S+)/m.exec(output)?.[1]; return url ? where(url) : undefined; } },
);
registerLabel("snapshot", () => "Looked at the page structure", { many: (n) => `Looked at the page structure ${n} times` });
registerLabel("screenshot", () => "Took a screenshot", { many: (n) => `Took ${n} screenshots` });
registerLabel(
  "run",
  (a, result) => {
    const goto = GOTO.exec(str(a.code) ?? "")?.[1];
    if (goto) return `Opened ${where(goto)}`;
    const sent = obj(result?.details)?.sent;
    const requests = Array.isArray(sent)
      ? sent.flatMap((request) => { const r = obj(request); return str(r?.method) && str(r?.url) ? `${r!.method} ${where(r!.url as string)}` : []; })
      : [];
    return requests.length ? `Acted on the page (${requests.length} request${requests.length === 1 ? "" : "s"} sent: ${list(requests)})` : "Acted on the page";
  },
  { many: (n) => `Acted on the page ${n} times` },
);
registerLabel(
  "browser_downloads",
  (_a, result) => {
    const fetched = result && json(result.text)?.fetched;
    const names = Array.isArray(fetched) ? fetched.flatMap((file) => str(obj(file)?.name) ?? []) : [];
    return names.length === 1 ? `Downloaded ${names[0]}` : names.length ? `Downloaded ${names.length} files` : "Downloaded files";
  },
  { many: (n) => `Downloaded files ${n} times` },
);
registerLabel("browser_release", () => "Released the browser session");
registerLabel("browser_relaunch", () => "Started a fresh browser session");
registerLabel("submit", () => "Submitted the answer");
registerLabel("codemode", () => "Ran a script", { many: (n) => `Ran ${n} scripts` });
registerLabel("request_sign_in", () => "Asked you to sign in");
