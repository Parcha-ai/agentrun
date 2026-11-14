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

/** A remote MCP server's tool as the harnesses name it, `mcp__<server>__<tool>` (a server's name has no `_`; `hands` is a
 *  harness's own tools'), read `<server> · <tool>`. */
const MCP_TOOL = /^mcp__([a-z][a-z0-9-]{0,31})__([A-Za-z0-9_-]{1,64})$/;
const mcpLabel = (tool: string): string | undefined => {
  const match = MCP_TOOL.exec(tool);
  return match && match[1] !== "hands" ? `${match[1]} · ${match[2]}` : undefined;
};

/** What a tool is called where its calls are counted, in plain words: its registered name, else the name it was called by. */
export const nameOf = (tool: string): string => names.get(tool) ?? mcpLabel(tool) ?? tool;

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
  return (own ?? labels.get(tool))?.(args, result) ?? mcpLabel(tool) ?? `Using tool: ${tool}`;
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

/** A call refused before it ran, in plain words: "Refused: " and the tool's name with what it would have acted on (the
 *  path it would have read or written, the command it would have run, the page it would have fetched), never a label's
 *  past tense ("Wrote deny.md"), which says it ran. Any tool: one with none of those reads as its name alone (an MCP
 *  server's tool as its server and name, "fake · send_message", as its label reads it). */
export function refusedLabel(tool: string, args: Obj): string {
  const command = str(args.command);
  const subject = path(args) ?? (str(args.url) ? where(str(args.url)!) : undefined) ?? (command ? `\`${cut(scrubUrls(firstLine(command)), 60)}\`` : undefined);
  return `Refused: ${mcpLabel(tool) ?? tool}${subject ? ` ${subject}` : ""}`;
}

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
// web_fetch answers a page, `{ok, url, status, title, text, links, refused?, error?}`.
registerLabel("web_fetch", fetchLabel, fetchFold, { name: "Fetch web pages" });
registerOutcome("web_fetch", fetchOutcome);
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

// A desktop's or a phone's tools (the computer surface's), as what the agent did there. An act's steps come from its
// arguments, and each element's name from its answer: the answer's step line names the element it acted on as the
// outline does (`2. press @e31 generic "Display": semantic, verified`, the surface's actWords). Before the answer is in,
// an element is "an element". Once it is in, only the steps that ran are said.

/** An act's answer, line by line: whether each step names its element, the element's name, whether it is secure, and
 *  the first refused step. */
const STEP_LINE = /^(\d+)\. [a-z_.]+(?: into)?(?: (@\S+) [a-z]+(?: ("(?:[^"\\]|\\.)*"))?)?( \[secure\])?: (.*)$/;
type ActLine = { element: boolean; name?: string; secure: boolean; refused?: string };
/** A name in JSON's quotes, as the outline writes it. */
const unquote = (quoted: string | undefined): string | undefined => {
  if (quoted === undefined) return undefined;
  try {
    return str(JSON.parse(quoted));
  } catch {
    return undefined;
  }
};
function actLines(text: string | undefined): Map<number, ActLine> {
  const lines = new Map<number, ActLine>();
  for (const line of (text ?? "").split("\n")) {
    const match = STEP_LINE.exec(line);
    if (!match) continue;
    const name = unquote(match[3]);
    const refused = /^refused \([^)]*\): (.*)$/.exec(match[5]!)?.[1];
    lines.set(Number(match[1]), { element: match[2] !== undefined, ...(name ? { name } : {}), secure: match[4] !== undefined, ...(refused !== undefined ? { refused } : {}) });
  }
  return lines;
}

/** A text the agent typed or set, as a label shows it: whole, or only its length (never cut, so the timeline's
 *  redactor, which matches a held value whole, never misses a piece of one). */
const TEXT_SHOWN = 40;
const typed = (text: string) => (text.length <= TEXT_SHOWN && !/[\r\n]/.test(text) ? `“${text}”` : `${text.length} characters`);
const keyWords = (chord: string) => chord.split(/\+(?=.)/).filter((key) => key !== "").map((key) => key[0]!.toUpperCase() + key.slice(1)).join("+");

/** A step in words: as done (`did`), and as tried for one the computer refused (`tried`). */
type Said = { did: string; tried: string };
const said = (did: string, act: string, rest = ""): Said => ({ did: `${did}${rest}`, tried: `Could not ${act}${rest}` });
const NAV: Readonly<Record<string, [string, string]>> = { back: ["Went", "go"], home: ["Went", "go"], app_switch: ["Opened", "open"] };
const NAV_WHERE: Readonly<Record<string, string>> = { back: " back", home: " home", app_switch: " the recent apps" };

/** One step in words, its element named by `line` (the answer's) when it has one. A typed or set text shows only once
 *  the answer's line names the field it went to and says it was no secure field: never while the call runs, for a step
 *  that did not run, or for a type whose field is unknown. */
