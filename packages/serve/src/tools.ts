// The tools a revision may name here: one closed table. Each entry is how the run's process binds the name and which
// environment variables it needs. A name outside the table cannot be named, and nothing is loaded from anywhere else.
// The file tools and `bash` bind from the run's coding source (coding-tools.ts): on the runner, pi's coding tools
// without `bash`, so a run gets no shell on this machine; in a box, pi's four and the background tools (bash_background,
// bash_output, bash_input, bash_signal, bash_list), each call made in the box. `bash` and the background tools may be
// named only by an agent whose place is a box (runnable.ts).
import { blurbOf } from "./tool-blurbs.js";
import type { TSchema } from "typebox";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineExtension, defineTool, type Extension, type Harness, ROOT_CONVERSATION_ID, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { AppContext } from "@parcha/pi-durable-disk";
import type { Revision } from "@parcha/pi-durable-agent";
import { registerTurnEnding } from "@parcha/pi-durable-agent/timeline";
import { BACKGROUND_LOG_BYTES, BACKGROUND_MAX, BACKGROUND_PAGE_BYTES } from "./background.js";
import type { CodingSource } from "./coding-tools.js";
import { isWorkspaceError, localWorkspace, type Workspace } from "./workspace/index.js";
import { fetchOptions, HTML_READ_CHARS, TEXT_CAP } from "./web-fetch-direct.js";
import { DEFAULT_HARNESS, HARNESSES } from "./harness.js";
import { REPLAY } from "./host-tools.js";
import { type Complete, LLM_TOOL } from "./llm.js";
import { DOCUMENTS_ENV, PDF_PAGES_TOOL, pdfPages } from "./pdf-pages.js";
import { monidTool } from "./monid.js";
import { FAUX_ENV, workflowNodes } from "./model.js";
import { bookedIn, booking, type Ledger, type PaidBooking } from "./paid-calls.js";
import type { Refusal } from "@parcha/agentrun-kernel";
import { browserPrice, browserSpend } from "./browser-cost.js";
import { forModel } from "./result.js";
import { fetchFor, pagesOf, WEB_FETCH_TOOL, webFetchTool } from "./web-fetch.js";
import { searchFor, WEB_SEARCH_TOOL, webSearchTool } from "./web-search.js";
import { browserNeeds, explainsView, isUnavailable, NO_PARALLEL_KEY, type Pickable, PICKABLE, planeOf, type Plane, PROVIDERS, serverGate, type Tooling, type ToolSettingsMap, whyUnavailable, withDefaults } from "./tool-plane.js";
import type { DenyFrom, SettingFrom } from "./tool-gate.js";
import { fauxFetch, PARALLEL_KEY_ENV } from "./decisions.js";
import { keyNeeded } from "./key-words.js";
import { handedSignIn, hostSecrets } from "./secrets.js";
import { redactedAnswer } from "./key-refusal.js";
import { SIGN_IN_KEY, SIGN_IN_SAVED, vendorsOver } from "./sign-ins.js";
import { answerIn, answerOnce } from "./runner/hand-back.js";
import { runnerSecrets } from "./runner/redact.js";
import { HANDOVER_WAITING, type HandoverAnswered } from "./runner/journal-kinds.js";
import type { LiveHandover, LiveViewerStore } from "./browser-live.js";
import type { Claim, Store } from "./store/store.js";
import { type RunSignIn, runSignIn, verifyRunSignIn } from "./sign-ins-store.js";

export const ASK_TOOL = "ask_person";
/** Under `--faux` only: a module whose default export gives the browser's `{ provider, driver }` for the run's
 *  environment, the vendor its plane names (`browserbase`, `kernel`) and the saved sign-in it was handed for that
 *  vendor (`{ provider, ref, save }`, or undefined), in place of that vendor's (the tests' fake backend). */
export const FAUX_BROWSER_ENV = "AGENTRUN_SERVE_FAUX_BROWSER";
/** Under `--faux` only: a module whose default export is the fetch a run's first saved sign-in is made with on the runner,
 *  in place of the browser vendors' REST APIs (the tests' fake). Absent under --faux, none is made: no network. */
export const FAUX_VENDOR_API_ENV = "AGENTRUN_SERVE_FAUX_VENDOR_API";

/** What the result of `ask_person` says; the person's page shows the question as a waiting row. */
export const asked = (question: string) => `Asked the person: ${question.slice(0, 500)}. Waiting for their answer.`;

export const askPerson = defineTool({
  name: ASK_TOOL,
  description: "Ask the person who started this run a question you cannot answer yourself. Call it alone. It ends your turn; the person's reply comes as their next message.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { question: { type: "string", minLength: 1, description: "The question, in one or two plain sentences." } },
    required: ["question"],
  } as unknown as TSchema,
  replay: "safe",
  execute: async (args) => {
    const { question } = args as { question: string };
    return forModel(asked(question), { details: { question }, control: { terminate: true } });
  },
});
// ask_person ends its turn (control.terminate), so the run waits on the person after it. Registered here, where the tool
// is defined, so every reader of it agrees: the view reads a question row by this (run-view withAsks), and the runner's
// loop parks on it or waits on it in its claim (adapter-loop endedOnTurnEndingTool), whichever module loads — the loop
// never imports the view.
registerTurnEnding(ASK_TOOL);

/** What a tool's binding gets from the run's process. */
export type ToolHost = {
  where: AppContext;
  /** The run's environment: the server's, without the server's token. */
  env: NodeJS.ProcessEnv;
  /** The run's coding tools, by its place (coding-tools.ts codingSource). */
  coding: CodingSource;
  /** Installs an extension in the run's registry, before the run opens. */
  install(extension: Extension): void;
  /** Runs in the commit that creates each of the run's conversations. */
  onConversation(write: (tx: Tx, conversationId: number) => void | Promise<void>): void;
  /** Runs once the run's Harness is open, before anything in it resumes. */
  beforeResume(settle: (harness: Harness) => void | Promise<void>): void;
  /** Runs when the run's process lets the run go (its work done, or a SIGTERM), while the Harness is still open. */
  beforeRelease(stop: (harness: Harness) => void | Promise<void>): void;
  /** On the runner: asked when the run's turn ends on its question to the person (ask_person, call `callId`), before the
   *  run parks. A binding that keeps something open the person may still use while they answer holds the person's time for
   *  it and answers a hold, and the run waits in its claim instead (adapter-loop.ts HostLifecycle.personWait); `lapsed`
   *  settles, in words, when the hold can no longer stand, and the run parks then. `since`: when the wait first started
   *  (its bound runs from then, across claims). Undefined: nothing to keep. Absent on
   *  the old per-run process, whose wait keeps the process (and so the browser) anyway. */
  personWait?(hold: (harness: Harness, callId: string, since: number) => Promise<{ readonly lapsed: Promise<string>; drop(): void } | undefined>): void;
  /** On the runner: stages the run row's `summary` on the next commit that writes a root entry of `kind` whose data `test`
   *  takes (adapter-loop AdapterRun.rowSummaryOn): a hand-over's wait sets the row's waiting summary in its waiting
   *  entry's commit, and its answer's commit clears it, so the server tells run.needs_input for a run held in its claim. */
  rowSummaryOn?(kind: string, test: (data: Record<string, unknown>) => boolean, summary: string | null): void;
  /** The run is on the runner: its browser hand-over's answers are entries of its journal (a browser_hand_back row the
   *  runner applies, the live view's hand-back, the ask's expiry), read and written there, never as answer files
   *  (browser-person.ts personHands `answered`). */
  handoverInJournal?: boolean;
  /** The run is on the runner: its live viewers are handed over through the store, not through files in its directory
   *  (browser-live.ts putLiveViewer/dropLiveViewer). The browser tool's live-viewer writers hang off this: `put` hands a
   *  session's viewer over (its token sealed under the run's `sealKey`), `drop` takes one (or all of the run's) back. The
   *  three fields below are what builds these (the one store, the claim the row is written under, the seal key); a tool's
   *  binding reads `liveViewers`, never them directly. Absent on the server path, where the viewer lives in the run's
   *  directory (browser-live.ts sessionHandovers: writeHandover/dropHandover). */
  liveViewers?: { put(handover: LiveHandover): Promise<boolean>; drop(tag?: string): Promise<void> };
  /** The one store, for the live-viewer seam above, the run's saved sign-in (its runs and sign-ins, read under `claim`)
   *  and the sign-in verify the runner saves. */
  store?: LiveViewerStore & Pick<Store, "runs" | "signIns">;
  /** The claim this run is held under: the live-viewer rows are written under it (its epoch fences them), and the run's
   *  saved sign-in is read and its hand kept under it. Present, the run is on the runner: never the process's own pipe. */
  claim?: Claim;
  /** The key the live-viewer tokens are sealed under before they go to the store (store/seal.ts). */
  sealKey?: Buffer;
  /** The run's ledger, as the adapter loop hands it (spendcap-1's AdapterRun.ledger): `paid`, the claim's one-ledger
   *  booking (the kernel cap's paidCalls, paid-calls.ts PaidBooking), and `pause`, how a refusal at the cap parks the run.
   *  The browser passes `paid` to browserSpend, so its calls are held and settled there and a session's release is booked
   *  there, never on this process's own spend. The runner installs the browser only with `paid` and the grant, on pi's
   *  native route (adapter-run-spec.ts browserListed). */
  ledger?: { paid: PaidBooking; pause?: (refusal: Refusal) => Promise<void> };
  /** The run's one redactor (the runner's: every secret value the runner and the claim hold, in every form): what the
   *  browser's answers pass through before pi stores them or the model reads them. Absent on the old per-run process. */
  redact?: (text: string) => string;
  /** The run's own Workspace (on the runner: the run's local folder in Mode 1, its folder on the run's disk in Mode 2),
   *  where a tool files what the run's read finds later (monid's whole answer past the model's cut). Absent, the local
   *  folder at `where.work`. */
  workspace?: Workspace;
};

