// Runs: each one a child process (`pi-durable-disk run` on `<home>/runs/<id>` with serve's app), read live through the
// door it serves on loopback, and read from its store, read-only, once its claim is released. A run that answered is
// sent SIGTERM; once its process has exited it is carried back to its agent home (`carryBack`), and it is finished.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { open as openFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentHomeError, carryBack, startRun } from "@parcha/pi-durable-agent";
import { registerLabel, timelineOf, timelineReducer, type TimelineEvent } from "@parcha/pi-durable-agent/timeline";
import { type AgentEntry, type Agents, homeError } from "./agents.js";
import { readJson, writeWhole } from "./files.js";
import { ASK_TOOL } from "./app.js";
import { ApiError } from "./errors.js";
import { EFFORT_ENV, FAUX_ENV } from "./model.js";
import { ChangeClock, type Page, RowLog } from "./rows.js";
import { isObject, type Json, outputIssues } from "./validate.js";

export type Status = "queued" | "working" | "input_required" | "completed" | "failed" | "cancelled";
export type State = "working" | "waiting" | "idle";
const TERMINAL = new Set<Status>(["completed", "failed", "cancelled"]);
const RELEASED = new Set(["sleeping", "paused", "done", "failed"]);
const LEASE_MS = 90_000;
const HOST = "agentrun-serve";
const META = "serve.json";
/** The run process's stderr, beside run.json: a file, so the process outlives a server that stops without stopping it. */
const PROCESS_LOG = "process.log";
const QUIET = /:run:(start|end)$/;
const RETRY_CODES = ["OPENING", "PARKING", "RELEASED"];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
/** Waits between carry backs that found the home busy: each attempt itself waits 5 s for the home's lock. */
const CARRY_BACK_RETRIES_MS = [500, 1_000, 2_000, 4_000, 8_000];
/** How long a run's process may live on after it released the run before its store is read anyway: the process holds the
 *  store's exclusive lock until it exits. */
const EXIT_AFTER_RELEASE_MS = 30_000;
/** How many 500 ms ticks in a row a live run's record may be unreadable before it is settled anyway. */
const UNREADABLE_TICKS = 10;
/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the database. */
const sqliteBusy = (error: unknown) => isObject(error) && error.code === "ERR_SQLITE_ERROR" && typeof error.errcode === "number" && [5, 6].includes(error.errcode & 0xff);
const warn = (runId: string, text: string) => void process.stderr.write(`agentrun-serve: run ${runId}: ${text}\n`);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isLoopback = (host: string) => host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);

type RunMeta = {
  title: string;
  created_at: string;
  agent_version: number;
  effort?: string;
  max_cost_usd?: number;
  /** The definition's `output_schema` when the run started: its final answer is then its output, as a JSON object. */
  output_schema?: Json;
  error?: { code: string; message: string };
};
type RunError = { code: string; message: string; retryable: boolean };

/** One run as this server holds it. */
export type Run = {
  id: string;
  agentId: string;
  dir: string;
  meta: RunMeta;
  log: RowLog;
  /** The run's rows as they come in (before the log names them), with each `ask_person` answer's waiting row. */
  rows: TimelineEvent[];
  /** The whole text of the run's newest assistant message: a row's text is cut at 2000 characters, an output is not. */
  answerText?: string;
  child?: ChildProcess;
  /** The pid of a run process an earlier server started that still serves the run: supervised by its run.json. */
  orphan?: number;
  feed?: AbortController;
  working: boolean;
  /** Messages this server sent the run that its rows do not show yet. */
  submitted: number;
  stopped: boolean;
  cancel: boolean;
  /** Set when the run has answered or failed and is being let go; the outcome it gets. */
  finishing?: Status;
  endedAt?: string;
  outcome?: Status;
  error?: RunError;
  settled: boolean;
  settling?: Promise<void>;
  updatedAt: string;
};

const ASKED = "Asked you: ";
registerLabel(ASK_TOOL, (args) => `${ASKED}${typeof args.question === "string" ? args.question : ""}`);

/** The waiting row after each answered `ask_person` call, which the timeline module does not know. The question comes
 *  from the call's row, whose label this module registers. */