function stepSaid(step: Obj, line: ActLine | undefined): Said {
  const element = line?.name ? `“${line.name}”` : "an element";
  const secure = line === undefined || !line.element || line.secure;
  const point = (at: unknown) => (Array.isArray(at) && at.length === 2 ? `at ${at.map((n) => Math.round(Number(n))).join(", ")}` : element);
  if ("press" in step) return said("Pressed", "press", ` ${element}`);
  if ("set" in step) {
    const value = str(step.value);
    return said("Set", "set", secure || value === undefined ? ` ${element}` : value.length <= TEXT_SHOWN ? ` ${element} to ${typed(value)}` : ` ${element} (${value.length} characters)`);
  }
  if ("perform" in step) return said("Did", "do", ` ${str(step.action) ?? "an action"} on ${element}`);
  if ("click" in step) {
    const [did, act] = step.button === "right" ? ["Right-clicked", "right-click"] : step.count === 2 ? ["Double-clicked", "double-click"] : step.count === 3 ? ["Triple-clicked", "triple-click"] : ["Clicked", "click"];
    return said(did, act, ` ${point(step.click)}`);
  }
  if ("type" in step) {
    // The field it went to: the one it named, else the focused one, as its line names it; before the answer, the one it named.
    const into = (line ? line.element : step.into !== undefined) ? ` into ${element}` : "";
    return said("Typed", "type", secure ? (into || " text") : ` ${typed(str(step.type) ?? "")}${into}`);
  }
  if ("key" in step) return said("Pressed", "press", ` ${keyWords(str(step.key) ?? "a key")}`);
  if ("nav" in step) {
    const nav = str(step.nav) ?? "";
    const [did, act] = NAV[nav] ?? ["Navigated", "navigate"];
    return said(did, act, NAV_WHERE[nav] ?? "");
  }
  if ("scroll" in step) {
    const [dx, dy] = [Number(step.dx ?? 0), Number(step.dy ?? 0)];
    const way = dy > 0 ? "down" : dy < 0 ? "up" : dx > 0 ? "right" : dx < 0 ? "left" : "";
    return said("Scrolled", "scroll", [...(line?.name ? [element] : []), ...(way ? [way] : [])].map((part) => ` ${part}`).join(""));
  }
  if ("drag" in step) return said("Dragged", "drag", " across the screen");
  return said("Acted", "act");
}

/** At most this many steps are said; the rest are counted. */
const STEPS_SAID = 3;
const lower = (said: string) => said[0]!.toLowerCase() + said.slice(1);

registerLabel(
  "computer_act",
  (a, result) => {
    const steps: Obj[] = Array.isArray(a.steps) ? (a.steps as unknown[]).flatMap((step): Obj[] => { const given = obj(step); return given ? [given] : []; }) : [];
    const expect = obj(a.expect);
    if (steps.length === 0) {
      const text = str(expect?.text);
      return text !== undefined ? `Waited for ${expect?.gone === true ? "no more " : ""}${typed(text)}` : "Acted on the computer";
    }
    // While the call runs, the steps asked for; once its answer is in, the steps that ran (each has its line), a refused
    // one as tried. An answer with no step line (the call failed) ran none that is known: its first step was tried.
    const lines = result === undefined ? undefined : actLines(result.text);
    const ran = lines === undefined ? steps : steps.filter((_, index) => lines.has(index + 1));
    if (ran.length === 0) return stepSaid(steps[0]!, undefined).tried;
    const words = ran.slice(0, STEPS_SAID).map((step, index) => {
      const line = lines?.get(index + 1);
      const told = stepSaid(step, line);
      return line?.refused !== undefined ? told.tried : told.did;
    });
    const more = ran.length - words.length;
    return [words[0]!, ...words.slice(1).map(lower), ...(more > 0 ? [`+${more} more`] : [])].join(", ");
  },
  { many: (n) => `Acted on the computer ${n} times` },
  { name: "Act on the computer" },
);
// A step the computer refused ends the act there, the answer still a result: the act did not do what it was asked.
registerOutcome("computer_act", (result) => {
  for (const [index, line] of actLines(result.text)) if (line.refused !== undefined) return { failed: true, text: `step ${index} refused: ${line.refused}` };
  return undefined;
});

/** An observation's head: `state s8 · com.android.settings "Settings" · window "Display" 360×640 pt`. */
const OBSERVED = /^state \S+ · \S+(?: ("(?:[^"\\]|\\.)*"))? · window(?: ("(?:[^"\\]|\\.)*"))? /;
registerLabel(
  "computer_observe",
  (_a, result) => {
    const head = result && OBSERVED.exec(result.text);
    const [app, window] = [unquote(head?.[1]), unquote(head?.[2])];
    if (window && app && window !== app) return `Looked at ${window} in ${app}`;
    return window || app ? `Looked at ${window || app}` : "Looked at the screen";
  },
  { many: (n) => `Looked at the screen ${n} times` },
  { name: "Look at the computer" },
);
registerLabel("computer_screenshot", () => "Took a screenshot", { many: (n) => `Took ${n} screenshots` }, { name: "Take screenshots of the computer" });
registerLabel(
  "computer_script",
  (a) => {
    const title = str(a.title)?.replace(/\s+/g, " ").trim();
    return title ? cut(title, 120) : "Ran a script on the computer";
  },
  { many: (n) => `Ran ${n} scripts on the computer` },
  { name: "Run scripts on the computer" },
);