/** What a name stands for in the run: the pi tools it offers, and the extensions a conversation selects for them. */
export type ToolBinding = { tools: readonly ToolRegistration[]; extensions: readonly Extension[] };

/** `tool` alone in an extension named `name`, installed in the run's registry. */
function installTool(host: Pick<ToolHost, "install">, name: string, tool: ToolRegistration): ToolBinding {
  const extension = defineExtension({ name, tools: [tool] });
  host.install(extension);
  return { tools: [tool], extensions: [extension] };
}

/** What a call node's effect gets from the run's process: its signal, environment and work directory, one completion
 *  on the run's models (the `llm` tool's), and the ledger its paid requests are booked in (paid-calls.ts). */
export type EffectRun = { signal: AbortSignal; env: NodeJS.ProcessEnv; work: string; complete?: Complete; ledger?: Ledger };

export type ToolEntry = {
  /** One line, for capabilities. */
  summary: string;
  /** The environment variables it needs, by name. */
  needs: readonly string[];
  /** Whether a workflow's model node may name it. */
  nodes: boolean;
  /** What the name stands for, bound in the run's process once. */
  bind(host: ToolHost): Promise<ToolBinding>;
  /** What a workflow's `call` node `via: "tool"` naming it runs: its interpolated `args` in, the value its `out` schema
   *  checks out. Absent, no call node may name it. */
  effect?(args: Record<string, unknown>, run: EffectRun): Promise<unknown>;
  /** Only a workflow's call node runs it: no agent and no model node may name it. */
  callOnly?: true;
  /** Only an agent whose place is a sandbox may name it: it runs in the box (runnable.ts). */
  sandboxOnly?: true;
  /** No agent whose place is a sandbox may name it: it writes the run's work/ from this machine by paths a box's command
   *  could turn through a link (runnable.ts). */
  runnerOnly?: true;
};

const callOnly = (summary: string, effect: NonNullable<ToolEntry["effect"]>): ToolEntry => ({
  summary, needs: [], nodes: false, callOnly: true, effect,
  bind: async () => { throw new Error("a call-only tool binds no agent tool"); },
});

/** web_fetch, bound under `name`. */
const webFetchEntry = (name: string): ToolEntry => ({
  summary: `Read one public web page from a public host through the guarded direct fetch, or through Parallel's extract where Parallel is picked (falling back to the direct fetch, saying why, when Parallel answers no page), a part at a time (offset, max_chars; the page fetched once a run): { ok, url, status, title, text, chars, truncated?, original_chars?, beyond_read?, offset?, next_offset?, html_chars?, converted?, links, links_omitted?, via, parallel?, refused?, error? }; html_chars, the page's whole length, when its HTML was cut at ${HTML_READ_CHARS.toLocaleString("en-US")} characters before it was read, so its text is only the start of the page; converted: "text" when the text is plain text, its conversion to markdown having run out of time; a private or local address, a port other than 80 or 443, or a scheme other than http(s) is refused, never sent to Parallel.`,
  needs: [],
  nodes: true,
  bind: async (host) => {
    const tool = booking(webFetchTool(host.env, name)) as unknown as ToolRegistration;
    const extension = defineExtension({ name: name.replaceAll("_", "-"), tools: [tool] });
    host.install(extension);
    return { tools: [tool], extensions: [extension] };
  },
  // A call node's Page is the workflow's, not a model's context: it reads the most of a part by default, from the page
  // the run read (pagesOf(run.env)) where it holds the URL. Its request to Parallel, when it makes one, is booked under the call
  // (paid-calls.ts); a part from what the run read makes none and books nothing.
  effect: async (args, run) => bookedIn(run.ledger, async () => fetchFor(run.env, args.url, { ...(await fetchOptions(run.env, FAUX_ENV)), offset: args.offset as number | undefined, maxChars: (args.max_chars as number | undefined) ?? TEXT_CAP, pages: pagesOf(run.env), signal: run.signal })),
});

/** A coding tool, from the run's coding source: a name it does not hold (bash on the runner) binds no tool. */
const fileTool = (name: string, summary: string, sandboxOnly = false): ToolEntry => ({
  summary,
  needs: [],
  nodes: !sandboxOnly,
  ...(sandboxOnly ? { sandboxOnly: true as const } : {}),
  bind: async (host) => {
    const tools = host.coding.tools.filter((tool) => tool.name === name);
    return { tools, extensions: tools.length ? [host.coding.extension] : [] };
  },
});

/** The folder the browser files what it reads in. */
const EVIDENCE = "evidence";
/** How many names taken by a link a read steps past before it gives up. */
const EVIDENCE_TRIES = 100;

/** The highest number a file in the run's evidence/ is named by (`0007-browser_read.md`), 0 for none or no folder. A
 *  link at evidence/ itself throws (ESCAPE): nothing is filed through it. */
async function lastEvidence(work: Workspace): Promise<number> {
  try {
    return Math.max(0, ...(await work.list(EVIDENCE)).map((entry) => Number(/^(\d+)-/.exec(entry.name)?.[1] ?? 0)));
  } catch (error) {
    if (isWorkspaceError(error, "NOT_FOUND")) return 0;
    throw error;
  }
}

/** browser_upload's files (pi-browser's WorkspaceFiles) through the run's Workspace: a relative path inside it, no `..`, a
 *  regular file of at most `maxBytes`, read whole. The Workspace keeps every read inside the run's folder (a link out is
 *  ESCAPE). */