export function withAsks(rows: readonly TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const questions = new Map<string, string>();
  for (const row of rows) {
    out.push(row);
    if (row.kind === "tool_use" && row.tool_name === ASK_TOOL && row.tool_use_id && row.summary?.startsWith(ASKED)) questions.set(row.tool_use_id, row.summary.slice(ASKED.length));
    if (row.kind === "tool_result" && row.tool_name === ASK_TOOL && row.tool_status === "success") {
      const question = questions.get(row.tool_use_id ?? "") || "the agent asked you a question";
      out.push({ ...row, id: `${row.id}:waiting`, kind: "waiting", summary: `Waiting for you: ${clip(question, 480)}`, text: clip(question, 2000), tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null });
    }
  }
  return out;
}

/** A final answer as a run's output: the answer's text (or one fenced block of it) parsed as a JSON object. */
export function outputOf(answer: string | null | undefined): Json | undefined {
  if (!answer) return undefined;
  const text = answer.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(text);
  try {
    const value: unknown = JSON.parse(fenced ? fenced[1]! : text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Notes the whole text of the newest assistant message in `entries` (pi's stored entries). */
function noteAnswer(run: Run, entries: readonly unknown[]): void {
  for (const value of entries) {
    if (!isObject(value) || value.kind !== "pi.assistant" || !Array.isArray(value.model) || !isObject(value.model[0])) continue;
    const content = value.model[0].content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => isObject(b) && b.type === "text").map((b) => String((b as Json).text ?? "")).join("\n").trim() : "";
    if (text) run.answerText = text;
  }
}

const meaningful = (rows: readonly TimelineEvent[]) => rows.findLast((r) => r.kind !== "usage" && r.kind !== "phase" && !QUIET.test(r.id));
const answerOf = (rows: readonly TimelineEvent[]) => {
  const last = meaningful(rows);
  return last?.kind === "final_answer" || last?.kind === "text_block" ? last : undefined;
};
const costOf = (rows: readonly TimelineEvent[]): number | null => rows.findLast((r) => r.kind === "usage")?.usage?.usd ?? null;
const usersOf = (rows: readonly TimelineEvent[]) => rows.filter((r) => r.kind === "user_message").length;

/** A run's status and state, by the contract's table. */
export function statusOf(run: Run): { status: Status; state: State } {
  if (run.outcome) return { status: run.outcome, state: "idle" };
  if (run.finishing) return { status: run.finishing, state: "idle" };
  const users = usersOf(run.rows);
  if (!users) return { status: "queued", state: "working" };
  if (run.submitted > 0) return { status: "working", state: "working" };
  if (run.stopped) return { status: "input_required", state: "idle" };
  if (run.working) return { status: "working", state: "working" };
  if (meaningful(run.rows)?.kind === "waiting") return { status: "input_required", state: "waiting" };
  return { status: "working", state: "idle" };
}

/** The waits between carry backs that found the home busy, and a hook called at each such refusal. */
export type CarryBackRetry = { delaysMs?: readonly number[]; onBusy?: (runId: string, attempt: number) => void };
export type RunsOptions = { agents: Agents; doorTokenFile: string; doorToken: string; faux?: string; drainTimeout?: string; carryBackRetry?: CarryBackRetry };

/** The last line of the run process's log, for a failure's message. */
async function lastLogLine(run: Run): Promise<string> {
  const file = await openFile(join(run.dir, PROCESS_LOG)).catch(() => null);
  if (!file) return "";
  try {
    const { size } = await file.stat();
    const length = Math.min(size, 4096);
    const { buffer } = await file.read(Buffer.alloc(length), 0, length, size - length);
    return clip(buffer.toString("utf8").trim().split("\n").at(-1) ?? "", 300);
  } finally {
    await file.close();
  }
}

export class Runs {
  private readonly runs = new Map<string, Run>();
  private readonly adopting = new Map<string, Promise<Run>>();
  private readonly clock = new ChangeClock();
  private readonly cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@parcha/pi-durable-disk")));
  private readonly app = fileURLToPath(new URL("./app.js", import.meta.url));
  private closing = false;
  constructor(private readonly options: RunsOptions) {}

  // ---- reading --------------------------------------------------------------------------------------------------------

  /** Run `id`, read from its agent home the first time this process sees it. */
  async get(id: string): Promise<Run | null> {
    const known = this.runs.get(id);
    if (known) return known;
    const entry = await this.options.agents.ownerOf(id);
    if (!entry) return null;
    return this.adopt(entry, id);
  }

  /** One Run per run id, however many requests ask for it at once. */
  private adopt(entry: AgentEntry, id: string): Promise<Run> {
    const known = this.runs.get(id);
    if (known) return Promise.resolve(known);
    let pending = this.adopting.get(id);
    if (!pending) {
      pending = this.load(entry, id).finally(() => this.adopting.delete(id));
      this.adopting.set(id, pending);
    }
    return pending;
  }

  private async load(entry: AgentEntry, id: string): Promise<Run> {
    const index = entry.state.runs[id]!;
    const dir = join(entry.home.dir, index.path);
    const stored = (await readJson(join(dir, META))) as Partial<RunMeta> | null;
    const meta: RunMeta = {
      title: typeof stored?.title === "string" ? stored.title : "",
      created_at: typeof stored?.created_at === "string" ? stored.created_at : index.startedAt,
      agent_version: typeof stored?.agent_version === "number" ? stored.agent_version : entry.state.definition.version,
      ...(typeof stored?.effort === "string" ? { effort: stored.effort } : {}),
      ...(typeof stored?.max_cost_usd === "number" ? { max_cost_usd: stored.max_cost_usd } : {}),
      ...(isObject(stored?.output_schema) ? { output_schema: stored.output_schema } : {}),
      ...(stored?.error ? { error: stored.error } : {}),
    };
    const run = this.blank(id, entry.home.identity.id, dir, meta);
    this.runs.set(id, run);
    const record = await this.record(run);
    // Only a store no live instance holds is opened: released, or left by an instance whose lease lapsed.
    if (index.endedAt || !this.doorOf(record)) await this.storeWhenFree(run);
    if (index.endedAt) {
      run.outcome = (["completed", "failed", "cancelled"].includes(String(index.outcome)) ? index.outcome : "completed") as Status;
      run.endedAt = index.endedAt;
      if (run.outcome === "failed") run.error = { code: meta.error?.code ?? "run_failed", message: meta.error?.message ?? "The run failed.", retryable: false };
      run.settled = true;
    } else if (record && this.doorOf(record)) this.adoptProcess(run, record);
    this.refresh(run);
    return run;
  }

  private blank(id: string, agentId: string, dir: string, meta: RunMeta): Run {
    return { id, agentId, dir, meta, log: new RowLog(this.clock), rows: [], working: false, submitted: 0, stopped: false, cancel: false, settled: false, updatedAt: meta.created_at };
  }

  private record(run: Run): Promise<Json | null> {
    return readJson(join(run.dir, "run.json"));
  }

  /** The door a live run serves, from its run.json: running, a fresh heartbeat, and a loopback address. */
  private doorOf(record: Json | null): string | undefined {
    if (record?.status !== "running" || !isObject(record.holder) || typeof record.holder.serve !== "string") return undefined;
    if (typeof record.heartbeatAt !== "string" || Date.now() - Date.parse(record.heartbeatAt) >= LEASE_MS) return undefined;
    const url = URL.parse(record.holder.serve);
    return url?.protocol === "http:" && isLoopback(url.hostname) ? url.origin : undefined;
  }

  /** The run's rows from its store, opened read-only; only once its claim is released. */
  private async readStore(run: Run): Promise<void> {
    const file = join(run.dir, "store", "run.sqlite");
    if (!(await stat(file).catch(() => null))) return;
    const { DatabaseSync } = await import("node:sqlite");
    const entries: Json[] = [];
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const conversation = (db.prepare("SELECT MIN(conversation_id) AS id FROM entries").get() as { id?: number } | undefined)?.id;
      if (conversation != null) for (const row of db.prepare("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id").iterate(conversation)) entries.push(JSON.parse(String((row as { record: string }).record)) as Json);
    } finally {
      db.close();
    }
    run.working = false;
    noteAnswer(run, entries);
    this.take(run, timelineOf(entries as never, { settled: true }));
  }

  /** New rows in: into the log, then the run's status, then whatever the status asks for. */
  private take(run: Run, rows: TimelineEvent[]): void {
    run.rows = withAsks(rows);
    run.submitted = Math.max(0, run.submitted - (usersOf(run.rows) - (run.log.rows().filter((r) => r.kind === "user_message").length)));
    if (run.log.sync(run.rows)) run.updatedAt = new Date().toISOString();
    this.refresh(run);
  }

  /** A live process: the child this server started, or one an earlier server started that still serves the run. */
  private live(run: Run): boolean {
    return Boolean(run.child || run.orphan);
  }

  /** How the run ends, from its rows: over its cap, a model error, or an answer (checked against an output_schema).
   *  Undefined while it works, or when it stopped, waits or parked. */
  private decide(run: Run): { outcome: Status; error?: RunError; abort?: boolean } | undefined {
    const cap = run.meta.max_cost_usd;
    const cost = costOf(run.rows);
    if (cap !== undefined && cost !== null && cost > cap) return { outcome: "failed", abort: true, error: { code: "spend_cap_reached", message: `The run cost $${cost.toFixed(4)}, over its cap of $${cap}.`, retryable: false } };
    if (run.working || run.submitted > 0) return undefined;
    const last = meaningful(run.rows);
    if (last?.kind === "error") return { outcome: "failed", error: { code: "run_failed", message: last.text ?? last.summary ?? "The run failed.", retryable: false } };
    const answer = run.stopped ? undefined : answerOf(run.rows);
    if (!answer) return undefined;
    const schema = run.meta.output_schema;
    const output = schema ? outputOf(run.answerText ?? answer.text) : undefined;
    const issues = schema ? (output ? outputIssues(output, schema) : [{ message: "the final answer is not a JSON object" }]) : [];
    if (!issues.length) return { outcome: "completed" };
    return { outcome: "failed", error: { code: "output_invalid", message: `The run's final answer is not an output its agent's output_schema takes: ${issues.map((i) => i.message).join("; ")}.`, retryable: false } };
  }

  /** Records the run's status as a change when it moves, and lets go of a live run that answered, failed or is over its cap. */
  private refresh(run: Run): void {
    this.mark(run);
    if (!this.live(run) || run.finishing || run.outcome) return;
    const end = this.decide(run);
    if (!end) return;
    if (end.error) run.error = end.error;
    this.finish(run, end.outcome, end.abort);
  }

  /** Let go of a live run with `outcome`: SIGTERM, after aborting its turn when it is still working. */
  private finish(run: Run, outcome: Status, abortFirst = false): void {
    run.finishing = outcome;
    run.endedAt = new Date().toISOString();
    this.mark(run);
    void (abortFirst ? this.abortTurn(run) : Promise.resolve()).then(() => this.terminate(run));
  }

  /** SIGTERM to the run's process: it drains, releases the run and exits. */
  private terminate(run: Run): void {
    if (run.child) run.child.kill("SIGTERM");
    else if (run.orphan && alive(run.orphan)) process.kill(run.orphan, "SIGTERM");
  }

  /** Supervise a run process an earlier server started: follow its door, and settle the run once its run.json says it
   *  let go (released, or its lease lapsed) or the process is gone. */
  private adoptProcess(run: Run, record: Json): void {
    const pid = isObject(record.holder) && Number.isSafeInteger(record.holder.pid) ? (record.holder.pid as number) : undefined;
    if (!pid) return;
    run.orphan = pid;
    this.connect(run);
    let releasedAt: number | undefined;
    let unreadable = 0;
    const timer = setInterval(() => {
      void this.record(run).then((now) => {
        if (run.orphan !== pid || (this.doorOf(now) && alive(pid))) return;
        // A record that cannot be read while the process lives is read again at the next tick, a few times at most.
        if (now === null && alive(pid) && ++unreadable < UNREADABLE_TICKS) return;
        if (now === null && alive(pid)) warn(run.id, `its run.json could not be read ${UNREADABLE_TICKS} times in a row; settling it`);
        if (now !== null) unreadable = 0;
        if (RELEASED.has(String(now?.status)) && alive(pid)) {
          releasedAt ??= Date.now();
          if (Date.now() - releasedAt < EXIT_AFTER_RELEASE_MS) return;
          warn(run.id, `its process ${pid} released the run ${EXIT_AFTER_RELEASE_MS / 1000} s ago and has not exited; reading its store anyway`);
        }
        clearInterval(timer);
        run.orphan = undefined;
        void this.settle(run, null, !alive(pid) && !RELEASED.has(String(now?.status)));
      });
    }, 500);
    timer.unref();
  }

  /** At start: every run of every agent that is not carried back is read, supervised when its process lives, and
   *  carried back when it already ended. Nothing is woken. */
  async recover(entries: AgentEntry[]): Promise<void> {
    for (const entry of entries) {
      for (const [id, index] of Object.entries(entry.state.runs)) {
        if (index.endedAt) continue;
        const run = await this.adopt(entry, id).catch((error: Error) => (warn(id, `not recovered: ${error.message}; the next start tries again`), null));
        if (run && !this.live(run) && !run.outcome) await this.settle(run, null, false);
      }
    }
  }

  /** The run's status, state and whether its rows are all in, as one more change of its log when any of them moves. */
  private mark(run: Run): void {
    const { status, state } = statusOf(run);
    if (run.log.setState(`${status}/${state}/${run.settled}`)) run.updatedAt = new Date().toISOString();
  }

  // ---- the door -------------------------------------------------------------------------------------------------------

  private headers(json = false): Record<string, string> {
    return { authorization: `Bearer ${this.options.doorToken}`, ...(json ? { "content-type": "application/json" } : {}) };
  }

  /** Follow the door's events into the run's rows, again after each drop while the process lives. */
  private connect(run: Run): void {
    if (run.feed) return;
    const abort = new AbortController();
    run.feed = abort;
    void (async () => {
      while (!abort.signal.aborted) {
        const door = this.doorOf(await this.record(run));
        if (door) await this.follow(run, door, abort.signal).catch(() => undefined);
        if (abort.signal.aborted || (!this.live(run) && !this.doorOf(await this.record(run)))) break;
        await sleep(200);
      }
      if (run.feed === abort) run.feed = undefined;
    })();
  }

  private async follow(run: Run, door: string, signal: AbortSignal): Promise<void> {
    const reducer = timelineReducer();
    const up = await fetch(new URL("/events", door), { signal, headers: { ...this.headers(), accept: "text/event-stream" } });
    if (!up.ok || !up.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of up.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      for (let end; (end = buffer.indexOf("\n\n")) >= 0; ) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        let value: unknown;
        try {
          value = JSON.parse(data.join("\n"));
        } catch {
          continue;
        }
        if (event === "end") return;
        const events = event === "snapshot" ? [value as Json] : event === "events" && Array.isArray(value) ? (value as Json[]) : [];
        if (event === "snapshot") run.working = Boolean((value as Json).run);
        for (const e of events) if (e.type === "run_start" || e.type === "run_end") run.working = e.type === "run_start";
        noteAnswer(run, events.flatMap((e) => (Array.isArray(e.entries) ? e.entries : e.entry !== undefined ? [e.entry] : [])));
        reducer.apply(events as never);
        this.take(run, reducer.rows());
      }
    }
  }

  /** The door of a run that is not finished, starting or waking its process when it is not live. */
  private async ensureLive(run: Run, timeoutMs = 45_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (let launched = false; ; await sleep(100)) {
      if (run.outcome || run.finishing || run.cancel) throw this.finished(run);
      const record = await this.record(run);
      const door = this.doorOf(record);
      if (door) return door;
      if (!this.live(run)) {
        if (launched) throw new ApiError("internal", `the run's process exited before it served: ${await lastLogLine(run)}`);
        const fresh = record?.status === "running" && typeof record.heartbeatAt === "string" && Date.now() - Date.parse(record.heartbeatAt) < LEASE_MS;
        if (!fresh) this.launch(run), (launched = true);
      }
      if (Date.now() > deadline) throw new ApiError("unavailable", "the run did not come up in time", { retry_after_ms: 1000 }, { "retry-after": "1" });
    }
  }

  private finished(run: Run): ApiError {
    const status = run.cancel ? "cancelled" : statusOf(run).status;
    const why = status === "completed" ? "This run is finished: its sign-ins went back to its agent." : `This run ${status === "failed" ? "failed" : "was cancelled"}.`;
    return new ApiError("not_continuable", `${why} Start a new run of the agent.`, {
      next_action: { type: "request", method: "POST", path: `/agents/${run.agentId}/runs`, caller_supplies: ["input", "Idempotency-Key"] },
    });
  }

  /** Abort the turn running now through the door, when there is one; never wakes the run. */
  private async abortTurn(run: Run): Promise<void> {
    const door = this.doorOf(await this.record(run));
    if (door) await fetch(new URL("/abort", door), { method: "POST", headers: this.headers(true), body: "{}", signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }

  private async toDoor(run: Run, path: string, body?: Json): Promise<{ status: number; body: Json | null }> {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const door = await this.ensureLive(run);
      const res = await fetch(new URL(path, door), {
        method: body === undefined ? "GET" : "POST",
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const data = res ? ((await res.json().catch(() => null)) as Json | null) : null;
      if (res && !(res.status === 503 && RETRY_CODES.includes(String(data?.error)))) return { status: res.status, body: data };
      if (Date.now() > deadline) throw new ApiError("unavailable", "the run's door did not answer", { retry_after_ms: 1000 }, { "retry-after": "1" });
      await sleep(200);
    }
  }

  private launch(run: Run): void {
    if (run.child || this.closing || run.cancel) return;
    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.options.faux ? { [FAUX_ENV]: this.options.faux } : {}), ...(run.meta.effort ? { [EFFORT_ENV]: run.meta.effort } : {}) };
    const log = openSync(join(run.dir, PROCESS_LOG), "a", 0o600);
    const child = spawn(process.execPath, [
      "--no-warnings=ExperimentalWarning", this.cli, "run", "--dir", run.dir, "--app", this.app,
      "--serve", "0", "--serve-host", "127.0.0.1", "--serve-token-file", this.options.doorTokenFile, "--drain-timeout", this.options.drainTimeout ?? "30s",
    ], { stdio: ["ignore", "ignore", log], env });
    closeSync(log);
    run.child = child;
    child.once("exit", (code) => {
      if (run.child === child) run.child = undefined;
      void this.settle(run, code, true);
    });
    child.once("error", () => void (run.child === child && (run.child = undefined)));
    this.connect(run);
  }

  /** After the run's process exited: its rows from its released store, then, when it is over, its carry back. One at
   *  a time per run, and none once the run has its outcome. */
  private settle(run: Run, code: number | null, exited: boolean): Promise<void> {
    run.settling = (run.settling ?? Promise.resolve())
      .then(() => (run.outcome ? undefined : this.settleOnce(run, code, exited)))
      .catch((error: Error) => warn(run.id, `not settled: ${error.message}; the next start tries again`));
    return run.settling;
  }

  /** `exited`: the process this server supervised exited; without a release that fails the run. */
  private async settleOnce(run: Run, code: number | null, exited: boolean): Promise<void> {
    run.feed?.abort();
    run.feed = undefined;
    run.working = false;
    const record = await this.record(run);
    const released = RELEASED.has(String(record?.status));
    if (released) await this.storeWhenFree(run);
    let outcome: Status | undefined;
    if (run.cancel) outcome = "cancelled";
    else if (run.finishing) outcome = run.finishing;
    else if (exited && !released) {
      outcome = "failed";
      run.error = { code: "run_failed", message: `The run's process exited (${code ?? "signal"}) without releasing the run: ${await lastLogLine(run)}`, retryable: false };
    } else if (!this.doorOf(record)) {
      const end = this.decide(run);
      if (end?.error) run.error = end.error;
      outcome = end?.outcome;
    }
    if (!outcome) return this.refresh(run);
    const entry = await this.agentWhenFree(run.agentId, run.id);
    const answer = answerOf(run.rows);
    const cost = costOf(run.rows);
    if (run.error) run.meta.error = { code: run.error.code, message: run.error.message };
    await writeWhole(join(run.dir, META), `${JSON.stringify(run.meta)}\n`);
    if (entry) {
      // A home held by another writer is tried again with backoff; past the last try the run stays unsettled, and the
      // next start carries it back.
      for (let attempt = 0; ; attempt++) {
        try {
          await carryBack(entry.home, { runId: run.id }, {
            outcome,
            ...(outcome === "completed" && answer ? { finalAnswer: clip(answer.text ?? answer.summary ?? "", 2000) } : {}),
            ...(cost === null ? {} : { cost }),
          });
          break;
        } catch (error) {
          if (!(error instanceof AgentHomeError && error.code === "busy") || !(await this.retryBusy(run.id, attempt, "its agent home"))) throw error;
        }
      }
      this.options.agents.forget(run.agentId);
      run.endedAt = (await this.options.agents.get(run.agentId))?.state.runs[run.id]?.endedAt ?? run.endedAt ?? new Date().toISOString();
    }
    run.outcome = outcome;
    run.finishing = undefined;
    run.settled = true;
    run.updatedAt = new Date().toISOString();
    this.refresh(run);
  }

  /** After refusal `attempt` because `what` is busy: waits out the next delay and says whether to try again. */
  private async retryBusy(runId: string, attempt: number, what: string): Promise<boolean> {
    const delays = this.options.carryBackRetry?.delaysMs ?? CARRY_BACK_RETRIES_MS;
    this.options.carryBackRetry?.onBusy?.(runId, attempt);
    if (attempt >= delays.length) return false;
    warn(runId, `${what} is busy; trying again in ${delays[attempt]} ms (${attempt + 1} of ${delays.length})`);
    await sleep(delays[attempt]!);
    return true;
  }

  /** The run's store, read again while another connection holds it, within the same retries. */
  private async storeWhenFree(run: Run): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.readStore(run);
      } catch (error) {
        if (!sqliteBusy(error) || !(await this.retryBusy(run.id, attempt, "its store"))) throw error;
      }
    }
  }

  /** The agent, read again while another writer holds its home, within the carry back's retries. */
  private async agentWhenFree(id: string, runId = id): Promise<AgentEntry | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.options.agents.get(id);
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "home_busy") || !(await this.retryBusy(runId, attempt, "its agent home"))) throw error;
      }
    }
  }

  // ---- acting ---------------------------------------------------------------------------------------------------------

  /** Start a run of `entry` with its first message: `startRun` in the home, then its process, then the message. */
  async create(entry: AgentEntry, options: { content: string; title: string; effort?: string; maxCostUsd?: number }): Promise<Run> {
    const outputSchema = entry.state.definition.output_schema;
    const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
    const started = await startRun(entry.home, { runId: id, host: HOST }).catch(homeError);
    this.options.agents.forget(entry.home.identity.id);
    const meta: RunMeta = {
      title: clip(options.title.trim().replace(/\s+/g, " "), 80),
      created_at: new Date().toISOString(),
      agent_version: entry.state.definition.version,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.maxCostUsd !== undefined ? { max_cost_usd: options.maxCostUsd } : {}),
      ...(outputSchema ? { output_schema: outputSchema } : {}),
    };
    await writeWhole(join(started.dir, META), `${JSON.stringify(meta)}\n`);
    const run = this.blank(id, entry.home.identity.id, started.dir, meta);
    this.runs.set(id, run);
    run.submitted = 1;
    this.refresh(run);
    this.launch(run);
    void this.submit(run, options.content, "followUp", `first-${id}`).catch((error: Error) => {
      run.submitted = 0;
      run.error = { code: "run_failed", message: error.message, retryable: false };
      if (this.live(run)) this.finish(run, "failed");
      else if (!run.cancel) void this.settle(run, null, true);
    });
    return run;
  }

  private async submit(run: Run, content: string, whenBusy: "steer" | "followUp", requestId: string): Promise<void> {
    const answer = await this.toDoor(run, "/submit", { requestId, content, whenBusy });
    if (answer.status >= 400) throw new ApiError(answer.status === 409 ? "not_continuable" : "internal", String(answer.body?.message ?? answer.body?.error ?? "the run refused the message"));
  }

  /** One message, its mode chosen by the run's state (the contract's table). */
  async message(run: Run, content: string): Promise<{ mode: "steer" | "answer" | "follow_up"; messageId: string }> {
    const { status, state } = statusOf(run);
    if (TERMINAL.has(status)) throw this.finished(run);
    const mode = status === "queued" || (status === "working" && state === "working") ? "steer" : status === "input_required" && state === "waiting" ? "answer" : "follow_up";
    const messageId = `m${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
    run.stopped = false;
    run.submitted++;
    this.refresh(run);
    try {
      await this.submit(run, content, mode === "steer" ? "steer" : "followUp", messageId);
    } catch (error) {
      run.submitted = Math.max(0, run.submitted - 1);
      this.refresh(run);
      throw error;
    }
    return { mode, messageId };
  }

  /** Abort the turn that is running; the run stays open, `input_required` and idle. */
  async stop(run: Run): Promise<boolean> {
    const { status, state } = statusOf(run);
    if (!this.live(run) || !(status === "working" && state === "working") || run.submitted > 0) return false;
    // Set before the abort: the turn's end can arrive before the door answers, and must not read as an answer.
    run.stopped = true;
    const answer = await this.toDoor(run, "/abort", {}).catch(() => null);
    if (!answer || answer.status >= 400) {
      run.stopped = false;
      this.refresh(run);
      return false;
    }
    this.refresh(run);
    return true;
  }

  /** Record the cancel and signal the run; it is `cancelled` once its process has exited and it is carried back. */
  async cancel(run: Run): Promise<boolean> {
    if (run.outcome) return false;
    run.cancel = true;
    if (this.live(run)) {
      // The turn is aborted first, so the drain that SIGTERM starts does not wait for it.
      await this.abortTurn(run);
      this.terminate(run);
    } else await this.settle(run, null, false);
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    const live = [...this.runs.values()].filter((run) => run.child);
    for (const run of live) {
      run.child!.kill("SIGTERM");
      setTimeout(() => run.child?.exitCode === null && run.child.kill("SIGKILL"), 45_000).unref();
    }
    await Promise.all(live.map((run) => new Promise((resolve) => (run.child ? run.child.once("exit", resolve) : resolve(undefined)))));
    // An adopted process is stopped the same way, and watched by its pid.
    const adopted = [...this.runs.values()].filter((run) => run.orphan && alive(run.orphan));
    for (const run of adopted) this.terminate(run);
    for (const deadline = Date.now() + 45_000; adopted.some((run) => run.orphan && alive(run.orphan)) && Date.now() < deadline; ) await sleep(100);
    await sleep(0);
    await Promise.all([...this.runs.values()].map((run) => run.settling));
    for (const run of this.runs.values()) run.feed?.abort();
  }

  /** Every run of `entry`, in its runs index. */
  async of(entry: AgentEntry): Promise<Run[]> {
    const ids = Object.keys(entry.state.runs);
    return (await Promise.all(ids.map((id) => this.runs.get(id) ?? this.adopt(entry, id).catch(() => null)))).filter((run): run is Run => run !== null);
  }

  // ---- views ------------------------------------------------------------------------------------------------------------

  cost(run: Run) {
    return { usd: costOf(run.rows), basis: "estimate", charge_state: null, cap_usd: run.meta.max_cost_usd ?? null };
  }

  /** `Run`, as the contract shows it. */
  async view(run: Run) {
    const { status, state } = statusOf(run);
    const entry = await this.options.agents.get(run.agentId);
    const index = entry?.state.runs[run.id];
    const answer = answerOf(run.rows);
    const finalAnswer = answer ? (run.answerText ?? answer.text ?? answer.summary ?? null) : typeof index?.finalAnswer === "string" ? index.finalAnswer : null;
    const output = run.meta.output_schema ? (outputOf(finalAnswer) ?? null) : null;
    return {
      run_id: run.id,
      agent_id: run.agentId,
      agent_version: run.meta.agent_version,
      sha: index?.sha ?? null,
      status,
      state,
      title: run.meta.title,
      ...(run.meta.effort ? { effort: run.meta.effort } : {}),
      created_at: run.meta.created_at,
      updated_at: run.updatedAt,
      ended_at: TERMINAL.has(status) ? (index?.endedAt ?? run.endedAt ?? run.updatedAt) : null,
      result: status === "completed" ? { output, final_answer: finalAnswer } : null,
      error: status === "failed" ? (run.error ?? { code: "run_failed", message: "The run failed.", retryable: false }) : null,
      cost: this.cost(run),
      poll_after_ms: TERMINAL.has(status) && run.settled ? 0 : 1000,
    };
  }

  async summary(run: Run) {
    const { run_id, agent_id, agent_version, sha, status, state, title, created_at, ended_at, cost } = await this.view(run);
    return { run_id, agent_id, agent_version, sha, status, state, title, created_at, ended_at, cost };
  }

  /** The timeline from change `after`, held up to `waitMs` for a change when there is none. */
  async page(run: Run, after: number, waitMs: number, limit: number): Promise<Page & { status: Status; state: State; final: boolean }> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const page = run.log.page(after, limit);
      const { status, state } = statusOf(run);
      const final = TERMINAL.has(status) && run.settled;
      if (!page.unchanged || final || Date.now() >= deadline) return { ...page, status, state, final };
      await run.log.changed(deadline - Date.now());
    }
  }
}
