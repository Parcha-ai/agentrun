// One drive of an OpenCode session: the pinned `opencode serve`, started for the drive and ended with it, driven over its
// HTTP API and its event stream. Written for AgentRun. OpenCode is event-sourced: its per-session events are mirrored into
// the session's records and given back to the next process, which rebuilds the session from them.
//
// A drive:
//  1. makes the session's private directories fresh (HOME, XDG config, data, cache and state, tmp): what OpenCode starts
//     with is never an earlier drive's, only what the session's records hold;
//  2. starts the session's model proxy (the OpenCode policy) and its MCP server (the host's tools), then OpenCode, whose
//     config (a 0600 file OPENCODE_CONFIG names) points its one provider at the proxy and its one MCP server at the adapter's, turns
//     every one of its own tools, agents and side requests off, and gives it the session's instructions as its agent's
//     prompt;
//  3. gives OpenCode back its session: the events mirrored so far (`/sync/replay`), or a new session (`POST /session`);
//  4. runs a turn a crash cut off (the kernel's recovery note, as a user message), then each pending submission, one per
//     turn: each placed first, then sent (`prompt_async`), and over when OpenCode says the session is idle, or errs;
//  5. mirrors OpenCode's events into the session's records (`/sync/history`) before every paid model request, before every
//     `never` tool call, and at each turn's end: no paid request and no call that may not run twice runs ahead of the log.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { DriveContext, HostTool, SessionState } from "@parcha/agentrun-kernel/kernel";
import { NativeJournal, placeSubmissions, recoveryNote, toolBridge, transcriptOf, type TranscriptEntry } from "@parcha/agentrun-kernel/process";
import { startModelProxy, type ModelProxyHooks, type ModelProxyOptions, type ParentWatch } from "@parcha/agentrun-kernel/host";
import { openCodeConfig } from "./config.js";
import { startMcpServer } from "./host/mcp.js";
import { openCodePolicy, TOOL_PREFIX, type WatchedCall } from "./host/policy.js";
import { startOpenCodeServer, type ConfineChild, type OpenCodeServer } from "./host/server.js";

/** The journal stream that holds OpenCode's own events for the session, as `/sync/history` gives them. */
export const SYNC_STREAM = "opencode.sync";
/** The journal stream that holds the message id each submission was sent under. */
export const PROMPT_STREAM = "opencode.prompt";
/** The session's private directories, under its own directory. */
export const PRIVATE_DIRS = ["home", "config", "data", "cache", "state", "tmp"] as const;
/** OpenCode's agent for the session: its prompt is the session's instructions, and its only tools are the host's. */
export const AGENT = "hands";
/** How long one try of a drive's event stream may take to say `server.connected`, and how many tries a drive has. */
export const EVENT_CONNECT_MS = 10_000;
export const EVENT_TRIES = 3;
/** How long a drive that was not stopped waits, at its end, for the host tool calls still running to settle, when the
 *  kernel gives it no deadline (DriveContext.deadline). Codex waits for its in-flight calls the same way
 *  (run-adapters-codex/src/harness.ts:815-819 and :1125-1128), bounded by its own invocation deadline, which is
 *  codex-internal (invocationDeadline: the World's runtime deadline, else 10 minutes); this is opencode's own bound. */
export const CALLS_SETTLE_MS = 30_000;