export function workspaceFilesIn(work: Workspace, maxBytes: number): { resolve(rel: string): Promise<{ bytes: Uint8Array; name: string; mime: string } | { refused: string }> } {
  return {
    async resolve(rel) {
      if (typeof rel !== "string" || !rel.trim() || rel.includes("\0")) return { refused: "path must name a file in the workspace" };
      if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel) || rel.startsWith("\\")) return { refused: `${rel} is absolute; give a path relative to the workspace` };
      if (rel.split(/[\\/]/).includes("..")) return { refused: `${rel} contains '..'; give a path inside the workspace` };
      try {
        const info = await work.stat(rel);
        if (!info) return { refused: `no file at ${rel} in the workspace` };
        if (info.kind !== "file") return { refused: `${rel} is not a regular file` };
        if (info.size > maxBytes) return { refused: `${rel} is ${info.size} bytes, over the ${maxBytes}-byte limit` };
        const bytes = await work.read(rel);
        if (bytes.byteLength > maxBytes) return { refused: `${rel} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit` };
        const name = rel.split(/[\\/]/).pop()!;
        return { bytes, name, mime: UPLOAD_MIME[(/\.[^.]+$/.exec(name)?.[0] ?? "").toLowerCase()] ?? "application/octet-stream" };
      } catch (error) {
        if (isWorkspaceError(error, "ESCAPE")) return { refused: `${rel} resolves outside the workspace` };
        if (isWorkspaceError(error, "NOT_FOUND")) return { refused: `no file at ${rel} in the workspace` };
        return { refused: `${rel} cannot be opened` };
      }
    },
  };
}
/** browser_upload's types by extension, as pi-browser's own workspaceFiles names them. */
const UPLOAD_MIME: Readonly<Record<string, string>> = {
  ".csv": "text/csv", ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif", ".htm": "text/html", ".html": "text/html", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".json": "application/json",
  ".md": "text/markdown", ".pdf": "application/pdf", ".png": "image/png", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml", ".txt": "text/plain", ".webp": "image/webp", ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xml": "application/xml", ".zip": "application/zip",
};

/** A downloads manifest row (pi-browser's downloads/manifest.json), as downloadsInto reads and writes it. */
type DownloadRow = { name: string; path: string; sizeBytes: number; sha256: string; session?: unknown; remote?: { name?: unknown } & Record<string, unknown> } & Record<string, unknown>;
/** A downloads manifest's rows, the well-formed ones (each under downloads/, with its size and digest); none for a manifest
 *  that is not one. */
const downloadRows = (bytes: Uint8Array | undefined): DownloadRow[] => {
  if (!bytes) return [];
  let parsed: { schema?: unknown; files?: unknown };
  try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as typeof parsed; } catch { return []; }
  return Array.isArray(parsed.files) ? (parsed.files as DownloadRow[]).filter((row) => typeof row?.path === "string" && /^downloads\/[^/]+$/.test(row.path) && typeof row.sha256 === "string" && Number.isSafeInteger(row.sizeBytes)) : [];
};
/** How much of a file in the run's Workspace is read at once to hash it: Workspace reads are bounded (64 MiB), and a
 *  download may be up to pi-browser's 100 MiB. */
const HASH_CHUNK = 8 * 1024 * 1024;
/** Whether `path` in `work` is a file of `size` bytes whose sha256 is `sha256`, hashed in bounded reads. */
async function holds(work: Workspace, path: string, size: number, sha256: string): Promise<boolean> {
  const there = await work.stat(path).catch(() => undefined);
  if (there?.kind !== "file" || there.size !== size) return false;
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  for (let offset = 0; offset < size; offset += HASH_CHUNK) hash.update(await work.read(path, { offset, length: Math.min(HASH_CHUNK, size - offset) }));
  return hash.digest("hex") === sha256;
}

/** pi-browser's browser_downloads (`fetch`, which copies a session's downloads into the folder on this machine its call
 *  names, `call.workspace`, choosing each one's name against that folder), then each file its manifest lists filed into
 *  the run's Workspace `work`, where the run's own read finds it, and the manifest after them. A file already there with
 *  the same bytes is left; one there with other bytes (the run's own, or an earlier runner's download) is never replaced:
 *  the download takes the next name, as pi-browser's own naming does (`<name>-<digest>.<ext>`), and the manifest and the
 *  call's answer name where it is. A file the run moved or deleted since is filed again. The run's local folder itself (Mode
 *  1: `work` is that same folder) is left as pi-browser wrote it. */
export function downloadsInto<A, P, C extends { workspace?: string }, O extends { isError?: boolean; content?: unknown; details?: unknown }>(fetch: (args: A, port: P, call: C) => Promise<O>, work: Workspace, manifestPath: string): (args: A, port: P, call: C) => Promise<O> {
  return async (args, port, call) => {
    const out = await fetch(args, port, call);
    if (out.isError || !call.workspace) return out;
    const { readFile, realpath } = await import("node:fs/promises");
    const spec = await work.mountSpec().catch(() => undefined);
    if (spec?.kind === "bind" && (await realpath(spec.path).catch(() => spec.path)) === (await realpath(call.workspace).catch(() => call.workspace))) return out;
    const local = downloadRows(await readFile(join(call.workspace, manifestPath)).catch(() => undefined));
    if (!local.length) return out;
    const filedRows = downloadRows(await work.read(manifestPath).catch(() => undefined));
    // Where each of this call's local files is in the run's Workspace, by its local path.
    const placed = new Map<string, DownloadRow>();
    for (const row of local) {
      // The same download filed before (same bytes, same session's file), still there: where it is.
      const known = filedRows.find((each) => each.sha256 === row.sha256 && each.session === row.session && each.remote?.name === row.remote?.name);
      if (known && (await holds(work, known.path, known.sizeBytes, known.sha256))) { placed.set(row.path, known); continue; }
      const bytes = await readFile(join(call.workspace, row.path)).catch(() => undefined);
      if (!bytes) continue;
      // Its name, or the next free one: a name holding other bytes takes the download's digest, longer until it is free.
      const name = row.path.slice("downloads/".length);
      const dot = name.lastIndexOf(".");
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
      let target = row.path;
      for (const digits of [8, 16, 32, 64]) {
        const there = await work.stat(target).catch(() => undefined);
        if (!there || (await holds(work, target, row.sizeBytes, row.sha256))) break;
        target = `downloads/${stem}-${row.sha256.slice(0, digits)}${ext}`;
      }
      if (!(await holds(work, target, row.sizeBytes, row.sha256))) await work.write(target, bytes);
      placed.set(row.path, { ...row, path: target, name: target.slice("downloads/".length) });
    }
    // The run's manifest: every row it had, with this call's in their places (a path a row names now is that row's).
    const ours = [...placed.values()];
    const kept = filedRows.filter((each) => !ours.some((row) => row.path === each.path || (row.sha256 === each.sha256 && row.session === each.session && row.remote?.name === each.remote?.name)));
    await work.write(manifestPath, `${JSON.stringify({ schema: "pi-browser.downloads.v1", files: [...kept, ...ours] }, null, 2)}\n`);
    // The call's answer names where each file is in the run's Workspace.
    const moved = [...placed].filter(([from, row]) => from !== row.path);
    if (!moved.length) return out;
    const at = new Map(moved);
    const relocate = (result: unknown): unknown => {
      if (!result || typeof result !== "object") return result;
      const r = result as Record<string, unknown>;
      const each = (list: unknown) => (Array.isArray(list) ? list.map((entry) => {
        const row = entry && typeof entry === "object" ? at.get(String((entry as { path?: unknown }).path)) : undefined;
        return row ? { ...(entry as object), name: row.name, path: row.path } : entry;
      }) : list);
      return { ...r, ...("fetched" in r ? { fetched: each(r.fetched) } : {}), ...("already_fetched" in r ? { already_fetched: each(r.already_fetched) } : {}) };
    };
    const content = Array.isArray(out.content) ? out.content.map((part: { type?: unknown; text?: unknown }) => {
      if (part?.type !== "text" || typeof part.text !== "string") return part;
      try { return { ...part, text: JSON.stringify(relocate(JSON.parse(part.text))) }; } catch { return part; }
    }) : out.content;
    const details = out.details && typeof out.details === "object" && "downloads" in (out.details as object) ? { ...(out.details as object), downloads: relocate((out.details as { downloads: unknown }).downloads) } : out.details;
    return { ...out, content, details };
  };
}

