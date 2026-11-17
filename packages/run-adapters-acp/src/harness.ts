// One ACP agent driven over the session's records. Written for AgentRun.
//
// The agent is one process per kernel Drive (one per runner's hold of the session), started at the drive's first turn
// and ended with it: a turn after another goes to the same agent session, as a person's would. A drive:
//  1. makes the session's private HOME fresh and gives it back what the records mirrored of the agent's own session
//     store (state.ts), then the recipe's own files;
//  2. starts the agent (host/agent.ts: the environment allowlist, its own process group) and the adapter's MCP server
//     (host/mcp.ts: the host's tools, nothing else), and checks initialize against the recipe's declares;
//  3. gives the agent back its session (session/load, its replayed history kept off the timeline), or a new one, whose
//     first prompt carries the conversation so far when the agent cannot load (a context note);
//  4. runs the turn a crash cut off (the kernel's recovery note, as a user message), then each pending submission, one per
//     session/prompt;
//  5. sends each call of our tools through the kernel's tool bridge under the agent's own tool call id, and each
//     permission request for a tool of the agent's own through the host's gate, both journaled.
// ACP's own report of a tool call (its status, its content) is never trusted: what ran is what the bridge recorded.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type ContentBlock, type InitializeResponse, type McpServer as AcpMcpServer, type PermissionOption, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification, type SystemPrompt } from "@agentclientprotocol/sdk";
import type { GateAnswer, GateCall } from "@parcha/agentrun-kernel";
import type { DriveContext, HostTool, SessionState } from "@parcha/agentrun-kernel/kernel";
import { askGate, journalRecords, NativeJournal, openTurn, placeSubmissions, recoveryNote, resumeUnstartedCalls, toolBridge, toolKey, transcriptOf, type DanglingCall, type ToolBridge, type TranscriptEntry } from "@parcha/agentrun-kernel/process";
import type { ParentWatch } from "@parcha/agentrun-kernel/host";
import { canonical, CallIds, MCP_SERVER, ourTool, permissionCallId } from "./calls.js";
import { ACP_CODES } from "./facts.js";
import { homePath, type AcpRecipe } from "./recipe.js";
import { restoreState, STATE_STREAM, StateMirror, type StateRecord } from "./state.js";
import { startAgent, type AgentProcess } from "./host/agent.js";
import type { ConfineChild } from "./host/child.js";
import { startMcpServer, type McpServer } from "./host/mcp.js";

/** The agent's session id, one record each time a new agent session is opened. */
export const SESSION_STREAM = "acp.session";
/** One record per session/prompt sent (written just before it): the turns a plan-billed run counts. */
export const PROMPT_STREAM = "acp.prompt";
/** Our tools' calls as the MCP server took them (`seen`, before the gate) and as they ended (`answered`). */
export const CALL_STREAM = "acp.call";
/** The permission requests for the agent's own tools: `asked` before the gate is, `answered` with what it said. */
export const PERMISSION_STREAM = "acp.permission";
/** One record per tool call the agent announced (or MCP call it made unannounced): the calls a plan-billed run counts. */
export const TOOLS_STREAM = "acp.tools";

/** How long a session waits for the agent to start and answer initialize, or open its session. */
export const START_MS = 60_000;
/** How long an MCP call waits for the agent's tool_call that announces it. */
export const CALL_ID_WAIT_MS = 10_000;
/** How long a drive's end waits for the agent's process to go. */
const EXIT_WAIT_MS = 5_000;

/** The stdio MCP bridge the agent starts when it takes no MCP over HTTP. */
const STDIO_BRIDGE = fileURLToPath(new URL("./host/mcp-stdio.js", import.meta.url));