export interface OpenCodeHarnessOptions {
  /** The kernel's tools: exactly the host's (and `read_skill_file` with skills). */
  tools: HostTool[];
  /** The provider's model id. */
  model: string;
  /** The session's instructions: OpenCode's agent prompt, in place of OpenCode's own. */
  instructions?: string;
  /** The reasoning effort, when the session names one. */
  effort?: string;
  /** The session's own directory: its private directories are made in it. */
  dir: string;
  /** The workspace OpenCode runs in (absolute), or `<dir>/work`. */
  cwd?: string;
  /** OpenCode, or a test's stand-in for it. */
  command: { command: string; args: string[]; env?: Record<string, string> };
  confine?: ConfineChild;
  parentWatch?: ParentWatch;
  /** The provider the proxy forwards to and its credential, read per request. */
  provider: { origin: string; credential: () => Promise<string> | string };
  hooks: ModelProxyHooks;
  price?: ModelProxyOptions["price"];
  maxOutputTokens?: number;
  contextWindow: number;
  /** How long one try of the event stream may take to open. Default EVENT_CONNECT_MS. */
  eventConnectMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** For tests: the fetch the model proxy forwards with. */
  fetch?: typeof fetch;
  /** For tests: the environment the child's allowlist reads. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** What the adapter holds of the drive in flight, to stop its turn. */
export interface DriveControl {
  /** Stop the turn in flight: OpenCode aborts it, and the drive ends once its end is in the log. Resolves true when that
   *  happened within `ms`, false when the drive must be halted instead. */
  interrupt(ms: number): Promise<boolean>;
}

type Outcome = { status: "completed" | "interrupted" | "failed"; error?: string };
type SyncEvent = { id: string; aggregate_id: string; seq: number; type: string; data: Record<string, unknown> };

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** JSON text of `value` with every object's keys sorted: two argument objects that say the same are the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastMs = 0;
let counter = 0;

/** A message id in OpenCode's own format (`msg_` + 12 hex of the time + 14 base62), which OpenCode orders messages by: it
 *  sorts after every id this process made before it. The random part comes from `seed` (the submission's id). */
export function messageId(seed: string, now = Date.now()): string {
  if (now <= lastMs) counter += 1;
  else {
    lastMs = now;
    counter = 0;
  }
  const at = BigInt(lastMs) * 0x1000n + BigInt(counter);
  const hex = (at & 0xffffffffffffn).toString(16).padStart(12, "0");
  const bytes = createHash("sha256").update(seed).update(randomBytes(8)).digest();
  let tail = "";
  for (let i = 0; i < 14; i++) tail += BASE62[bytes[i]! % 62];
  return `msg_${hex}${tail}`;
}

/** Calls the model made, as the proxy saw them before OpenCode did, to be matched to the MCP calls OpenCode makes: by the
 *  host tool's name and the arguments' canonical JSON, first in first out. A call the watch has not seen yet is waited
 *  for. */
class CallIds {
  private readonly seen = new Map<string, string[]>();
  private readonly waiting = new Map<string, ((id: string) => void)[]>();
  private readonly used = new Set<string>();

  add(call: WatchedCall): void {
    if (!call.name.startsWith(TOOL_PREFIX) || this.used.has(call.callId)) return;
    let args: unknown = {};
    try {
      args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    } catch {
      return; // OpenCode cannot call it either: its arguments are not JSON
    }
    const key = `${call.name.slice(TOOL_PREFIX.length)}\0${canonical(isPlain(args) ? args : {})}`;
    const waiter = this.waiting.get(key)?.shift();
    if (waiter) {
      this.used.add(call.callId);
      waiter(call.callId);
      return;
    }
    const list = this.seen.get(key) ?? [];
    if (!list.includes(call.callId)) list.push(call.callId);
    this.seen.set(key, list);
  }

  async take(name: string, args: Record<string, unknown>, signal: AbortSignal, ms = 30_000): Promise<string> {
    const key = `${name}\0${canonical(args)}`;
    const ready = this.seen.get(key)?.shift();
    if (ready) {
      this.used.add(ready);
      return ready;
    }
    return new Promise<string>((resolve, reject) => {
      const list = this.waiting.get(key) ?? [];
      const done = (id: string) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        resolve(id);
      };
      const stop = () => {
        clearTimeout(timer);
        const at = list.indexOf(done);
        if (at >= 0) list.splice(at, 1);
        reject(signal.reason instanceof Error ? signal.reason : new Error("the call was stopped"));
      };
      const timer = setTimeout(() => {
        const at = list.indexOf(done);
        if (at >= 0) list.splice(at, 1);
        signal.removeEventListener("abort", stop);
        reject(new Error(`opencode: no model call of ${name} with these arguments was seen, so the call has no id to run under`));
      }, ms);
      signal.addEventListener("abort", stop, { once: true });
      list.push(done);
      this.waiting.set(key, list);
    });
  }
}