/** Where the browser files what it reads: the run's `evidence/`, through its Workspace, so the run's files show it and
 *  the agent can read it back. A text body follows one line of the read's facts; a capture's bytes go beside its facts.
 *  Each read takes the next number after the highest the folder holds when the sink first files, so a later process's
 *  sink never overwrites one, and reads at once (parallel nodes, one turn's calls) each take their own. A name a link
 *  holds is never written through: the read takes the next. */
export const evidenceIn = (work: Workspace) => {
  let seq: Promise<{ n: number }> | undefined;
  return {
    file: async (label: string, record: { tool: string; facts: Record<string, unknown>; body: string | Uint8Array; ext?: string }) => {
      const facts = JSON.stringify({ label, tool: record.tool, ...record.facts });
      const text = typeof record.body === "string";
      const counter = await (seq ??= lastEvidence(work).then((n) => ({ n })));
      for (let tries = 0; ; tries++) {
        const name = `${String(++counter.n).padStart(4, "0")}-${record.tool}`;
        try {
          await work.write(`${EVIDENCE}/${text ? `${name}.md` : `${name}.json`}`, text ? `${facts}\n\n${record.body}` : `${facts}\n`);
        } catch (error) {
          if (isWorkspaceError(error, "ESCAPE") && tries < EVIDENCE_TRIES) continue;
          throw error;
        }
        if (text) return { path: `${EVIDENCE}/${name}.md`, bodyLine: 3 };
        await work.write(`${EVIDENCE}/${name}.${record.ext ?? "bin"}`, record.body);
        return { path: `${EVIDENCE}/${name}.json`, bodyPath: `${EVIDENCE}/${name}.${record.ext ?? "bin"}` };
      }
    },
  };
};

/** The Browserbase contexts a run's browser may open: its agent's saved sign-in's alone, by its profile name, never one
 *  made here (nothing a run makes is kept for its agent). */
export const keptContexts = (ref: string | undefined) => ({
  clear: false,
  resolve: async (key: string) => {
    if (ref && key.endsWith(`|profile:${SIGN_IN_KEY}`)) return ref;
    throw new Error("this run's browser has no saved sign-in to open");
  },
});

/** Every string in `value` (a tool's answer: its content, its details) passed through `cut`; anything else as it is. */
function cutStrings<T>(value: T, cut: (text: string) => string): T {
  if (typeof value === "string") return cut(value) as T;
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, cut)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cutStrings(item, cut)])) as T;
  }
  return value;
}

/** `tool` whose answer, and a throw's message, pass `cut` inside its execute: before pi stores the result or the model
 *  reads it. */
function answersCutInside(tool: ToolRegistration, cut: (text: string) => string): ToolRegistration {
  return {
    ...tool,
    execute: (async (...args: Parameters<ToolRegistration["execute"]>) => {
      try {
        return cutStrings(await (tool.execute as (...a: unknown[]) => Promise<unknown>)(...args), cut);
      } catch (error) {
        if (error instanceof Error) {
          error.message = cut(error.message);
          if (error.stack) error.stack = cut(error.stack);
        }
        throw error;
      }
    }) as ToolRegistration["execute"],
  } as ToolRegistration;
}

/** Kernel's provider, opening the agent's saved profile (`ref`, its name at Kernel) where a session asks for the
 *  profile `default`: the policy, the session's record and the model see only that name. */
export const keptProfile = <P extends { create(spec: { profile?: { name: string; save: boolean } }, signal: AbortSignal): unknown }>(provider: P, ref: string): P => ({
  ...provider,
  create: (spec, signal) => provider.create(spec.profile?.name === SIGN_IN_KEY ? { ...spec, profile: { ...spec.profile, name: ref } } : spec, signal),
});

/** `provider`, its sessions' profile as this launch was handed it, whatever the policy a conversation was made with (a
 *  follow-up's was made under an earlier launch, which may have had no sign-in, or another lease): with a sign-in, every
 *  session opens on the profile `default`, saving only as `kept.save` says; without one, none asks for a profile. */
export const asHanded = <P extends { create(spec: { profile?: { name: string; save: boolean } }, signal: AbortSignal): unknown }>(provider: P, kept: { save: boolean } | undefined): P => ({
  ...provider,
  create: (spec, signal) => provider.create(kept ? { ...spec, profile: { name: SIGN_IN_KEY, save: kept.save } } : spec.profile ? { ...spec, profile: undefined } : spec, signal),
});

/** Whether a session's change is one that saved to the run's sign-in, in a run that saves (every session of it runs on
 *  the profile, asHanded, whatever its record names): let go by the run (its tool, its idle time, a relaunch, its close,
 *  its end), never one the vendor had already lost or never made. */
export const savedOnRelease = (row: { session: { resourceId: string | null; releaseReason: string | null } }, change: string): boolean =>
  change === "released" && row.session.resourceId !== null && row.session.releaseReason !== null && !["lost", "create_failed"].includes(row.session.releaseReason);

/** On the runner, the per-session hook that verifies the run's saved sign-in: a session that saved to it (savedOnRelease,
 *  in a run handed it to save) verifies it under the run's claim, at the session's own end (its time, else now), as the
 *  saved mark main reads at the lease's end. Answers whether it verified (sign-ins-store.ts verifyRunSignIn). */
export const runSignInSaved = (store: Pick<Store, "runs" | "signIns">, sealKey: Buffer | undefined, claim: Claim, kept: RunSignIn) =>
  async (row: { session: { resourceId: string | null; releaseReason: string | null; endedAt?: string | null } }, change: string): Promise<boolean> => {
    if (!kept.save || !savedOnRelease(row, change)) return false;
    const ended = row.session.endedAt ? Date.parse(row.session.endedAt) : Number.NaN;
    return verifyRunSignIn(store, sealKey, claim, kept, Number.isFinite(ended) ? ended : Date.now());
  };

/** A hosted browser driven through Stagehand, on pi-browser's durable adapter: Browserbase or Kernel (headless), the one
 *  the run's plane names (tool-plane.ts: picked, else Browserbase where the server holds its keys, else Kernel), kept
 *  for the run's life; a plane that names none (a run kept from before the pick) is Browserbase. Its sessions' custody
 *  lives in the run's own store. No recording; the owner watches it live, takes it over and hands it back, and the agent
 *  may ask them to (browser-live.ts, browser-person.ts). A session the run still holds is released when the run is let
 *  go. Where the plane says unavailable (its vendor's key gone since), each call is refused, saying why.
 *  Its session time is the run's spend, held under its cap before it runs (browser-cost.ts). A run handed its agent's
 *  saved sign-in for that vendor (sign-ins.ts, over its pipe) opens every session on it, as the profile `default`,
 *  saving only where it holds the agent's save lease; one that saved says so in its run directory. */
