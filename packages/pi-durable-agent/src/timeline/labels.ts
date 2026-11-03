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
 *  or a failure as its result, not as an error (a fetch's `{ok: false, refused}`), reads as refused or failed.
 *  - `text`: the one-line result after the call's label (`<label>: <text>`, or `<label><sep><text>` with `sep`); `line`:
 *    the whole line instead, when the result says the action better than the label does ("Found 3 monid endpoints for …").
 *  - `missing`: the call found nothing, as a probe can (a search with no results): quiet, never an error.
 *  - `preview`: the result as a person reads it, in place of its text. */
export type Outcome = { failed: boolean; text?: string; sep?: string; line?: string; missing?: boolean; preview?: string };
export type OutcomeFn = (result: { text: string; details?: unknown; isError: boolean }) => Outcome | undefined;
const outcomes = new Map<string, { outcome: OutcomeFn; errors: boolean }>();

/** Registers how one tool's result tells its outcome. With `errors`, an error result is read too, so the row says the
 *  error in the tool's own words; it fails whatever the outcome says. A host adds its own tools here. */
export function registerOutcome(tool: string, outcome: OutcomeFn, { errors = false }: { errors?: boolean } = {}): void {
  outcomes.set(tool, { outcome, errors });
}

/** The outcome of a finished call, when its tool tells one: of a call that returned, or of one that errored when its
 *  tool reads errors too. */
export const outcomeOf = (tool: string, result: { text: string; details?: unknown; isError: boolean }): Outcome | undefined => {
  const own = outcomes.get(tool);
  return own && (!result.isError || own.errors) ? own.outcome(result) : undefined;
};

/** Whether a finished call failed: an error, or a result its tool's outcome reads as failed (a refused fetch). The one
 *  rule a call's row and a run's tool counts both read; `outcome` is the result's own (outcomeOf), so a caller that has
 *  read it already (a row, which also shows it) reads it once: a fetch's outcome parses its whole page. */
export const failedWith = (result: { isError: boolean }, outcome: Outcome | undefined): boolean => result.isError || outcome?.failed === true;

/** failedWith, the outcome read here. */
export const callFailed = (tool: string, result: { text: string; details?: unknown; isError: boolean }): boolean => failedWith(result, outcomeOf(tool, result));

const turnEnding = new Set<string>();

/** Registers a tool that ends its turn (pi's `terminate`): what the person sends after a round of such tools is their
 *  next message, never a steer into a running turn. A host adds its own tools here. */
export function registerTurnEnding(tool: string): void {
  turnEnding.add(tool);
}

/** Whether `tool` ends its turn (registerTurnEnding). */
export const endsTurn = (tool: string): boolean => turnEnding.has(tool);

/** The label of a call; `result` is given once the call has finished. A tool with no label reads "Used <tool>". */
export function labelOf(tool: string, args: Obj, result?: ToolResultView, extra?: Record<string, LabelFn>): string {
  const own = extra && Object.hasOwn(extra, tool) ? extra[tool] : undefined;
  return (own ?? labels.get(tool))?.(args, result) ?? `Used ${tool}`;
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

registerLabel("read", (a) => `Read ${path(a) ?? "a file"}`, { many: (n) => `Read ${n} files`, subject: (input) => input ?? undefined }, { name: "Read files" });
registerLabel("write", (a) => `Wrote ${path(a) ?? "a file"}`, { many: (n) => `Wrote ${n} files`, subject: (input) => input ?? undefined }, { name: "Write files" });
registerLabel("edit", (a) => `Edited ${path(a) ?? "a file"}`, { many: (n) => `Edited ${n} files`, subject: (input) => input ?? undefined }, { name: "Edit files" });
registerLabel("bash", (a) => `Ran \`${cut(scrubUrls(firstLine(str(a.command) ?? "")), 60)}\``, { many: (n) => `Ran ${n} commands` }, { name: "Run commands" });
/** Thousands with commas: 312,450. */
const counted = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const plural = (n: number, word: string) => `${counted(n)} ${word}${n === 1 ? "" : "s"}`;
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
/** A dollar amount as a row says it: cents when it is whole cents, else four places. */
const usd = (amount: number) => `$${amount >= 0.01 && Math.round(amount * 100) === amount * 100 ? amount.toFixed(2) : amount.toFixed(4)}`;
/** A result's JSON object: its `details` when the tool gave them, else its text's first line (a search's answer ends with
 *  a line for the model). */
const answerOf = (result: { text: string; details?: unknown }) => obj(result.details) ?? json(result.text) ?? json(result.text.split("\n")[0] ?? "");
/** A URL's host, without `www.`. */
const domainOf = (url: string) => /^[a-z]+:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url)?.[1]?.toLowerCase().replace(/^www\./, "");

// web_fetch and fetch_page answer the same page, `{ok, url, status, title, text, links, refused?, error?}`, web_fetch with
// `via` and, where it gives them, `chars`, `truncated` and `original_chars`.
const REASONS: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 408: "Request Timeout", 410: "Gone", 429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };
const pageOf = (url: unknown) => cut(where(str(url) ?? "a page"), 48);
const fetchLabel: LabelFn = (a, result) => `${result ? "Read" : "Reading"} ${pageOf(a.url)}`;
const fetchFold: FoldSpec = { many: (n) => `Read ${n} pages`, subject: (input) => (input ? where(input) : undefined) };
/** A page's outcome: why it was not read (refused by the guard, an HTTP error, a timeout), or its title and the size of
 *  the text kept, and the path that served it. */