/** The session's mirrored OpenCode events, as `/sync/replay` takes them back. */
function replayEvents(events: readonly SyncEvent[]): { id: string; aggregateID: string; seq: number; type: string; data: Record<string, unknown> }[] {
  return events.map((e) => ({ id: e.id, aggregateID: e.aggregate_id, seq: e.seq, type: e.type, data: e.data }));
}

const isSyncEvent = (value: unknown): value is SyncEvent =>
  isPlain(value) && typeof value.id === "string" && typeof value.aggregate_id === "string" && typeof value.seq === "number" && typeof value.type === "string" && isPlain(value.data);

/** Whether the mirrored events hold the message `id` (it reached OpenCode, and its process recorded it). */
function holdsMessage(events: readonly SyncEvent[], id: string): boolean {
  return events.some((e) => {
    const info = e.data.info;
    return isPlain(info) && info.id === id;
  });
}

/** The OpenCode harness. `control` is told of each drive's stop hook while it runs. */
export function openCodeHarness(options: OpenCodeHarnessOptions, control?: (drive: DriveControl | undefined) => void) {
  const log = options.log ?? (() => {});
  const idle = (ctx: DriveContext) => !recoveryNote(ctx.state()) && ctx.pending().length === 0;
  return {
    name: "opencode",
    async drive(ctx: DriveContext): Promise<void> {
      if (idle(ctx)) return;
      await driveOnce(ctx);
    },
  };

  async function driveOnce(ctx: DriveContext): Promise<void> {
    const base = normalize(options.dir);
    if (!isAbsolute(base)) throw new Error("opencode: the session directory must be an absolute path");
    if (options.cwd !== undefined && !isAbsolute(options.cwd)) throw new Error("opencode: the working directory must be an absolute path");
    const root = options.cwd === undefined ? join(base, "work") : normalize(options.cwd);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const dirs = Object.fromEntries(PRIVATE_DIRS.map((d) => [d, join(base, d)])) as Record<(typeof PRIVATE_DIRS)[number], string>;
    // Everything OpenCode kept goes: what it starts with is the session's records, never an earlier drive's files.
    for (const dir of Object.values(dirs)) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const configFile = join(dirs.config, "agentrun-opencode.json");

    const journal = new NativeJournal(ctx);
    const mirrored: SyncEvent[] = (await journal.read<unknown>(SYNC_STREAM)).map((r) => r.data).filter(isSyncEvent);
    const prompts = (await journal.read<{ submission?: string; messageID?: string }>(PROMPT_STREAM)).map((r) => r.data);
    let sessionID: string | undefined = mirrored[0]?.aggregate_id;
    let lastSeq = mirrored.reduce((max, e) => Math.max(max, e.seq), -1);

    const calls = new CallIds();
    const stopped = new AbortController();
    const signal = AbortSignal.any([ctx.signal, stopped.signal]);
    let server: OpenCodeServer | undefined;

    // The mirror: OpenCode's events for the session since the last mirror, into the log. One at a time.
    let mirroring: Promise<void> = Promise.resolve();
    const mirror = (): Promise<void> => {
      const run = mirroring.then(async () => {
        if (!server || !sessionID || !server.alive()) return;
        const answer = await server.request("POST", "/sync/history", lastSeq < 0 ? {} : { [sessionID]: lastSeq }, signal);
        if (answer.status !== 200 || !Array.isArray(answer.body)) throw new Error(`opencode: OpenCode's event history answered ${answer.status}`);
        for (const event of answer.body) {
          if (!isSyncEvent(event) || event.aggregate_id !== sessionID || event.seq <= lastSeq) continue;
          journal.append(SYNC_STREAM, event, { id: event.id });
          mirrored.push(event);
          lastSeq = event.seq;
        }
        await journal.flush();
      });
      mirroring = run.catch(() => undefined);
      return run;
    };
    const barrier = async () => {
      await mirror();
      await journal.flush();
    };

    const bridge = toolBridge(ctx, options.tools, { beforeNever: () => barrier() });
    const hooks: ModelProxyHooks = {
      ...options.hooks,
      // No paid request runs ahead of the log: what OpenCode recorded before it is mirrored first.
      beforeRequest: async (request) => {
        await barrier();
        return options.hooks.beforeRequest(request);
      },
    };
    const proxyKey = randomBytes(32).toString("base64url");
    const proxy = await startModelProxy({
      policy: openCodePolicy({ model: options.model, tools: options.tools.map((t) => t.name), ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}), onCall: (call) => calls.add(call) }),
      hooks,
      model: options.model,
      origin: options.provider.origin,
      credential: async () => (await options.provider.credential()) ?? "",
      ...(options.price ? { price: options.price } : {}),
      log,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }, proxyKey);
    const mcpKey = randomBytes(32).toString("base64url");
    // A start that fails here closes the model proxy it opened: the drive's own close is the finally below.
    let mcp: Awaited<ReturnType<typeof startMcpServer>>;
    try {
      mcp = await startMcpServer({
        tools: bridge.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        key: mcpKey,
        log,
        call: async (name, args, callSignal) => {
          const callId = await calls.take(name, args, AbortSignal.any([callSignal, signal]));
          return bridge.call(name, args, callId, callSignal);
        },
      });
    } catch (error) {
      await proxy.close().catch(() => {});
      throw error;
    }

    // The turn in flight: what the event stream tells it.
    let turn: { messageID: string; busy: boolean; accepted: boolean; error?: string; text: Map<string, string>; finalText: string; end: (outcome: Outcome) => void } | undefined;
    const partKinds = new Map<string, string>();
    const roles = new Map<string, string>();
    let interrupting: (() => void) | undefined;

    control?.({
      async interrupt(ms) {
        if (!turn || !server || !sessionID) return false;
        const ended = new Promise<void>((resolve) => (interrupting = resolve));
        const asked = await server.request("POST", `/session/${sessionID}/abort`, undefined, AbortSignal.timeout(ms)).catch(() => undefined);
        if (!asked || asked.status >= 300) return false;
        return Promise.race([ended.then(() => true), sleep(ms).then(() => false)]);
      },
    });

    const onEvent = (event: { type?: string; properties?: Record<string, unknown> }) => {
      const p = event.properties ?? {};
      if (event.type === "message.updated" && isPlain(p.info) && typeof p.info.id === "string" && typeof p.info.role === "string") {
        roles.set(p.info.id, p.info.role);
        return;
      }
      if (p.sessionID !== undefined && p.sessionID !== sessionID) return;
      if (event.type === "message.part.updated" && isPlain(p.part) && typeof p.part.id === "string" && typeof p.part.type === "string") {
        partKinds.set(p.part.id, p.part.type);
        if (turn && p.part.type === "text" && typeof p.part.text === "string" && roles.get(String(p.part.messageID)) !== "user") {
          turn.text.set(p.part.id, p.part.text);
          turn.finalText = p.part.text;
        }
        if (turn && p.part.type === "tool") turn.finalText = "";
        return;
      }
      if (event.type === "message.part.delta" && turn && p.field === "text" && typeof p.delta === "string" && typeof p.partID === "string") {
        if (partKinds.get(p.partID) !== "text" || roles.get(String(p.messageID)) === "user") return;
        const now = (turn.text.get(p.partID) ?? "") + p.delta;
        turn.text.set(p.partID, now);
        turn.finalText = now;
        ctx.live({ type: "text", delta: p.delta });
        return;
      }
      if (event.type === "session.status" && turn && isPlain(p.status)) {
        if (p.status.type === "busy" || p.status.type === "retry") turn.busy = true;
        else if (p.status.type === "idle" && turn.busy) turn.end(turn.error ? { status: "failed", error: turn.error } : { status: "completed" });
        return;
      }
      if (event.type === "session.idle" && turn && turn.busy) {
        turn.end(turn.error ? { status: "failed", error: turn.error } : { status: "completed" });
        return;
      }
      if (event.type === "session.error" && turn) {
        const error = isPlain(p.error) ? p.error : {};
        const data = isPlain(error.data) ? error.data : {};
        if (error.name === "MessageAbortedError") turn.error = undefined;
        else turn.error = String(data.message ?? error.name ?? "OpenCode reported an error").slice(0, 500);
        turn.busy = true;
      }
    };

    try {
      const password = randomBytes(24).toString("base64url");
      const config = openCodeConfig({
        model: options.model,
        modelUrl: `${proxy.url}/v1`,
        modelKey: proxyKey,
        mcpUrl: mcp.url,
        mcpKey,
        contextWindow: options.contextWindow,
        maxOutputTokens: options.maxOutputTokens ?? 32_000,
        ...(options.instructions ? { instructions: options.instructions } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
      });
      // The config, with the model proxy's and the MCP server's keys and the session's instructions, goes in a file only
      // this user reads, in the drive's private config directory, and OpenCode reads it from OPENCODE_CONFIG (the pinned
      // build loads that path as its custom config). Not in the environment: one environment string holds at most
      // 128 KiB on Linux (a longer one fails the spawn with E2BIG), and a process's environment is readable in
      // /proc/<pid>/environ.
      writeFileSync(configFile, JSON.stringify(config), { mode: 0o600, flag: "wx" });
      server = await startOpenCodeServer({
        command: options.command.command,
        args: options.command.args,
        cwd: root,
        password,
        signal,
        log,
        ...(options.env ? { from: options.env } : {}),
        ...(options.confine ? { confine: options.confine } : {}),
        ...(options.parentWatch ? { parentWatch: options.parentWatch } : {}),
        env: {
          ...(options.command.env ?? {}),
          HOME: dirs.home,
          XDG_CONFIG_HOME: dirs.config,
          XDG_DATA_HOME: dirs.data,
          XDG_CACHE_HOME: dirs.cache,
          XDG_STATE_HOME: dirs.state,
          TMPDIR: dirs.tmp,
          GIT_CEILING_DIRECTORIES: base,
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_CONFIG: configFile,
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENCODE_DISABLE_CLAUDE_CODE: "1",
          OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
          OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        },
      });
      const live = server;
      log("opencode: OpenCode listens", { url: live.url, mcp: mcp.url });

      // The event stream, open before anything is asked of the session (no event of a turn is missed): each try gets
      // `connectMs` to say `server.connected`, and a stream that does not, or that ends while OpenCode still runs, is
      // opened again, at most EVENT_TRIES times in the drive. After a reopen, OpenCode's own status says whether the turn
      // in flight ended in the gap.
      const connectMs = options.eventConnectMs ?? EVENT_CONNECT_MS;
      // A turn whose end may have passed while the stream was being opened again: OpenCode's status says.
      const caughtUp = async () => {
        const current = turn;
        if (!current?.accepted || !sessionID) return;
        const status = await live.request("GET", "/session/status", undefined, signal).catch(() => undefined);
        const mine = isPlain(status?.body) ? status.body[sessionID] : undefined;
        if (status?.status !== 200) return;
        // Still running: its busy status may have come while no one listened, so the turn is marked busy here, and its
        // idle, on the stream now open, ends it.
        if (isPlain(mine) && (mine.type === "busy" || mine.type === "retry")) {
          current.busy = true;
          return;
        }
        // The turn ended while no one listened: its answer and its error are what OpenCode recorded of it, read back, and
        // the text the session has not had yet is said before the turn ends.
        const listed = await live.request("GET", `/session/${sessionID}/message`, undefined, signal).catch(() => undefined);
        const messages = listed?.status === 200 && Array.isArray(listed.body) ? listed.body.filter(isPlain) : [];
        const asked = messages.findIndex((m) => isPlain(m.info) && m.info.id === current.messageID);
        for (const m of asked < 0 ? [] : messages.slice(asked + 1)) {
          const info = isPlain(m.info) ? m.info : {};
          if (info.role !== "assistant") continue;
          for (const part of Array.isArray(m.parts) ? m.parts.filter(isPlain) : []) {
            if (part.type === "tool") current.finalText = "";
            if (part.type !== "text" || typeof part.id !== "string" || typeof part.text !== "string") continue;
            const had = current.text.get(part.id) ?? "";
            if (part.text.length > had.length && part.text.startsWith(had)) ctx.live({ type: "text", delta: part.text.slice(had.length) });
            current.text.set(part.id, part.text);
            current.finalText = part.text;
          }
          const error = isPlain(info.error) ? info.error : undefined;
          if (error && error.name !== "MessageAbortedError") current.error = String((isPlain(error.data) ? error.data.message : undefined) ?? error.name ?? "OpenCode reported an error").slice(0, 500);
        }
        current.end(current.error ? { status: "failed", error: current.error } : { status: "completed" });
      };
      // The stream's end once it has no tries left, or once OpenCode stopped: a turn asked after it fails at once with it,
      // since no event of that turn could reach the drive (one in flight is ended by it here).
      let streamDown: string | undefined;
      let opened!: () => void;
      let refused!: (error: Error) => void;
      const open = new Promise<void>((resolve, reject) => {
        opened = resolve;
        refused = reject;
      });
      open.catch(() => {});
      void (async () => {
        for (let tries = 1; ; tries++) {
          const attempt = new AbortController();
          let connected = false;
          const timer = setTimeout(() => attempt.abort(new Error(`no server.connected within ${connectMs} ms`)), connectMs);
          let why = "it ended";
          try {
            for await (const event of live.events(AbortSignal.any([signal, attempt.signal]))) {
              if (event.type === "server.connected") {
                connected = true;
                clearTimeout(timer);
                opened();
                if (tries > 1) void caughtUp();
                continue;
              }
              onEvent(event);
            }
          } catch (error) {
            why = attempt.signal.aborted ? String((attempt.signal.reason as Error)?.message ?? attempt.signal.reason) : String((error as Error)?.message ?? error);
          } finally {
            clearTimeout(timer);
          }
          // The drive is stopping: whatever waits for the stream to open stops waiting too.
          if (signal.aborted) {
            refused(signal.reason instanceof Error ? signal.reason : new Error("the drive was stopped before OpenCode's event stream opened"));
            return;
          }
          await Promise.race([live.exited, sleep(250)]);
          if (!live.alive()) {
            const error = `OpenCode stopped: ${live.stderrTail().trim().slice(-300) || "its process ended"}`;
            streamDown = error;
            refused(new Error(`opencode: ${error}`));
            turn?.end({ status: "failed", error });
            return;
          }
          if (tries >= EVENT_TRIES) {
            const error = `OpenCode's event stream ${connected ? "ended" : "did not open"} ${EVENT_TRIES} times (${why})`;
            streamDown = error;
            refused(new Error(`opencode: ${error}`));
            turn?.end({ status: "failed", error });
            return;
          }
          log("opencode: the event stream is opened again", { tries, why: why.slice(0, 200) });
        }
      })();
      await open;

      // The session: given back from the log, or new.
      if (mirrored.length) {
        const answer = await live.request("POST", "/sync/replay", { directory: root, events: replayEvents(mirrored) }, signal);
        const id = isPlain(answer.body) ? answer.body.sessionID : undefined;
        if (answer.status !== 200 || id !== sessionID) throw new Error(`opencode: OpenCode did not take its session back from the log (${answer.status}): ${answer.text.slice(0, 300)}`);
      } else {
        // A title of its own: OpenCode asks the model for none.
        const answer = await live.request("POST", "/session", { title: "AgentRun session" }, signal);
        const id = isPlain(answer.body) ? answer.body.id : undefined;
        if (answer.status !== 200 || typeof id !== "string") throw new Error(`opencode: OpenCode did not open a session (${answer.status}): ${answer.text.slice(0, 300)}`);
        sessionID = id;
        await mirror();
      }

      const runTurn = async (text: string, submission: string): Promise<Outcome> => {
        const id = messageId(submission);
        // The id it is sent under, in the log first: a recovery knows whether OpenCode recorded it.
        journal.append(PROMPT_STREAM, { submission, messageID: id });
        await journal.flush();
        const ended = new Promise<Outcome>((resolve) => {
          turn = { messageID: id, busy: false, accepted: false, text: new Map(), finalText: "", end: (outcome) => resolve(outcome) };
        });
        // The stream is gone (read with the turn set and nothing awaited between, so a later end reaches the turn itself):
        // nothing is sent, and the turn ends here, in the records, with why.
        if (streamDown !== undefined) {
          turn = undefined;
          const gone: Outcome = { status: "failed", error: streamDown };
          journal.message({ type: "turn", ...gone } satisfies TranscriptEntry);
          await journal.flush();
          return gone;
        }
        const answer = await live.request("POST", `/session/${sessionID}/prompt_async`, {
          messageID: id,
          agent: AGENT,
          model: { providerID: "openai", modelID: options.model },
          parts: [{ type: "text", text }],
        }, signal);
        if (answer.status >= 300) {
          turn = undefined;
          // The turn ends here, in the records, saying why: OpenCode's status and its reason.
          const refusedTurn: Outcome = { status: "failed", error: `OpenCode refused the message (${answer.status}): ${answer.text.slice(0, 300)}` };
          journal.message({ type: "turn", ...refusedTurn } satisfies TranscriptEntry);
          await journal.flush();
          return refusedTurn;
        }
        if (turn) turn.accepted = true;
        const stop = new Promise<Outcome>((resolve) => signal.addEventListener("abort", () => resolve({ status: "interrupted" }), { once: true }));
        let outcome = await Promise.race([ended, stop]);
        const said = turn?.finalText ?? "";
        turn = undefined;
        if (signal.aborted) throw signal.reason;
        if (interrupting) outcome = { status: "interrupted" };
        await barrier();
        if (said) journal.message({ type: "message", role: "assistant", text: said });
        journal.message({ type: "turn", ...outcome } satisfies TranscriptEntry);
        await journal.flush();
        return outcome;
      };

      // A turn a crash cut off: the kernel's note, as a user message, with the user's own words when OpenCode never
      // recorded the message that carried them.
      const note = recoveryNote(ctx.state());
      if (note) {
        const sent = new Map(prompts.filter((p) => p.submission && p.messageID).map((p) => [p.submission!, p.messageID!]));
        const lost = note.turn.placed.some((s) => !sent.has(s) || !holdsMessage(mirrored, sent.get(s)!));
        const text = lost ? recoveryNote(ctx.state(), { prompts: true })!.text : note.text;
        journal.message({ type: "message", role: "user", text, synthetic: "recovery" });
        await placeSubmissions(ctx, note.pending);
        const outcome = await runTurn(text, `recovery:${transcriptCount(ctx.state())}`);
        if (interrupting) return void interrupting();
        void outcome;
      }
      // The inbox: one submission per turn.
      for (;;) {
        await ctx.refresh();
        const [s] = ctx.pending();
        if (!s) break;
        await placeSubmissions(ctx, [s]);
        await runTurn(s.text ?? "", s.id);
        if (interrupting) return void interrupting();
      }
    } finally {
      control?.(undefined);
      stopped.abort(new Error("the drive ended"));
      server?.kill();
      await Promise.race([server?.exited, sleep(5_000)]);
      // The host's tool calls still running settle before the drive ends, as codex's do: the next drive reads their real
      // outcome, and no retry runs beside them. Not on a stop, which aborts them (close() waits for those briefly).
      if (!ctx.signal.aborted) await mcp.settle(ctx.deadline !== undefined ? Math.max(0, ctx.deadline - Date.now()) : CALLS_SETTLE_MS);
      await mcp.close().catch(() => {});
      await proxy.close().catch(() => {});
      // The config held the drive's keys: it goes with the drive.
      rmSync(configFile, { force: true });
    }
  }
}

/** How many transcript entries the session has: a recovery turn's own id. */
function transcriptCount(state: SessionState): number {
  return transcriptOf(state).length;
}