const browserTool: ToolEntry = {
  summary: "Drive a hosted browser, Browserbase's or Kernel's (picked in tool settings, else whichever's key the server holds): open pages, read and screenshot them, and act on them.",
  // Which vendor's keys it needs is the plane's to say (tool-plane.ts BROWSER_KEYS): neither alone is required.
  needs: [],
  nodes: true,
  // Its downloads and uploads go through work/ by path (pi-browser), which a box's command could turn through a link.
  runnerOnly: true,
  bind: async (host) => {
    const [{ BACKGROUND_CONTEXT: context }, { createBrowserExtension }, { DEFAULT_BROWSER_POLICY, BrowserFailureError, browserFailure, workspaceFiles, pageTools, DOWNLOADS_MANIFEST, MAX_UPLOAD_BYTES }, { createDrivingGates, createLiveView, liveViewProvider }, live, person] = await Promise.all([
      import("@earendil-works/chord/context"),
      import("@parcha/pi-browser/durable"),
      import("@parcha/pi-browser"),
      import("@parcha/pi-browser/live-view"),
      import("./browser-live.js"),
      import("./browser-person.js"),
    ]);
    const vendor = planeOf(host.env).browser ?? "browserbase";
    const refused = isUnavailable(vendor) ? new BrowserFailureError(browserFailure("browser_unavailable", `The browser does not run here: ${whyUnavailable(vendor)}.`)) : undefined;
    // The run's saved sign-in: on the runner (one process, many claims) read from the store under this run's own claim
    // (sign-ins-store.ts runSignIn), never from the process; on the old per-run process, over its own secrets' pipe.
    // An agent with none saved has its first made at the vendor now, over this run's own claim keys (host.env), as main's
    // launch makes it: never the process's environment, so one run's keys never make another's.
    const runLog = (line: string) => void process.stderr.write(`agentrun-serve: run ${host.where.ref.id}: ${line}\n`);
    const vendorFetch = async () => (host.env[FAUX_ENV] ? fauxFetch(host.env, FAUX_VENDOR_API_ENV) : fetch);
    const handed = host.claim ? (refused || !host.store ? undefined : await runSignIn(host.store, host.sealKey, host.claim, vendor, { vendors: vendorsOver(() => host.env, vendorFetch), log: runLog })) : handedSignIn();
    const kept = !refused && handed?.provider === vendor ? handed : undefined;
    const faux = host.env[FAUX_ENV] ? host.env[FAUX_BROWSER_ENV] : undefined;
    const parts = faux
      ? ((await import(pathToFileURL(faux).href)) as { default: (env: NodeJS.ProcessEnv, vendor: string, signIn?: typeof kept) => { provider: unknown; driver: unknown } }).default(host.env, vendor, kept)
      : {
          provider: refused
            ? undefined
            : vendor === "kernel"
              ? ((kernel) => (kept ? keptProfile(kernel, kept.ref) : kernel))((await import("@parcha/pi-browser/providers/kernel")).kernelProvider({ env: host.env, headless: true }))
              : (await import("@parcha/pi-browser/providers/browserbase")).browserbaseProvider({ env: host.env, profiles: keptContexts(kept?.ref) }),
          driver: (await import("@parcha/pi-browser/driver/stagehand")).stagehandDriver(),
        };
    // The save flag every session carries is this launch's (asHanded), never the one stored with its conversation.
    const handedProvider = parts.provider ? asHanded(parts.provider as Parameters<typeof asHanded>[0], kept) : undefined;
    // The owner's live view (browser-live.ts): pi-browser's own viewer on a loopback port of this process's, over every
    // provider (the handed one, the run's own), on the same person/model registry as the toolset; framed by the console's
    // own origin alone. The owner drives only after Take over, and the agent may ask them to (browser-person.ts): the
    // person's time is held under the run's cap first, and their turns are rows of the run's timeline.
    const windows = person.personWindows(host.env, Boolean(host.env[FAUX_ENV]));
    const gates = fauxModelWaits(createDrivingGates({ holdIdleMs: windows.holdMs, holdAwayMs: windows.awayMs }), Boolean(host.env[FAUX_ENV]));
    let opened: Harness | undefined;
    const hands = person.personHands({
      root: host.where.root,
      gates,
      personTime: (what, seconds, options) => spend.personTime(what, seconds, options),
      carry: (tag, seconds) => spend.carry(tag, seconds),
      // The model's words for the person, with every value this run holds cut, whole, before they are cut to their bound.
      redact: (text) => redactedAnswer(text, [...hostSecrets(host.env), ...(kept ? [kept.ref] : [])]),
      note: async (kind, data) => {
        // A hand-over's waiting entry, on the runner: the row says the run waits on the person in its browser from that
        // commit (the server tells run.needs_input by it), and no more from its answer's, whoever writes it.
        if (kind === "agent.handover" && data.state === "waiting" && typeof data.id === "string" && host.rowSummaryOn) {
          const id = data.id;
          host.rowSummaryOn(kind, (entry) => entry.id === id && entry.state === "waiting", HANDOVER_WAITING);
          host.rowSummaryOn(kind, (entry) => entry.id === id && entry.state !== "waiting", null);
        }
        await opened?.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind, data })), context);
      },
      holdMs: windows.holdMs,
      // The run's waiting rows for a session: each is an agent.handover entry of the root's, waiting, naming it.
      waiting: async (tag) => (await opened?.commit(async (tx) => {
        let count = 0;
        for (let cursor: Parameters<Tx["scanEntries"]>[2] | undefined; ; ) {
          const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 200, cursor);
          for (const entry of page.items) {
            const data = entry.data as { state?: unknown; session?: unknown } | undefined;
            if (entry.kind === "agent.handover" && data?.state === "waiting" && data.session === tag) count += 1;
          }
          if (page.next === undefined) return count;
          cursor = page.next;
        }
      }, context)) ?? 0,
      // On the runner: an ask's answer is the root's first answered hand-over entry for it (runner/hand-back.ts).
      ...(host.handoverInJournal ? {
        answered: async (id: string) => (await opened?.commit(async (tx) => {
          for (let cursor: Parameters<Tx["scanEntries"]>[2] | undefined; ; ) {
            const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 200, cursor);
            const found = answerIn(page.items, id);
            if (found) return { outcome: found.state, at: found.at, ...(found.reason !== undefined ? { reason: found.reason } : {}) };
            if (page.next === undefined) return undefined;
            cursor = page.next;
          }
        }, context)) ?? undefined,
        // An ask as the journal holds it: its waiting hand-over entry, the one record of it on the runner (no file in work/).
        asked: async (id: string) => (await opened?.commit(async (tx) => {
          for (let cursor: Parameters<Tx["scanEntries"]>[2] | undefined; ; ) {
            const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 200, cursor);
            for (const entry of page.items) {
              const found = entry.kind === "agent.handover" ? person.pendingOfWaiting(entry.data, id) : undefined;
              if (found) return found;
            }
            if (page.next === undefined) return undefined;
            cursor = page.next;
          }
        }, context)) ?? undefined,
        // The answer written only when the ask has none, read and written in one commit: exactly one answered entry.
        answer: async (id: string, data: Record<string, string>) => {
          if (!opened) throw new Error("the run's journal is not open");
          const on = opened;
          const { stood } = await answerOnce((change) => on.commit(change, context), ROOT_CONVERSATION_ID, (entries) => {
            const found = answerIn(entries, id);
            return found ? { stood: found } : { write: data as unknown as HandoverAnswered, stood: data as unknown as HandoverAnswered };
          });
          return { outcome: stood.state, at: stood.at, ...(stood.reason !== undefined ? { reason: stood.reason } : {}) };
        },
      } : {}),
      // Tests only (--faux): the process dies once between an ask's record and its row.
      afterRecord: host.env[FAUX_ENV] && host.env[person.FAUX_ASK_DIES_ENV] ? () => {
        const mark = host.env[person.FAUX_ASK_DIES_ENV]!;
        if (existsSync(mark)) return;
        writeFileSync(mark, "");
        process.kill(process.pid, "SIGKILL");
      } : undefined,
    });
    const view = createLiveView({ hostOrigin: "'self'", gates, takeOver: { take: (tag) => hands.take(tag) } });
    const watched = handedProvider ? liveViewProvider(handedProvider as never, view) : undefined;
    const provider = () => {
      if (refused) throw refused;
      return watched as never;
    };
    // Each session's viewer reaches the server as it launches, and goes as it ends: on the runner through the store, under
    // the run's claim (host.liveViewers); on the old per-run process, in the run's directory, never work/.
    const viewers = live.sessionHandovers(host.where.root, host.liveViewers);
    const onSession = (row: { session: { tag: string }; liveView: { fullscreen: string } | null }, change: string) => viewers.changed(row, change);
    // Its session time is the run's spend, at its provider's price, and held under the run's cap (browser-cost.ts).
    const providerName = (parts.provider as { name?: string } | undefined)?.name ?? vendor;
    const price = browserPrice(providerName, host.env);
    // On the runner, the run's ledger (host.ledger): each call held and settled on its booking, and a session's release one
    // more request there, never this process's own spend. Undefined on the old per-run process: browserSpend's own then.
    const spend = browserSpend(providerName, price, DEFAULT_BROWSER_POLICY.idleReleaseS, (conversation, at) => browser.release(conversation as never, "close", at), undefined, { paid: host.ledger?.paid, pause: host.ledger?.pause });
    // browser_downloads is listed only with a workspace to copy into, and only a provider that keeps a session's downloads
    // (Browserbase's; Kernel's keeps none) has any: without one, uploads still read the run's work/, through `files`.
    const downloads = typeof (parts.provider as { downloads?: unknown } | undefined)?.downloads === "object";
    // What the browser files goes where the run's own read finds it: the run's Workspace (on the runner in Mode 2, its
    // folder on the run's disk, never this machine's folder at the same path). Evidence and uploads go through it; pi-browser
    // copies a session's downloads into a folder on this machine (the run's local folder), and each browser_downloads call
    // then files them, and their manifest, into the run's Workspace too (downloadsInto).
    const runFiles = host.workspace;
    const uploads = runFiles ? workspaceFilesIn(runFiles, MAX_UPLOAD_BYTES) : workspaceFiles(host.where.work);
    const files = downloads ? { workspace: () => host.where.work, files: uploads } : { files: uploads };
    const downloadsTool = downloads && runFiles ? { tools: { browser_downloads: downloadsInto(pageTools().browser_downloads as never, runFiles, DOWNLOADS_MANIFEST) } } : {};
    // A session that saved to the sign-in, let go: its time, for the sign-in's verified_at when the run's lease ends.
    // On the runner, the store's verified_at under the run's claim (runSignInSaved), never a mark in the run's directory.
    const verify = kept?.save && host.claim && host.store ? runSignInSaved(host.store, host.sealKey, host.claim, kept as RunSignIn) : undefined;
    // Awaited by the session's change, so the release that lets a run's sessions go (beforeRelease) returns only once its
    // last save is verified: the run's end commit, which ends the claim, never fences it.
    const saved = kept?.save
      ? async (row: Parameters<typeof savedOnRelease>[0], change: string): Promise<void> => {
          if (verify) await verify(row, change);
          else if (savedOnRelease(row, change)) writeFileSync(join(host.where.root, SIGN_IN_SAVED), new Date().toISOString(), { mode: 0o600 });
        }
      : undefined;
    // Both hosts of a session's changes: the live view's hand-over, and the sign-in's saved mark.
    const onSessions = async (row: Parameters<typeof savedOnRelease>[0] & Parameters<typeof onSession>[0], change: string) => {
      // A session let go ends a wait on the person's answer that kept it open (personWait, below): the run parks.
      if (change === "released") hands.sessionEnded(row.session.tag);
      await saved?.(row, change);
      await onSession(row, change);
    };
    // The pointer is cut from everything the browser hands the model (its results, their details, its failures): a
    // vendor's refusal can quote it, as pi-browser's one-saver rule names Kernel's profile.
    // A run handed its agent's sign-in tells the model its browser keeps it (`run`'s description): one with none claims
    // cookies across pages only.
    const browser = createBrowserExtension({ provider, driver: parts.driver as never, evidence: evidenceIn(host.workspace ?? localWorkspace(host.where.work)) as never, ...files, ...(downloadsTool as object), gates, handoff: hands.handoff, onSession: onSessions as never, signIns: kept !== undefined, beforeCreate: spend.opening, redact: { values: () => [...runnerSecrets(host.env), ...(kept ? [kept.ref] : [])] }, prices: { sessionUsdPerHour: price.usdPerHour, sessionMinimumS: price.minimumS }, onCharge: spend.onCharge });
    // On the runner, every answer the browser's tools give passes the run's one redactor inside the call, so what pi stores
    // (its result record) and what the model reads hold no value the runner or the claim holds.
    const tools = (browser.tools as unknown as ToolRegistration[]).map(spend.capped).map((tool) => (host.redact ? answersCutInside(tool, host.redact) : tool));
    const extension = { ...(browser.extension as unknown as Extension), tools } as Extension;
    host.install(extension);
    host.onConversation(async (tx, conversationId) => {
      // The profile is the host's choice, never the model's: the agent's one sign-in, when the run was handed it.
      const policy = kept ? { ...DEFAULT_BROWSER_POLICY, profile: { name: SIGN_IN_KEY, save: kept.save } } : DEFAULT_BROWSER_POLICY;
      Object.assign(await tx.doc(browser.docs.Config, conversationId as never), { label: "run", run: host.where.ref.id, policy });
    });
    host.beforeResume(async (harness) => {
      opened = harness;
      // A hand-over still waiting from an earlier pass or claim (its waiting entry, no answer yet): its answer, in this
      // pass, clears the row's waiting summary too, as the pass that asked would have.
      // A first claim has no root yet (the session creates it): nothing waits then.
      if (host.rowSummaryOn && (await harness.conversation(ROOT_CONVERSATION_ID as never, context).catch(() => undefined))) {
        const entries: { kind: string; data?: unknown }[] = [];
        await harness.commit(async (tx) => {
          for (let cursor: Parameters<Tx["scanEntries"]>[2] | undefined; ; ) {
            const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, order: "ascending" }, 200, cursor);
            entries.push(...page.items);
            if (page.next === undefined) return;
            cursor = page.next;
          }
        }, context);
        const waitingIdOf = (entry: { kind: string; data?: unknown }) => {
          const data = entry.data as { state?: unknown; id?: unknown } | undefined;
          return entry.kind === "agent.handover" && data?.state === "waiting" && typeof data.id === "string" ? data.id : undefined;
        };
        const waiting = new Set(entries.map(waitingIdOf).filter((id): id is string => id !== undefined));
        for (const id of waiting) if (!answerIn(entries, id)) host.rowSummaryOn("agent.handover", (entry) => entry.id === id && entry.state !== "waiting", null);
      }
      // Its charges move what the process counts once each is committed, reconcile's own among them.
      spend.watch(harness, (browser.docs.Inventory as unknown as { definition: { kind: string } }).definition.kind);
      // With its vendor's key gone there is no session to reconcile or release from here: each would only fail.
      if (refused) return;
      // Every session custody still tracks across a restart is held from here; one kept is released an idle window on
      // unless a call uses it.
      await browser.reconcile(harness as never, () => true, context);
      await spend.reopened(harness, browser.docs, context);
      // A session kept across the restart has no viewer in this process yet, and reconcile tells no session's change: each
      // one's viewer is opened here and handed over, as a launch's is. It starts with nobody holding the browser.
      const kept = Object.values(((await harness.snapshot(browser.docs.Inventory as never, context)) as { rows?: Record<string, { tag: string; resourceId: string | null; state: string }> } | undefined)?.rows ?? {});
      for (const row of kept.filter((r) => (r.state === "live" || r.state === "held") && r.resourceId !== null)) {
        try {
          const opened = await watched?.liveView?.({ id: row.resourceId!, tag: row.tag });
          await viewers.reopened(row.tag, opened?.fullscreen);
        } catch {
          // A browser that cannot be reached has no view to give: the owner reads none, as for any session without one.
        }
      }
    });
    // On the runner: the run's turn ended on its question to the person (ask_person). With a session of its browser open
    // (live, or held for a hand-over), the run waits for the answer in its claim, so the session, its live viewer and its
    // page stay for the person and for the agent's next turn, as main's process kept them; the person's time on each such
    // session is held under the run's cap the way a hand-over's is (personHands.wait). With none open, or no room under
    // the cap for that time, the run parks (its release lets the browser go).
    host.personWait?.(async (harness, callId, since) => {
      if (refused) return undefined;
      const rows = Object.values(((await harness.snapshot(browser.docs.Inventory as never, context)) as { rows?: Record<string, { tag: string; resourceId: string | null; state: string }> } | undefined)?.rows ?? {});
      const open = rows.filter((row) => (row.state === "live" || row.state === "held") && row.resourceId !== null).map((row) => row.tag);
      if (!open.length) return undefined;
      const waited = await hands.wait(callId, open, since);
      return "refused" in waited ? undefined : waited;
    });
    host.beforeRelease(async (harness) => {
      try {
        if (refused) return;
        const held = await harness.snapshot(browser.docs.Inventory as never, context) as { rows?: Record<string, { conversationId: number; state: string }> } | undefined;
        for (const id of new Set(Object.values(held?.rows ?? {}).filter((row) => row.state !== "released").map((row) => row.conversationId))) {
          const conversation = await harness.conversation(id as never, context);
          if (conversation) await browser.release(conversation as never, "close", context);
        }
        await browser.drain(harness as never, context);
        // The releases' charges are booked on the claim's one ledger before the run's release returns, so the run's end
        // commit, which ends the claim, never fences one (nothing to wait for off the ledger).
        await spend.ledgerIdle();
      } finally {
        // Every viewer's token dies with the process's hold on its sessions, and the hand-over with it; the person's
        // holds go, and the asks with them.
        await view.close();
        hands.close();
        await viewers.released();
        person.dropAsks(host.where.root);
      }
    });
    return { tools, extensions: [extension] };
  },
};