const fetchOutcome: OutcomeFn = (result) => {
  const page = answerOf(result);
  if (!page || typeof page.ok !== "boolean") return undefined;
  if (page.ok === false) {
    const refused = str(page.refused);
    if (refused !== undefined) return { failed: true, text: `refused, ${refused.replace(/^refused:\s*/, "")}` };
    const error = str(page.error) ?? str(page.message) ?? "no detail";
    const ms = /^timed out after (\d+) ms$/.exec(error)?.[1];
    return { failed: true, text: ms ? `timed out after ${Math.round(Number(ms) / 1000)} s` : `failed, ${error}` };
  }
  const status = num(page.status) ?? 200;
  if (status >= 400) return { failed: true, text: `${status} ${REASONS[status] ?? ""}`.trim() };
  const text = str(page.text) ?? "";
  const chars = num(page.chars) ?? text.length;
  const original = num(page.original_chars);
  const size = page.truncated === true && original !== undefined ? `first ${counted(chars)} of ${counted(original)} characters` : chars < 1000 ? plural(chars, "character") : `${Math.round(chars / 1024)} KB`;
  const title = str(page.title)?.trim();
  return { failed: false, text: `${title ? `"${cut(title, 60)}" · ` : ""}${size}${page.via === "parallel" ? " · via Parallel" : ""}` };
};
for (const tool of ["web_fetch", "fetch_page"]) {
  registerLabel(tool, fetchLabel, fetchFold, { name: "Fetch web pages" });
  registerOutcome(tool, fetchOutcome);
}

// web_search answers one normalized result on every provider, `{provider, via?, query, results?, error?, cost_usd?}`: a host's search tools answer it, and Claude's and Codex's own searches are mapped to it before the
// timeline reads them (provider "native", via the harness).
const PROVIDERS: Record<string, string> = { "exa-keyless": "Exa keyless", parallel: "Parallel" };
const NATIVE: Record<string, string> = { claude: "Claude", codex: "Codex", anthropic: "Anthropic", openai: "OpenAI" };
const providerOf = (answer: Obj) => (answer.provider === "native" ? (NATIVE[str(answer.via) ?? ""] ?? "the model's own search") : (PROVIDERS[str(answer.provider) ?? ""] ?? str(answer.provider) ?? "the search"));
/** A search's outcome: how many sources and from where, a quiet nothing found, the query alone when its provider reports
 *  no results, or why it failed in our words; its preview lists each result. */
const searchOutcome: OutcomeFn = (result) => {
  const answer = answerOf(result);
  if (!answer) return undefined;
  if (result.isError || answer.error !== undefined) {
    const error = firstLine(str(answer.error) ?? result.text);
    return { failed: true, text: /rate-limited|\(429\)/.test(error) ? "free search is rate-limited, add a Parallel key in Settings → Tool keys" : `failed, ${cut(error, 120)}` };
  }
  const provider = providerOf(answer);
  const cost = num(answer.cost_usd);
  const paid = cost ? ` · ${usd(cost)}` : "";
  if (!Array.isArray(answer.results)) return answer.provider === "native" ? { failed: false, sep: " · ", text: `${provider}'s own search${paid}` } : undefined;
  const hits = answer.results.flatMap((hit) => (obj(hit) ? [obj(hit)!] : []));
  if (hits.length === 0) return { failed: false, missing: true, text: `no results · ${provider}${paid}` };
  const domains = [...new Set(hits.flatMap((hit) => domainOf(str(hit.url) ?? "") ?? []))].slice(0, 3);
  const preview = [
    ...hits.map((hit, i) => {
      const url = str(hit.url) ?? "";
      // One line of its snippet: the preview is capped (CAPS.preview), and more results beat more of one.
      const snippet = firstLine(str(hit.snippet) ?? "");
      return [`${i + 1}. ${str(hit.title)?.trim() || url} — ${domainOf(url) ?? url}`, ...(snippet ? [cut(snippet, 120)] : []), url].join("\n");
    }),
    `Provider: ${provider}${paid}`,
  ].join("\n");
  return { failed: false, text: `${plural(hits.length, "source")} · ${domains.join(", ")} · ${provider}${paid}`, preview };
};
registerLabel("web_search", (a, result) => {
  const query = str(a.query);
  const verb = result ? "Searched" : "Searching";
  return query ? `${verb} the web for "${cut(scrubUrls(query), 60)}"` : `${verb} the web`;
}, { many: (n) => `Searched the web ${n} times`, subject: (input) => (input ? `"${cut(input, 40)}"` : undefined) }, { name: "Search the web" });
registerOutcome("web_search", searchOutcome, { errors: true });
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