export interface AcpHarnessOptions {
  recipe: AcpRecipe;
  /** The kernel's tools: exactly the host's. */
  tools: HostTool[];
  /** The session's instructions. */
  instructions?: string;
  /** The session's own directory: its private HOME, tmp and (with no `cwd`) work directory are made in it. */
  dir: string;
  /** The workspace the agent runs in (absolute), or `<dir>/work`. */
  cwd?: string;
  confine?: ConfineChild;
  parentWatch?: ParentWatch;
  /** The environment the child's allowlist reads. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The host's gate (SessionIO.gate). Absent: every call runs. */
  gate?: (call: GateCall) => Promise<GateAnswer>;
  /** Proxy billing: what each agent process gets to reach the host's model proxy (its variables), closed with it. */
  proxy?: () => Promise<{ env: Record<string, string>; close(): Promise<void> }>;
  callIdWaitMs?: number;
  startMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** What the adapter holds of the drive in flight, to stop its turn. */
export interface DriveControl {
  /** Cancel the turn in flight (session/cancel): resolves true once the agent ended it within `ms`, with no end written
   *  for it (it stays open); false when the drive must be halted instead. */
  interrupt(ms: number): Promise<boolean>;
}

type Outcome = { status: "completed" | "interrupted" | "failed"; error?: string; stopReason?: "length" };

/** The turn in flight. */
interface Turn {
  final: string;
  limitHit?: string;
  /** Aborted when the turn ends or is cancelled: a permission request still waiting is answered cancelled. */
  stop: AbortController;
  ended: Promise<void>;
}

/** The drive call in flight: its journal and bridge, built for it. */
interface Current {
  ctx: DriveContext;
  journal: NativeJournal;
  bridge: ToolBridge;
  signal: AbortSignal;
  turn?: Turn;
}

/** One agent process and its session. */
interface Runtime {
  ctx: DriveContext;
  agent: AgentProcess;
  mcp: McpServer;
  sessionId: string;
  /** A new agent session (no load): an id an earlier call already took is a different call. */
  fresh: boolean;
  /** What the next prompt carries ahead of its own words (the instructions, the context note), once. */
  firstBlocks: string[];
  calls: CallIds;
  counted: Set<string>;
  asked: Map<string, number>;
  ownIds: Set<string>;
  mirror: StateMirror;
  loading: boolean;
  current?: Current;
  dispose(): Promise<void>;
}

type CallRecord = { type: "seen" | "answered"; callId: string; tool?: string; args?: unknown; text?: string; isError?: boolean; refused?: boolean };
type PermissionRecord = { type: "asked" | "answered"; callId: string; toolCallId?: string; title?: string; kind?: string; input?: unknown; answer?: "allow" | "deny"; words?: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const message = (error: unknown) => String((error as Error)?.message ?? error);
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`);
const indent = (text: string) => text.split("\n").map((line) => `    ${line}`).join("\n");

/** The submissions a drive marked as sent to the agent (PROMPT_STREAM), with those a recovery's send carried. */
export function sentSubmissions(state: SessionState): Set<string> {
  const ids = journalRecords<{ submission?: unknown; covers?: unknown }>(state, PROMPT_STREAM).flatMap((r) => [r.data?.submission, ...(Array.isArray(r.data?.covers) ? r.data.covers : [])]);
  return new Set(ids.filter((s): s is string => typeof s === "string"));
}

/** `promise`, or a rejection once `ms` passed. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** `promise`, or the signal's reason once it aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** The conversation before the open turn (all of it with none open), as a new agent session reads it: each user
 *  message, each answer and each call of ours with how it ended. Empty when there is none. */
export function contextNote(state: SessionState): string | undefined {
  const since = openTurn(state)?.since;
  const lines: { at: number; line: string }[] = [];
  state.effectOrder.forEach((effect, at) => {
    if (since !== undefined && at > since) return;
    if (effect.name.startsWith("tool.")) {
      const status = effect.status === "completed" ? "completed" : effect.status === "failed" ? (effect.error?.interrupted ? "interrupted, it may have taken effect" : "failed") : "never ended";
      lines.push({ at, line: `- ${effect.name.slice("tool.".length)}, call ${effect.key.slice("tool:".length)}: ${status}.` });
      return;
    }
    if (effect.placed.length === 0 || effect.name === "chaos") return;
    for (const id of effect.placed) {
      const submission = state.submissions.find((s) => s.id === id);
      if (!submission?.text || (submission.kind !== "prompt" && submission.kind !== "followUp" && submission.kind !== "steer")) continue;
      lines.push({ at, line: `- user: ${clip(submission.text, 2000).replace(/\n/g, "\n  ")}` });
    }
  });
  for (const record of transcriptOf(state)) {
    if (since !== undefined && record.at > since) continue;
    const entry = record.data;
    if (entry?.type === "message" && entry.role === "assistant" && entry.text) lines.push({ at: record.at, line: `- assistant: ${clip(entry.text, 2000).replace(/\n/g, "\n  ")}` });
  }
  if (lines.length === 0) return undefined;
  lines.sort((a, b) => a.at - b.at);
  return [
    "[Context] This conversation began in an earlier session of yours, which this one does not hold. What was said and done so far:",
    ...lines.map((l) => l.line),
    "",
    "Carry on from there.",
  ].join("\n");
}

/** The ACP harness. `control` is told of each drive call's stop hook while it runs. */
export function acpHarness(options: AcpHarnessOptions, control?: (drive: DriveControl | undefined) => void) {
  const log = options.log ?? (() => {});
  const recipe = options.recipe;
  const plan = recipe.billing.kind === "plan" ? recipe.billing : undefined;
  const listed = options.tools.filter((tool) => !tool.deferred);
  const names = new Set(listed.map((tool) => tool.name));
  let runtime: Runtime | undefined;

  /** The open turn's limit of tool calls, counted from the records: past it, the turn is cancelled with a named reason. */
  const countCall = (rt: Runtime, cur: Current, toolCallId: string): string | undefined => {
    if (rt.counted.has(toolCallId)) return cur.turn?.limitHit;
    rt.counted.add(toolCallId);
    cur.journal.append(TOOLS_STREAM, { toolCallId });
    if (!plan || cur.journal.length(TOOLS_STREAM) <= plan.maxToolCalls) return undefined;
    const turn = cur.turn;
    if (turn && !turn.limitHit) {
      turn.limitHit = `${ACP_CODES.toolCallLimit}: the plan's limit of ${plan.maxToolCalls} tool calls is reached; the turn was cancelled`;
      log("acp: a plan-billed run reached its limit of tool calls", { limit: plan.maxToolCalls });
      turn.stop.abort();
      void rt.agent.connection.agent.notify("session/cancel", { sessionId: rt.sessionId }).catch(() => {});
    }
    return turn?.limitHit ?? `${ACP_CODES.toolCallLimit}: the plan's limit of ${plan.maxToolCalls} tool calls is reached`;
  };

  const onUpdate = (rt: Runtime, notification: SessionNotification) => {
    if (rt.loading || notification.sessionId !== rt.sessionId) return;
    const cur = rt.current;
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const turn = cur?.turn;
        if (!cur || !turn || update.content.type !== "text") return;
        turn.final += update.content.text;
        cur.ctx.live({ type: "text", delta: update.content.text });
        return;
      }
      case "tool_call": {
        if (!cur) return;
        if (cur.turn) cur.turn.final = "";
        countCall(rt, cur, update.toolCallId);
        const tool = ourTool(update as { title?: string | null; name?: string | null }, names);
        if (tool) rt.calls.add(update.toolCallId, tool, update.rawInput);
        return;
      }
      case "tool_call_update": {
        // Its status is the agent's word only: what it changes is the mirror of the agent's session store.
        if (!cur || (update.status !== "completed" && update.status !== "failed")) return;
        rt.mirror.take(cur.journal);
        void cur.journal.flush().catch(() => {});
        return;
      }
      default:
        return;
    }
  };

  const onPermission = async (rt: Runtime, request: RequestPermissionRequest, connection: AbortSignal): Promise<RequestPermissionResponse> => {
    const choose = (kind: PermissionOption["kind"]): RequestPermissionResponse => {
      const option = request.options.find((o) => o.kind === kind);
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    };
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    const cur = rt.current;
    const turn = cur?.turn;
    if (!cur || !turn || turn.stop.signal.aborted) return turn?.limitHit ? choose("reject_once") : cancelled;
    if (turn.limitHit) return choose("reject_once");
    // Our own tool: the gate is the bridge's, asked at the MCP call itself. Allowed once, never always.
    if (ourTool(request.toolCall as { title?: string | null; name?: string | null }, names)) return choose("allow_once");
    const call = request.toolCall;
    const kind = typeof call.kind === "string" && call.kind ? call.kind : "other";
    const title = typeof call.title === "string" ? call.title : kind;
    const input = call.rawInput ?? null;
    const signature = canonical({ title, kind, input });
    const nth = rt.asked.get(signature) ?? 0;
    rt.asked.set(signature, nth + 1);
    const opened = openTurn(cur.ctx.state());
    const callId = permissionCallId(opened?.placed[0] ?? "", { title, kind, rawInput: input }, nth);
    const records = cur.journal.records<PermissionRecord>(PERMISSION_STREAM).map((r) => r.data).filter((r) => r?.callId === callId);
    const answered = records.find((r) => r.type === "answered");
    if (answered) return choose(answered.answer === "allow" ? "allow_once" : "reject_once");
    if (!records.some((r) => r.type === "asked")) {
      cur.journal.append(PERMISSION_STREAM, { type: "asked", callId, toolCallId: call.toolCallId, title, kind, input } satisfies PermissionRecord);
      await cur.journal.flush();
    }
    let refused: { deny: string } | undefined;
    if (options.gate) {
      try {
        refused = await askGate(options.gate, { callId, tool: `acp_${kind.replace(/[^A-Za-z0-9_]/g, "_")}`, args: { title, kind, input } }, AbortSignal.any([cur.signal, connection, turn.stop.signal]));
      } catch {
        // Parked, and the session let go (or the turn was cancelled): nothing is answered, nothing recorded.
        return cancelled;
      }
    }
    cur.journal.append(PERMISSION_STREAM, { type: "answered", callId, answer: refused ? "deny" : "allow", ...(refused ? { words: refused.deny } : {}) } satisfies PermissionRecord);
    await cur.journal.flush();
    return choose(refused ? "reject_once" : "allow_once");
  };

  const onMcpCall = async (rt: Runtime, name: string, args: Record<string, unknown>, callSignal: AbortSignal) => {
    const cur = rt.current;
    if (!cur) return { text: "acp: no turn is running to take this call", isError: true };
    const signal = AbortSignal.any([callSignal, cur.signal]);
    let callId = recipe.quirks?.mcpCall === "mint" ? undefined : await rt.calls.take(name, args, signal, options.callIdWaitMs ?? CALL_ID_WAIT_MS);
    if (!callId) {
      callId = `acp-${randomUUID()}`;
      countCall(rt, cur, callId);
    }
    if (cur.turn?.limitHit) return { text: cur.turn.limitHit, isError: true };
    // A new agent session counts its calls afresh: an id an earlier session's call took is another call.
    if (rt.fresh && !rt.ownIds.has(callId) && cur.ctx.state().effects.has(toolKey(callId))) callId = `${callId}@${rt.sessionId.slice(-12)}`;
    rt.ownIds.add(callId);
    if (!cur.journal.has(`seen:${callId}`)) cur.journal.append(CALL_STREAM, { type: "seen", callId, tool: name, args } satisfies CallRecord, { id: `seen:${callId}` });
    const result = await cur.bridge.call(name, args, callId, signal);
    if (!cur.journal.has(`answered:${callId}`)) cur.journal.append(CALL_STREAM, { type: "answered", callId, text: result.text, isError: result.isError, ...(result.refused ? { refused: true } : {}) } satisfies CallRecord, { id: `answered:${callId}` });
    await cur.journal.flush();
    return { text: result.text, isError: result.isError, ...(result.images?.length ? { images: result.images } : {}) };
  };

  /** Start the agent for `ctx` and open its session. */
  const start = async (ctx: DriveContext, journal: NativeJournal): Promise<Runtime> => {
    const base = normalize(options.dir);
    if (!isAbsolute(base)) throw new Error("acp: the session directory must be an absolute path");
    if (options.cwd !== undefined && !isAbsolute(options.cwd)) throw new Error("acp: the working directory must be an absolute path");
    const root = options.cwd === undefined ? join(base, "work") : normalize(options.cwd);
    const home = join(base, "home");
    const tmp = join(base, "tmp");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    // Everything the agent kept goes: what it starts with is the session's records, never an earlier process's files.
    for (const dir of [home, tmp]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const records = (await journal.read<StateRecord>(STATE_STREAM)).map((r) => r.data);
    restoreState(home, records);
    const own = new Set<string>();
    for (const [path, text] of Object.entries(recipe.files ?? {})) {
      const clean = homePath(path)!;
      const file = join(home, clean);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, text, { mode: 0o600 });
      own.add(clean.split("\\").join("/"));
    }

    const stopped = new AbortController();
    const signal = AbortSignal.any([ctx.signal, stopped.signal]);
    const key = randomBytes(32).toString("base64url");
    const rt = { ctx, loading: false, fresh: true, firstBlocks: [], calls: new CallIds(), counted: new Set(), asked: new Map(), ownIds: new Set(), sessionId: "", mirror: new StateMirror(home, (recipe.state ?? []).map((p) => homePath(p)!), own, records, log) } as unknown as Runtime;
    const mcp = await startMcpServer({ tools: listed.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> })), key, log, call: (name, args, callSignal) => onMcpCall(rt, name, args, callSignal) });
    let proxy: { env: Record<string, string>; close(): Promise<void> } | undefined;
    let agent: AgentProcess | undefined;
    let disposed: Promise<void> | undefined;
    rt.mcp = mcp;
    rt.dispose = () =>
      (disposed ??= (async () => {
        stopped.abort(new Error("the agent's drive ended"));
        if (agent) await Promise.race([agent.exited, sleep(EXIT_WAIT_MS)]);
        await mcp.close().catch(() => {});
        await proxy?.close().catch(() => {});
      })());
    ctx.signal.addEventListener("abort", () => void rt.dispose(), { once: true });
    try {
      if (recipe.billing.kind === "proxy") {
        if (!options.proxy) throw new Error("acp: proxy billing needs the adapter's proxy option");
        proxy = await options.proxy();
      }
      agent = startAgent({
        command: recipe.command,
        args: recipe.args ?? [],
        cwd: root,
        env: {
          ...(recipe.env ?? {}),
          ...(proxy?.env ?? {}),
          HOME: home,
          TMPDIR: tmp,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_STATE_HOME: join(home, ".local", "state"),
          GIT_CEILING_DIRECTORIES: base,
        },
        ...(options.env ? { from: options.env } : {}),
        ...(options.confine ? { confine: options.confine } : {}),
        ...(options.parentWatch ? { parentWatch: options.parentWatch } : {}),
        signal,
        onUpdate: (notification) => onUpdate(rt, notification),
        onPermission: (request, connection) => onPermission(rt, request, connection),
      });
      rt.agent = agent;
      const live = agent;
      const startMs = options.startMs ?? START_MS;
      const ask = <T>(what: string, run: () => Promise<T>) =>
        within(unlessAborted(run(), signal), startMs, what).catch((error: unknown) => {
          if (signal.aborted) throw signal.reason;
          if (!live.alive() || live.connection.signal.aborted) throw new Error(`${ACP_CODES.agentExited}: the agent ended during ${what}: ${live.stderrTail().trim().slice(-300) || message(error)}`);
          throw new Error(`acp: ${what} failed: ${message(error).slice(0, 300)}`);
        });
      const init: InitializeResponse = await ask("initialize", () =>
        live.connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "agentrun", version: "1" } }),
      );
      if (init.protocolVersion !== PROTOCOL_VERSION) throw new Error(`${ACP_CODES.protocolMismatch}: the agent speaks ACP version ${String(init.protocolVersion)}, the adapter version ${PROTOCOL_VERSION}`);
      const caps = init.agentCapabilities ?? {};
      const missing: string[] = [];
      if (recipe.declares.load && !caps.loadSession) missing.push("session/load (agentCapabilities.loadSession)");
      if (recipe.declares.mcp === "http" && !caps.mcpCapabilities?.http) missing.push("MCP over http (agentCapabilities.mcpCapabilities.http)");
      if (missing.length) throw new Error(`${ACP_CODES.capabilityMismatch}: the recipe declares ${missing.join(" and ")}, which the agent's initialize does not advertise`);

      const server: AcpMcpServer =
        recipe.declares.mcp === "http"
          ? { type: "http", name: MCP_SERVER, url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${key}` }] }
          : { name: MCP_SERVER, command: process.execPath, args: [STDIO_BRIDGE], env: [{ name: "AGENTRUN_MCP_URL", value: mcp.url }, { name: "AGENTRUN_MCP_KEY", value: key }] };
      const instructions = options.instructions?.trim() ? options.instructions : undefined;
      const systemPrompt: SystemPrompt | undefined = instructions && caps.sessionCapabilities?.systemPrompt ? { mode: "append", content: [{ type: "text", text: instructions }] } : undefined;
      const last = journalRecords<{ sessionId?: unknown }>(ctx.state(), SESSION_STREAM).map((r) => r.data?.sessionId).filter((id): id is string => typeof id === "string").at(-1);
      if (recipe.declares.load && last) {
        // The agent's history comes back as session/update notifications before the answer: kept off the timeline.
        rt.loading = true;
        try {
          await ask("session/load", () => live.connection.agent.request("session/load", { sessionId: last, cwd: root, mcpServers: [server], ...(systemPrompt ? { systemPrompt } : {}) }));
          rt.sessionId = last;
          rt.fresh = false;
        } catch (error) {
          if (signal.aborted || !live.alive()) throw error;
          log("acp: the agent did not load its session; a new one starts with the conversation so far", { error: message(error).slice(0, 300) });
        } finally {
          rt.loading = false;
        }
      }
      if (rt.fresh) {
        const opened = await ask("session/new", () => live.connection.agent.request("session/new", { cwd: root, mcpServers: [server], ...(systemPrompt ? { systemPrompt } : {}) }));
        rt.sessionId = opened.sessionId;
        journal.append(SESSION_STREAM, { sessionId: opened.sessionId });
        rt.mirror.take(journal);
        await journal.flush();
        if (instructions && !systemPrompt) rt.firstBlocks.push(`Instructions for this session, from the host that runs you:\n\n${instructions}`);
        const context = contextNote(ctx.state());
        if (context) rt.firstBlocks.push(context);
      }
      log("acp: the agent's session is open", { sessionId: rt.sessionId, loaded: !rt.fresh, pid: live.pid });
      return rt;
    } catch (error) {
      await rt.dispose();
      throw error;
    }
  };

  /** The calls of ours the open turn's records saw and never answered, in the order they were seen. */
  const danglingCalls = (state: SessionState): DanglingCall[] => {
    const since = openTurn(state)?.since ?? Number.POSITIVE_INFINITY;
    const records = journalRecords<CallRecord>(state, CALL_STREAM);
    const answered = new Set(records.filter((r) => r.data?.type === "answered").map((r) => r.data.callId));
    return records
      .filter((r) => r.at > since && r.data?.type === "seen" && !answered.has(r.data.callId) && typeof r.data.tool === "string")
      .map((r) => ({ callId: r.data.callId, tool: r.data.tool!, args: r.data.args ?? {} }));
  };

  async function driveOnce(ctx: DriveContext): Promise<void> {
    const journal = new NativeJournal(ctx);
    const gate = options.gate;
    // The gate is asked once the call's `seen` record is in the log: a call the gate parks is found again on a resume.
    const bridge = toolBridge(ctx, options.tools, {
      ...(gate ? { gate: async (call: GateCall) => (await journal.flush(), gate(call)) } : {}),
      beforeNever: () => journal.flush(),
    });
    const cur: Current = { ctx, journal, bridge, signal: ctx.signal };

    // A resumed session: each call of ours the agent made and the records never answered goes through the bridge before
    // the agent starts again. One that never reached its intent (a park held it) runs now, gate first; one whose end the
    // records hold is read back; one cut off is left to the recovery note. A refused one has no effect, so the note says
    // it here.
    const refusedLines: string[] = [];
    await resumeUnstartedCalls(ctx, bridge, danglingCalls(ctx.state()), async (call, outcome) => {
      journal.append(CALL_STREAM, { type: "answered", callId: call.callId, text: outcome.text, isError: outcome.isError } satisfies CallRecord, { id: `answered:${call.callId}` });
      await journal.flush();
      if (!ctx.state().effects.has(toolKey(call.callId))) refusedLines.push(`- ${call.tool}(${clip(JSON.stringify(call.args) ?? "{}", 300)}), call ${call.callId}: refused by the host. Its answer:`, indent(clip(outcome.text, 1500)));
    });

    let rt = runtime;
    if (!rt || rt.ctx !== ctx || !rt.agent.alive()) {
      if (rt) await rt.dispose();
      runtime = undefined;
      try {
        rt = await start(ctx, journal);
      } catch (error) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
        // The session cannot start: the turn ends here, in the records, saying why.
        await placeSubmissions(ctx, ctx.pending());
        journal.message({ type: "turn", status: "failed", error: message(error).slice(0, 1000) } satisfies TranscriptEntry);
        await journal.flush();
        return;
      }
      runtime = rt;
    }
    const agent = rt;
    let interrupting = false;
    agent.current = cur;
    control?.({
      async interrupt(ms) {
        const turn = cur.turn;
        if (!turn || !agent.agent.alive()) return false;
        interrupting = true;
        turn.stop.abort();
        await agent.agent.connection.agent.notify("session/cancel", { sessionId: agent.sessionId }).catch(() => {});
        return Promise.race([turn.ended.then(() => true), sleep(ms).then(() => false)]);
      },
    });

    const runTurn = async (body: string[], submission: string, covers: readonly string[] = []): Promise<Outcome> => {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      // A plan-billed run counts its session/prompt turns from the records, across runners.
      if (plan && journal.length(PROMPT_STREAM) >= plan.maxTurns) {
        const refused: Outcome = { status: "failed", error: `${ACP_CODES.turnLimit}: the plan's limit of ${plan.maxTurns} turns is reached; no more prompts are sent` };
        journal.message({ type: "turn", ...refused } as TranscriptEntry);
        await journal.flush();
        return refused;
      }
      // The send's mark, in the log first: a crash between the two reads "marked, maybe sent", never sent twice.
      journal.append(PROMPT_STREAM, { submission, ...(covers.length ? { covers: [...covers] } : {}) });
      await journal.flush();
      const prompt: ContentBlock[] = [...agent.firstBlocks.splice(0), ...body].map((text) => ({ type: "text", text }));
      let ended!: () => void;
      const turn: Turn = { final: "", stop: new AbortController(), ended: new Promise<void>((resolve) => (ended = resolve)) };
      cur.turn = turn;
      let answer: { stopReason?: string } | undefined;
      let failure: unknown;
      try {
        answer = await unlessAborted(agent.agent.connection.agent.request("session/prompt", { sessionId: agent.sessionId, prompt }), ctx.signal);
      } catch (error) {
        failure = error;
      } finally {
        cur.turn = undefined;
        turn.stop.abort();
        ended();
      }
      if (ctx.signal.aborted) throw ctx.signal.reason;
      agent.mirror.take(journal);
      // Cancelled by the session's interrupt: no end is written, the turn stays open (its host settles it).
      if (interrupting) {
        await journal.flush();
        return { status: "interrupted" };
      }
      let outcome: Outcome;
      if (turn.limitHit) outcome = { status: "failed", error: turn.limitHit };
      else if (failure !== undefined) {
        outcome = { status: "failed", error: agent.agent.alive() && !agent.agent.connection.signal.aborted ? `acp: session/prompt failed: ${message(failure).slice(0, 300)}` : `${ACP_CODES.agentExited}: the agent ended during the turn: ${agent.agent.stderrTail().trim().slice(-300) || message(failure).slice(0, 300)}` };
      } else {
        const reason = answer?.stopReason;
        if (reason === "end_turn") outcome = { status: "completed" };
        else if (reason === "max_tokens") outcome = { status: "completed", stopReason: "length" };
        else if (reason === "cancelled") outcome = { status: "interrupted" };
        else if (reason === "refusal") outcome = { status: "failed", error: `${ACP_CODES.refusal}: the agent refused to go on` };
        else if (reason === "max_turn_requests") outcome = { status: "failed", error: `${ACP_CODES.agentTurnRequests}: the agent stopped the turn at its own limit of requests` };
        else outcome = { status: "failed", error: `acp: the agent ended the turn with an unknown stop reason ${JSON.stringify(reason)}` };
      }
      if (turn.final) journal.message({ type: "message", role: "assistant", text: turn.final });
      journal.message({ type: "turn", ...outcome } as TranscriptEntry);
      await journal.flush();
      return outcome;
    };

    try {
      // A turn a crash cut off: the kernel's note (quoting the turn's prompts, which a new agent session never saw), as a
      // user message, with the pending messages it carries.
      const note = recoveryNote(ctx.state(), { prompts: true });
      if (note) {
        const text = refusedLines.length ? `${note.text}\n\nThe host answered these calls of yours since:\n${refusedLines.join("\n")}` : note.text;
        journal.message({ type: "message", role: "user", text, synthetic: "recovery" });
        await placeSubmissions(ctx, note.pending);
        await runTurn([text], `recovery:${transcriptOf(ctx.state()).length}`, [...note.turn.placed, ...note.pending.map((s) => s.id)]);
        if (interrupting) return;
      }
      // The inbox: one submission per turn.
      for (;;) {
        await ctx.refresh();
        const [submission] = ctx.pending();
        if (!submission) break;
        await placeSubmissions(ctx, [submission]);
        await runTurn([submission.text ?? ""], submission.id);
        if (interrupting) return;
      }
    } finally {
      control?.(undefined);
      if (agent.current === cur) agent.current = undefined;
    }
  }

  return {
    name: "acp",
    async drive(ctx: DriveContext): Promise<void> {
      if (!recoveryNote(ctx.state()) && ctx.pending().length === 0) return;
      await driveOnce(ctx);
    },
    /** End the agent's process and its MCP server. */
    async close(): Promise<void> {
      const rt = runtime;
      runtime = undefined;
      await rt?.dispose();
    },
  };
}