export const TOOLS: Readonly<Record<string, ToolEntry>> = Object.freeze({
  read: fileTool("read", "Read a file in the run's work/; in a sandbox, an image anywhere in the run's box too (a render in /tmp)."),
  write: fileTool("write", "Write a file in the run's work/."),
  edit: fileTool("edit", "Edit a file in the run's work/."),
  bash: fileTool("bash", "Run a bash command in the run's box, from its work/, never on this server itself: only an agent whose place is a sandbox names it. Its output's tail; 120 s unless the call names a timeout, at most 600 s (longer work: bash_background).", true),
  // The background tools (background.ts): each call a short command in the run's box, on bash's environment.
  bash_background: fileTool("bash_background", `Start a command in the background in the run's box, from its work/, and get its id at once: its stdout and stderr go to work/background/<id>/output.log (the first ${BACKGROUND_LOG_BYTES / (1024 * 1024)} MiB), its stdin is a pipe (a terminal with tty: true), and the run's end ends it; at most ${BACKGROUND_MAX} run at once. Only an agent whose place is a sandbox names it.`, true),
  bash_output: fileTool("bash_output", `Read a background process's output from a byte offset, at most ${BACKGROUND_PAGE_BYTES / 1024} KiB a call, with whether it still runs, its exit code and the next offset. Sandbox only.`, true),
  bash_input: fileTool("bash_input", "Write text to a running background process's stdin, and close it if asked. Sandbox only.", true),
  bash_signal: fileTool("bash_signal", "Send TERM, INT or KILL to a background process's process group. Sandbox only.", true),
  bash_list: fileTool("bash_list", "List the run's background processes: id, state or exit code, output size and command. Sandbox only.", true),
  [ASK_TOOL]: {
    summary: "Ask the person who started the run; the turn ends until a message answers.",
    needs: [],
    nodes: false,
    bind: async (host) => installTool(host, "person", askPerson as ToolRegistration),
  },
  [WEB_FETCH_TOOL]: webFetchEntry(WEB_FETCH_TOOL),
  [WEB_SEARCH_TOOL]: {
    summary: "Search the web: codex's own search (claude-agent's where it is picked), on pi the model provider's hosted search (Anthropic, OpenAI), with none of those Parallel's Search API where the server holds its key, else Exa's keyless search; or the provider picked: { query, n? } -> { provider, query, results: [{ url, title, snippet, published? }], text? }, provider naming the one that served it, 1 to 25 results, each snippet at most 3,000 characters; { error } when the search gives no answer.",
    needs: [],
    nodes: true,
    bind: async (host) => installTool(host, "web-search", booking(webSearchTool(host.env)) as unknown as ToolRegistration),
    effect: async (args, run) => bookedIn(run.ledger, () => searchFor(run.env, args, run.signal)),
  },
  browser: browserTool,
  // monid's catalog on one key (monid.ts): every harness calls each by its wire name, `monid_discover` and the rest.
  "monid.discover": monidTool("discover"),
  "monid.inspect": monidTool("inspect"),
  "monid.run": monidTool("run"),
  [PDF_PAGES_TOOL]: callOnly(
    "A workflow call: { path, maxPages?, dpi? } -> { name, pageCount, dpi, pages: [{ page, image }], text }; the document's first pages drawn as PNGs under work/pages/<stem>/<dpi>/ (the dpi lowered so a page's long side is at most 1568 px), from the server's documents (--documents) or the run's work directory.",
    (args, run) => pdfPages(args, { work: localWorkspace(run.work), documents: run.env[DOCUMENTS_ENV], signal: run.signal }),
  ),
  [LLM_TOOL]: callOnly(
    "A workflow call: { prompt, system?, maxTokens?, tier? } -> { text, model, usage, cost_usd }; one completion on the model of the tier (default), no tools and no loop.",
    (args, run) => {
      if (!run.complete) throw new Error("llm: this run has no model to complete on");
      return run.complete(args, run.signal);
    },
  ),
});

/** Every name a revision may name, those a workflow's model node may, and those a workflow's call node may run. */
export const BOUND_TOOLS: readonly string[] = Object.keys(TOOLS).filter((name) => !TOOLS[name]!.callOnly);
export const NODE_TOOLS: readonly string[] = BOUND_TOOLS.filter((name) => TOOLS[name]!.nodes);
export const CALL_TOOLS: readonly string[] = Object.keys(TOOLS).filter((name) => TOOLS[name]!.effect !== undefined);
/** Whether `name` is one of `allowed`. */
export const allows = (allowed: readonly string[], name: string): boolean => allowed.includes(name);

/** The tools a run's learned workflow may name (learn/check.ts at learn time, learned-workflow.ts at a call): those of the
 *  agent's `granted` tools a workflow's call node runs here (CALL_TOOLS), and with the run's `plane`, none it resolves unavailable (its agent's own tool of the name does not run either). A
 *  learned model node runs without tools (learn/skills.ts MODEL_NODE_TOOLS), and a harness's own tool (Bash,
 *  exec_command, apply_patch) is never one, so the DSL refuses a draft that names it. */
export const learnedWorkflowTools = (granted: readonly string[], plane?: Plane): string[] =>
  [...new Set(granted.filter((name) => allows(CALL_TOOLS, name) && !isUnavailable(plane?.[name as Pickable])))];

/** The tools a learned draft may name (learnedWorkflowTools) that the gate allows: `permission` is what the gate holds a
 *  tool to now (tool-gate.ts permissionOf, or the run's gate's policy), by its settings key. One set to ask or deny is left out of `tools`, so the end-of-run prompt never offers it, and named
 *  in `gated` with its setting, which the checker and a learned workflow's check before it runs refuse a draft for. */
export const learnedDraftTools = (granted: readonly string[], permission: (name: string) => string, plane?: Plane, from?: (name: string) => SettingFrom): { tools: string[]; gated: Record<string, string>; deniedBy: Record<string, DenyFrom> } => {
  const gated: Record<string, string> = {};
  // Where each deny was set (this agent's settings or this server's), so the refusal names it.
  const deniedBy: Record<string, DenyFrom> = {};
  const tools = learnedWorkflowTools(granted, plane).filter((name) => {
    const setting = permission(name);
    if (setting === "allow") return true;
    gated[name] = setting;
    // A deny comes from a layer or the default, never from approvals, which only ever allows.
    if (setting === "deny" && from) deniedBy[name] = from(name) as DenyFrom;
    return false;
  });
  return { tools, gated, deniedBy };
};

/** The tools a workflow names (`nodes` from workflowNodes): on its model nodes (`tools`), and on its `call` nodes
 *  `via: "tool"` (`tool`). */
export function workflowTools(nodes: readonly Record<string, unknown>[]): { nodes: string[]; calls: string[] } {
  const named = new Set<string>();
  const calls = new Set<string>();
  for (const node of nodes) {
    if (node.node === "call" && node.via === "tool" && typeof node.tool === "string") calls.add(node.tool);
    else if (Array.isArray(node.tools)) for (const name of node.tools) if (typeof name === "string") named.add(name);
  }
  return { nodes: [...named], calls: [...calls] };
}

/** The tools a revision grants its run: an agentic revision's `tools`; a workflow revision's `tools` with those its model
 *  and call nodes name, which its run binds whether `tools` lists them or not. */
export async function grantedTools(revision: { kind: string; tools?: readonly string[]; workflow?: unknown }): Promise<string[]> {
  if (revision.kind !== "workflow") return [...(revision.tools ?? [])];
  const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
  const named = workflowTools(workflowNodes(revision.workflow, inspectWorkflow(revision.workflow)));
  return [...new Set([...(revision.tools ?? []), ...named.nodes, ...named.calls])];
}

/** The table's entry for `name`, or undefined for a name it does not hold. */
export const toolOf = (name: string): ToolEntry | undefined => (Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined);

/** What a stored revision's tools resolve from (tool-plane.ts): the tools it grants, its harness, model and settings. */
export async function toolingOf(revision: Revision): Promise<Tooling> {
  const tools = await grantedTools(revision.kind === "agentic" ? { kind: "agentic", tools: revision.body.tools } : { kind: "workflow", tools: revision.body.tools, workflow: revision.body.workflow });
  return { tools, ...(revision.kind === "workflow" ? { workflow: true as const } : {}), ...(revision.body.harness ? { harness: revision.body.harness } : {}), ...(revision.kind === "agentic" && revision.body.model ? { model: revision.body.model } : {}), ...(revision.body.toolSettings ? { overrides: revision.body.toolSettings as ToolSettingsMap } : {}), ...(revision.body.approvals === "never" ? { approvals: "never" as const } : {}) };
}

/** The variables `entry` needs that `env` does not set, by name. */
export const missingEnv = (entry: ToolEntry, env: NodeJS.ProcessEnv): string[] => entry.needs.filter((name) => !env[name]);

/** What keeps `names` from being bound here: names outside the table (or, for a workflow's model nodes, that a node may
 *  not name), and the variables each tool in it needs that `env` does not set. Undefined when nothing does. */
export function toolRefusal(names: readonly string[], env: NodeJS.ProcessEnv, where: "agent" | "nodes" | "calls" = "agent"): { message: string; unbound: string[]; missing: Record<string, string[]> } | undefined {
  const allowed = where === "nodes" ? NODE_TOOLS : where === "calls" ? CALL_TOOLS : BOUND_TOOLS;
  const unbound = names.filter((name) => !allows(allowed, name));
  if (unbound.length) {
    const said = { agent: "agentrun-serve binds the tools", nodes: "A workflow's model nodes get the tools", calls: "A workflow's call nodes run the tools" }[where];
    return { message: `${said} ${allowed.join(", ")}; this ${where === "agent" ? "revision" : "workflow"} also ${where === "calls" ? "calls" : "names"} ${unbound.join(", ")}.`, unbound, missing: {} };
  }
  const missing = Object.fromEntries(names.map((name) => [name, missingEnv(toolOf(name)!, env)] as const).filter(([, vars]) => vars.length));
  const lacking = Object.entries(missing);
  if (!lacking.length) return undefined;
  const said = lacking.map(([name, vars]) => `The tool ${name} needs ${keyNeeded(vars)}.`).join(" ");
  return { message: `This server holds no key for what the revision's tools need. ${said}`, unbound: [], missing };
}

/** Every tool as capabilities show it, the server's one tool catalog: available here, or the variables it is missing
 *  (names only), and the harnesses that run it (another harness than pi runs only the host tools, host-tools.ts). A tool
 *  a user picks a provider for (tool-plane.ts) gives the providers offered, the server's (`provider`, the default where it
 *  sets none), the default, and what it resolves to on each harness under the server's `settings`: available where any
 *  is not unavailable, and missing PARALLEL_API_KEY where Parallel is picked without it. An unavailable tool says why
 *  (`reason`). `noBox`: why no box can run a sandbox-only tool here (place.ts noBoxReason), which leaves it
 *  unavailable with that reason; undefined, a box can. `refused`: the variables of the keys this server was started with
 *  that their provider refused at the start (ToolKeys.refused), each with why: a tool that needs one is unavailable,
 *  saying that. Each tool also gives its permission under the server's settings (tool-gate.ts), the owner's default
 *  and the permissions it may be set to. */
export const toolsView = (env: NodeJS.ProcessEnv, settings: ToolSettingsMap = {}, noBox?: string, refused: Readonly<Record<string, string>> = {}) => {
  const views = explainsView(env, settings);
  const picked = withDefaults(settings);
  return Object.entries(TOOLS).map(([name, entry]) => {
    const view = (PICKABLE as readonly string[]).includes(name) ? views[name as Pickable] : undefined;
    const plane = view?.resolves;
    const missing = plane && Object.values(plane).includes(NO_PARALLEL_KEY) ? [PARALLEL_KEY_ENV] : missingEnv(entry, env);
    const boxless = entry.sandboxOnly ? noBox : undefined;
    // The browser needs the keys of the vendor it resolves to: one refused at the start leaves it unavailable, never on the
    // other vendor, as a refused Parallel key never moves web_search elsewhere.
    const needs = name === "browser" ? [...new Set(Object.values(plane ?? {}).flatMap(browserNeeds))] : entry.needs;
    const refusal = needs.map((name) => (Object.hasOwn(refused, name) ? refused[name] : undefined)).find((why) => why !== undefined);
    const available = (plane ? Object.values(plane).some((resolution) => !isUnavailable(resolution)) : missing.length === 0) && boxless === undefined && refusal === undefined;
    // Unavailable says why: a sandbox-only tool no box here can run, why none can (`noBox`); on a tool a user picks a
    // provider for, the resolutions' own words (`web_search is turned off in settings`); else the variables it needs.
    const reason = available ? undefined : refusal ?? boxless ?? (plane ? [...new Set(Object.values(plane).filter(isUnavailable).map(whyUnavailable))].join("; ") : `Needs ${keyNeeded(missing)}`);
    return { name, summary: entry.summary, ...(blurbOf(name) ? { blurb: blurbOf(name) } : {}), nodes: entry.nodes, calls: entry.effect !== undefined, ...(entry.callOnly ? { call_only: true } : {}), ...(entry.sandboxOnly ? { sandbox_only: true } : {}), available, ...(reason ? { reason } : {}), ...(missing.length ? { missing } : {}), harnesses: name in REPLAY ? [...HARNESSES] : [DEFAULT_HARNESS], ...serverGate(name, settings), ...(plane ? { providers: [...PROVIDERS[name as Pickable]], provider: picked[name as Pickable].provider, default_provider: PROVIDERS[name as Pickable][0], resolves: plane, why: view!.why } : {}) };
  });
};

/** Tests only (--faux, with the fake browser's $FAUX_BROWSER_LOG): each model call that starts waiting for the person to
 *  hand the browser back is logged (`{"op":"model_waits"}`) as it starts to wait, so a test hands back once the agent's call
 *  waits, never before it got there. The gates are the registry's own (one per session, the same object each time), each
 *  given the note once; anything else is `gates` untouched. */
function fauxModelWaits<G extends (tag: string) => { untilFree?(signal?: AbortSignal): Promise<void> }>(gates: G, faux: boolean): G {
  const log = faux ? process.env.FAUX_BROWSER_LOG : undefined;
  if (!log) return gates;
  const noted = new WeakSet<object>();
  return ((tag: string) => {
    const gate = gates(tag);
    const until = gate.untilFree?.bind(gate);
    if (until && !noted.has(gate)) {
      noted.add(gate);
      gate.untilFree = (signal?: AbortSignal) => {
        appendFileSync(log, `${JSON.stringify({ op: "model_waits" })}\n`);
        return until(signal);
      };
    }
    return gate;
  }) as G;
}
