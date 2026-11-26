// One ACP agent driven over the session's records. Written for AgentRun.
//
// The agent is one process per kernel Drive (one per runner's hold of the session), started at the drive's first turn
// and ended with it: a turn after another goes to the same agent session, as a person's would. A drive:
//  1. makes the session's private HOME fresh and gives it back what the records mirrored of the agent's own session
//     store (state.ts), then the recipe's own files and its allowFile, from the tools this start lists;
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
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, type ContentBlock, type InitializeResponse, type McpServer as AcpMcpServer, type PermissionOption, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification, type SystemPrompt } from "@agentclientprotocol/sdk";
import type { GateAnswer, GateCall } from "@parcha/agentrun-kernel";
import type { DriveContext, HostTool, SessionState } from "@parcha/agentrun-kernel/kernel";
import { askGate, journalRecords, NativeJournal, openTurn, placeSubmissions, recoveryNote, resumeUnstartedCalls, toolBridge, toolKey, transcriptOf, type DanglingCall, type ToolBridge, type TranscriptEntry } from "@parcha/agentrun-kernel/process";
import type { ParentWatch } from "@parcha/agentrun-kernel/host";
import { announceCall, announcedField, announcesAt, CallIds, declaresProperty, joinsByOne, mcpServerName, nameCall, namesTooLong, ourTool, permissionCallId, toolsLeftOut, type AcpAnnounces } from "./calls.js";
import { ACP_CODES } from "./facts.js";
import { allowFileText, homePath, type AcpRecipe } from "./recipe.js";
import { restoreState, STATE_STREAM, StateMirror, type StateRecord } from "./state.js";
import { startAgent, type AgentProcess } from "./host/agent.js";
import { cutKeys, keysToCut } from "./host/key-cut.js";
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
/** How many of the agent's own calls, in one turn, may park on the person while a call the person allowed on a resume is
 *  still not asked for again. At the limit the turn ends ACP_REASK_LIMIT on the resume, before the agent starts again: an
 *  agent that writes a new command after each restart (Cursor) never gets to the approved one. A call the gate answers
 *  without parking (a tool set to allow or to deny) is never counted. Read on the resume because a park commits the run
 *  parked before the gate answers. */
export const REASK_LIMIT = 3;
/** One record per tool call the agent announced (or MCP call it made unannounced): the calls a plan-billed run counts. */
export const TOOLS_STREAM = "acp.tools";
/** The model chosen for the agent's session (recipe.model, as the agent lists it), one record each time one is chosen. */
export const MODEL_STREAM = "acp.model";

/** How long a session waits for the agent to start and answer initialize, or open its session. */
export const START_MS = 60_000;
/** How long an MCP call waits for the agent's tool_call that announces it. */
export const CALL_ID_WAIT_MS = 10_000;
/** How long a drive's end waits for the agent's process to go. */
const EXIT_WAIT_MS = 5_000;
/** How long a failure read off an agent that went waits for its process's close, which comes once its stderr is read to
 *  the end: its connection closes at its stdout's end, which can come first. */
const LAST_WORDS_MS = 5_000;
/** How long an agent past the plan's limit of tool calls has to end its turn after session/cancel before its process is
 *  ended: past the limit, each moment it goes on is spent on the owner's plan. */
export const LIMIT_STOP_MS = 3_000;
/** How long a turn's end waits for the calls of ours still running in it to stop, once their signal is aborted. */
export const CALL_STOP_MS = 5_000;
/** The most of an earlier call's input, and of its result or error, a context note quotes. */
export const NOTE_INPUT_CHARS = 1_000;
export const NOTE_RESULT_CHARS = 2_000;

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
  /** Proxy billing: what each agent process gets to reach the host's model proxy (its variables), closed with it.
   *  `halt` ends the drive the process serves. */
  proxy?: (drive: { halt(reason: unknown): void }) => Promise<{ env: Record<string, string>; close(): Promise<void> }>;
  /** Run before every start of the agent's process, a restart included: the host's check of the binary it runs. A throw
   *  refuses that start, so a binary replaced after the adapter was made is checked before it ever runs. */
  beforeStart?: (command: string) => Promise<void>;
  callIdWaitMs?: number;
  startMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Log each call the agent announces ("acp: the agent announced a call": its toolCallId, kind, the word at the
   *  recipe's announces.tool and the tool of ours it named), on a recipe that declares announces, and again when a later
   *  update names a call announced with no name. Ids and names only. */
  debug?: boolean;
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
  /** The agent's text since its last call was announced or ended: its answer, unless nothing follows (then `kept`). */
  final: string;
  /** The text the agent wrote before a call of its ended (Cursor narrates between a call's announcement and its end):
   *  the answer only when the agent writes nothing after it. */
  kept: string;
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
  /** The calls of ours running: a turn ends (and an interrupt returns) only once they stopped. */
  inflight: Set<Promise<unknown>>;
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
  /** The name our MCP server is given to the agent under at this start (mcpServerName). */
  server: string;
  /** The recipe's announces as this start reads them, its prefix naming `server` (announcesAt). */
  announces: AcpAnnounces | undefined;
  counted: Set<string>;
  /** The permission call ids this agent process's requests took: each request of the open turn takes one of its own. */
  claimed: Set<string>;
  ownIds: Set<string>;
  mirror: StateMirror;
  /** Its private HOME was removed with its process (recipe.credentials): nothing is mirrored from it any more. */
  wiped: boolean;
  loading: boolean;
  current?: Current;
  dispose(): Promise<void>;
}

type CallRecord = { type: "seen" | "answered"; callId: string; tool?: string; args?: unknown; text?: string; isError?: boolean; refused?: boolean };
/** One record of an agent's own permission request:
 *  - `asked`: the request, as the agent sent it.
 *  - `answered`: what the gate said; `settled` when a resume took it before the agent started again, in `turn`.
 *  - `given`: the answer was handed to the agent, which uses it up.
 *  - `reasked`: this call was asked while an allow (`instead`) was still not asked for again. */
type PermissionRecord = { type: "asked" | "answered" | "given" | "reasked"; callId: string; toolCallId?: string; title?: string; kind?: string; input?: unknown; answer?: "allow" | "deny"; words?: string; settled?: true; turn?: string; instead?: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** An agent that ended, or whose connection closed: its stderr read to the end (its process's close), for at most
 *  LAST_WORDS_MS, so its last words (a refusal it names on its way out) are in its tail. One still running: at once. */
async function stderrRead(agent: AgentProcess): Promise<void> {
  if (agent.alive() && !agent.connection.signal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([agent.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, LAST_WORDS_MS); })]);
  clearTimeout(timer);
}
const message = (error: unknown) => String((error as Error)?.message ?? error);
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`);
const indent = (text: string) => text.split("\n").map((line) => `    ${line}`).join("\n");
/** A tool's recorded output as text: its text, never the bytes of an image it returned. */
const outputText = (output: unknown): string => {
  if (typeof output === "string") return output;
  const text = (output as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : (JSON.stringify(output) ?? String(output));
};

/** Whether every promise in `running` settled within `ms`. */
async function settledWithin(running: ReadonlySet<Promise<unknown>>, ms: number): Promise<boolean> {
  if (running.size === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
  return Promise.race([Promise.allSettled([...running]).then(() => true as const), late]).finally(() => clearTimeout(timer));
}

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
 *  message, each answer and each call of ours with its input and how it ended (its result, or its error), each cut to a
 *  bound (NOTE_INPUT_CHARS, NOTE_RESULT_CHARS) that says how much was left out. The inputs and results are quoted as
 *  the session's records hold them, as the kernel's recovery note quotes them. Empty when there is none. */
export function contextNote(state: SessionState): string | undefined {
  const since = openTurn(state)?.since;
  const lines: { at: number; line: string }[] = [];
  state.effectOrder.forEach((effect, at) => {
    if (since !== undefined && at > since) return;
    if (effect.name.startsWith("tool.")) {
      const head = `- ${effect.name.slice("tool.".length)}(${clip(JSON.stringify(effect.input ?? {}) ?? "{}", NOTE_INPUT_CHARS)}), call ${effect.key.slice("tool:".length)}:`;
      const line =
        effect.status === "completed"
          ? `${head} completed. Its result:\n${indent(clip(outputText(effect.output), NOTE_RESULT_CHARS))}`
          : effect.status === "failed" && !effect.error?.interrupted
            ? `${head} failed: ${clip(effect.error?.message || "the tool failed with no message", NOTE_RESULT_CHARS).replace(/\n/g, "\n    ")}`
            : effect.status === "failed"
              ? `${head} interrupted before it reported a result; it may have taken effect.`
              : `${head} never ended; it may have taken effect.`;
      lines.push({ at, line });
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
  const offered = options.tools.filter((tool) => !tool.deferred);
  /** Those the agent names past its cap under our server's name (namesTooLong), which it could never call: never listed,
   *  and each start says so (toolsLeftOut). The name's length is the same at every start (mcpServerName). */
  const capped = joinsByOne(recipe.announces) ? namesTooLong(announcesAt(recipe.announces, mcpServerName(recipe.announces)), offered.map((tool) => tool.name)) : [];
  const listed = offered.filter((tool) => !capped.includes(tool.name));
  const names = new Set(listed.map((tool) => tool.name));
  /** For each tool, the recipe's announces.extras its own input schema declares: kept in its arguments (announceCall). */
  const declared = new Map(listed.map((tool) => [tool.name, new Set((recipe.announces?.extras ?? []).filter((name) => declaresProperty(tool.inputSchema, name)))]));
  let runtime: Runtime | undefined;

  /** The recipe's refusal `text` (the agent's stderr, an error it answered) says, as `<code>: <words>`; undefined when it
   *  says none of them. */
  const refusalIn = (text: string): string | undefined => {
    const refusal = recipe.refusals?.find((r) => text.includes(r.says));
    return refusal && `${refusal.code}: ${refusal.words}`;
  };
  /** The values of the recipe's keys, read by name as the agent's start reads them: cut from anything the agent says
   *  before it is shortened (key-cut.ts), so no cut lands inside one. */
  const heldKeys = (): string[] => keysToCut((recipe.keys ?? []).map((name) => (options.env ?? process.env)[name]));
  /** An error's words, the recipe's keys cut, its first 300 characters. */
  const said = (error: unknown): string => cutKeys(message(error), heldKeys()).slice(0, 300);
  /** `text` (the agent's stderr, or an error carrying it) as a failure's words: the terminal's escapes out, the recipe's
   *  keys cut, and every line holding words the recipe calls quiet (recipe.quiet) left out, the last 300 characters of what
   *  is left. */
  // eslint-disable-next-line no-control-regex
  const ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]/g;
  const lastWords = (text: string): string =>
    cutKeys(text.replace(ESCAPES, ""), heldKeys())
      .split("\n")
      .filter((line) => !(recipe.quiet ?? []).some((words) => line.includes(words)))
      .join("\n")
      .trim()
      .slice(-300);
  /** A recipe whose agent's words are kept nowhere (recipe.stderr `none`: an agent on a person's sign-in, whose token no
   *  key cut knows): a failure says its exit status and the adapter's own codes, never a word the agent printed or
   *  answered. */
  const hushed = recipe.stderr === "none";
  /** An error's words for a failure: on a hushed run, an error the agent answered says its JSON-RPC code alone. */
  const agentSaid = (error: unknown): string => {
    if (!hushed) return said(error);
    const code = (error as { code?: unknown } | undefined)?.code;
    return typeof code === "number" ? `the agent answered error ${code}; its words are kept nowhere on this run` : said(error);
  };
  /** Why an agent that ended did: its last words on stderr, else the error's, else that it said nothing. On a hushed run,
   *  its exit status alone. */
  const whyEnded = (agent: { stderrTail(): string; ended(): string | undefined }, error: unknown): string =>
    hushed ? `${agent.ended() ?? "its end is not known yet"}; what it printed is kept nowhere on this run` : lastWords(agent.stderrTail()) || lastWords(message(error)) || "it said nothing";

  /** Mirror the agent's session store into `journal` (the caller flushes). A failure is said and never thrown: the next
   *  point takes the mirror again, and a turn's outcome is never lost to it. */
  const mirrorInto = (rt: Runtime, journal: NativeJournal) => {
    // A HOME removed with its process holds nothing to take: read now, it would say the agent deleted its whole store.
    if (rt.wiped) return;
    try {
      rt.mirror.take(journal);
    } catch (error) {
      log("acp: the mirror of the agent's session store failed; the next point takes it again", { error: said(error) });
    }
  };

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

  /** Debug only (serve's AGENTRUN_LOG=debug), on a recipe that declares announces: a call the agent announced, by its
   *  ids and names, never its input or the agent's text. The word at the recipe's field is quoted only when it names a
   *  tool of ours: on Cursor's recipe it sits inside the call's input, so another call's is "native" (null: none).
   *  Written at its tool_call, and again at the later update that names a call announced with no name (Cursor's). */
  const logAnnounced = (rt: Runtime, said: { readonly toolCallId: string; readonly kind?: string | null }) => {
    if (!options.debug || !recipe.announces) return;
    const ours = rt.calls.announced(said.toolCallId) ?? null;
    const field = announcedField(said, recipe.announces);
    log("acp: the agent announced a call", { toolCallId: said.toolCallId, kind: said.kind ?? null, field: field && (ours === null ? "native" : field), ours });
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
        if (cur.turn) cur.turn.final = cur.turn.kept = "";
        countCall(rt, cur, update.toolCallId);
        // Kept for the MCP call it may be, named by the recipe's announces field, never by its title (announceCall).
        announceCall(rt.calls, update, rt.announces, names, declared);
        logAnnounced(rt, update);
        return;
      }
      case "tool_call_update": {
        if (!cur) return;
        // A call the agent named only after announcing it with no input (Cursor's): by the recipe's field (nameCall).
        const held = rt.calls.held(update.toolCallId);
        nameCall(rt.calls, update, rt.announces, names, declared);
        if (held && !rt.calls.held(update.toolCallId)) logAnnounced(rt, update);
        // Its status is the agent's word only: what it changes is the mirror of the agent's session store.
        if (update.status !== "completed" && update.status !== "failed") return;
        // What the agent wrote before the call ended is set aside: what it writes after is the answer.
        if (cur.turn?.final.trim()) [cur.turn.kept, cur.turn.final] = [cur.turn.final, ""];
        // An ended call takes no MCP call's id (CallIds.settle).
        rt.calls.settle(update.toolCallId);
        mirrorInto(rt, cur.journal);
        void cur.journal.flush().catch(() => {});
        return;
      }
      default:
        return;
    }
  };

  /** The gate's call for a permission request of the agent's own tool: the same when the agent asks and when a resume
   *  asks about it again (settlePermissions), so both reach the one approval. Under its journal id (`callId`); its args
   *  carry the toolCallId the agent first asked under, so a host (harness-check) ties the question to the request. */
  const permissionGateCall = (callId: string, toolCallId: string | undefined, kind: string, title: string, input: unknown): GateCall => ({ callId, tool: `acp_${kind.replace(/[^A-Za-z0-9_]/g, "_")}`, args: { title, kind, input, ...(toolCallId ? { toolCallId } : {}) } });

  /** The recovery note's line for a settled answer: the request as the agent asked it (its kind, title and input, so an
   *  agent started without session/load can ask for the same call) and what the person said. */
  const answerLine = (asked: PermissionRecord | undefined, answer: PermissionRecord): string => {
    const kind = asked?.kind ?? "other";
    const input = asked?.input === undefined || asked.input === null ? "" : JSON.stringify(asked.input);
    const shown = input ? ` Its input: ${clip(input, 1500)}${input.length > 1500 ? " (cut here: ask with the whole input you first sent)" : ""}.` : "";
    const named = `${kind} ${JSON.stringify(clip(asked?.title ?? kind, 300))}.${shown}`;
    return answer.answer === "deny"
      ? `- ${named} The person refused it.${answer.words ? ` Their words: ${clip(answer.words, 500).replace(/\n/g, " ")}` : ""}`
      : `- ${named} The person allowed it once. Ask for it again exactly as before (the same kind, title and input) and it runs; any other request waits for the person again.`;
  };

  /** A resumed turn's waiting permission requests, each asked about again before the agent starts: the person's answer
   *  is taken whatever the agent asks next (an agent may write another command after its restart), and with none yet the
   *  gate parks the drive here, before any prompt is sent. The lines say every answer of the open turn the agent has not
   *  been given yet, those taken now and those an earlier drive took before it stopped, for the agent's recovery note.
   *  `limit`: the turn's other calls parked on the person REASK_LIMIT times while an allow went unasked, so the turn ends
   *  here, before the agent starts again. */
  const settlePermissions = async (ctx: DriveContext, journal: NativeJournal): Promise<{ lines: string[]; limit?: string }> => {
    const gate = options.gate;
    if (!gate) return { lines: [] };
    const turn = openTurn(ctx.state());
    const turnId = turn?.placed[0] ?? "";
    const since = turn?.since ?? Number.POSITIVE_INFINITY;
    const records = journalRecords<PermissionRecord>(ctx.state(), PERMISSION_STREAM).filter((r) => r.at > since).map((r) => r.data);
    const askedOf = (callId: string) => records.find((r) => r?.type === "asked" && r.callId === callId);
    const given = new Set(records.filter((r) => r?.type === "given").map((r) => r.callId));
    const said = records.filter((r) => r?.type === "answered" && r.settled && r.turn === turnId && !given.has(r.callId)).map((r) => answerLine(askedOf(r.callId), r));
    const answered = new Set(records.filter((r) => r?.type === "answered").map((r) => r.callId));
    const waiting = records.filter((r) => r?.type === "asked" && !answered.has(r.callId));
    for (const request of waiting) {
      const kind = request.kind ?? "other";
      const title = request.title ?? kind;
      const refused = await askGate(gate, permissionGateCall(request.callId, request.toolCallId, kind, title, request.input ?? null), ctx.signal);
      const answer = { type: "answered", callId: request.callId, answer: refused ? "deny" : "allow", ...(refused?.deny ? { words: refused.deny } : {}), settled: true, turn: turnId } satisfies PermissionRecord;
      journal.append(PERMISSION_STREAM, answer);
      await journal.flush();
      said.push(answerLine(request, answer));
      records.push(answer);
    }
    // A `reasked` call parked if a resume took its answer (settled; one the gate answered at once is not).
    const settledIds = new Set(records.filter((r) => r?.type === "answered" && r.settled).map((r) => r.callId));
    const parks = records.filter((r) => r?.type === "reasked" && r.turn === turnId && settledIds.has(r.callId));
    if (parks.length < REASK_LIMIT) return { lines: said };
    const approved = askedOf(parks.at(-1)?.instead ?? "");
    return { lines: said, limit: `${ACP_CODES.reaskLimit}: the agent asked ${parks.length} times for another command instead of the one the person allowed (${approved?.kind ?? "other"} ${JSON.stringify(clip(approved?.title ?? "", 300))}), each waiting for the person, so the turn ends here; the agent is not started again and nothing more of the plan is spent on it` };
  };

  const onPermission = async (rt: Runtime, request: RequestPermissionRequest, connection: AbortSignal): Promise<RequestPermissionResponse> => {
    const choose = (kind: PermissionOption["kind"]): RequestPermissionResponse => {
      const option = request.options.find((o) => o.kind === kind);
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
    };
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    // Said for every request, ours or the agent's own: ACP makes them optional, so a host (harness-check) reports whether
    // this agent asks at all.
    log("acp: the agent asked permission", { toolCallId: request.toolCall.toolCallId, kind: request.toolCall.kind ?? null });
    const cur = rt.current;
    const turn = cur?.turn;
    if (!cur || !turn || turn.stop.signal.aborted) return turn?.limitHit ? choose("reject_once") : cancelled;
    if (turn.limitHit) return choose("reject_once");
    // Our own tool, on a recipe that declares the title tie (quirks.permissionTie: Cursor's and Antigravity's): the gate
    // is the bridge's, asked at the MCP call itself, so the request is allowed once, never always. Cursor needs it: its
    // allowlist with allow: [] (which keeps it from writing files unasked) asks for every MCP call, ours included, and
    // agy asks for every MCP call. The
    // title is the agent's text, so the tie takes both: a request whose kind has no effects of its own and whose title
    // names our tool, for a call the recipe's announces field named as that same tool under the request's own id (a
    // title never sets that: CallIds.announced comes from the field alone). Without the
    // quirk (Goose, which asks nothing for our tools: its allowFile) every request is the host gate's, journaled.
    if (recipe.quirks?.permissionTie === "title") {
      const mine = ourTool(request.toolCall as { title?: string | null; name?: string | null; kind?: string | null }, names, rt.server);
      if (mine && rt.calls.announced(request.toolCall.toolCallId) === mine) return choose("allow_once");
    }
    const call = request.toolCall;
    const kind = typeof call.kind === "string" && call.kind ? call.kind : "other";
    const title = typeof call.title === "string" ? call.title : kind;
    const input = call.rawInput ?? null;
    // The request's id is the open turn's: the turn, what it asks, and which of the turn's requests that ask the same it
    // is. Of the ids this process has not taken and no agent was handed an answer for (`given`: an allow-once is used
    // once), it takes the first one answered (a resume took the answer; the agent asks again for it), else the first
    // unanswered one. With a gate no id is left waiting by now: settlePermissions answered them before the agent started.
    const opened = openTurn(cur.ctx.state());
    const turnId = opened?.placed[0] ?? "";
    const all = cur.journal.records<PermissionRecord>(PERMISSION_STREAM).map((r) => r.data);
    const answeredIds = new Set(all.filter((r) => r?.type === "answered").map((r) => r.callId));
    const givenIds = new Set(all.filter((r) => r?.type === "given").map((r) => r.callId));
    let callId: string | undefined;
    let firstAnswered: string | undefined;
    for (let nth = 0; callId === undefined; nth++) {
      const id = permissionCallId(turnId, { title, kind, rawInput: input }, nth);
      if (rt.claimed.has(id) || givenIds.has(id)) continue;
      if (answeredIds.has(id)) firstAnswered ??= id;
      else callId = firstAnswered ?? id;
    }
    rt.claimed.add(callId);
    const records = all.filter((r) => r?.callId === callId);
    const answered = records.find((r) => r.type === "answered");
    if (answered) {
      // An answer a resume took (settled) reaches the agent here: it asked again for the same call, and uses it up.
      cur.journal.append(PERMISSION_STREAM, { type: "given", callId, turn: turnId } satisfies PermissionRecord);
      await cur.journal.flush();
      return choose(answered.answer === "allow" ? "allow_once" : "reject_once");
    }
    if (!records.some((r) => r.type === "asked")) {
      // A new call while an allow the person gave on a resume is still not asked for: the agent asked for something else
      // instead (Cursor writes a new command after a restart). Marked `reasked` here, before the gate (whose park
      // commits the run parked before it answers): it counts toward REASK_LIMIT only if it parked, which the next resume
      // reads (settlePermissions). One the gate answers at once (a tool set to allow) is the turn going on.
      const unasked = all.find((r) => r?.type === "answered" && r.settled && r.turn === turnId && r.answer === "allow" && !givenIds.has(r.callId));
      if (unasked) cur.journal.append(PERMISSION_STREAM, { type: "reasked", callId, turn: turnId, instead: unasked.callId } satisfies PermissionRecord);
      cur.journal.append(PERMISSION_STREAM, { type: "asked", callId, toolCallId: call.toolCallId, title, kind, input } satisfies PermissionRecord);
      await cur.journal.flush();
    } else if (options.gate) {
      // Asked before and still unanswered, with a gate: settlePermissions answers every request a turn left waiting before
      // the agent starts, so this should not be. Where it is, a start skipped that step and the pick above (an answered id
      // before an unanswered one) may not be the call the person meant. Said, so a host's log shows it.
      log("acp: a request matched one still waiting for the person, which the resume should have answered before the agent started", { callId, toolCallId: call.toolCallId });
    }
    let refused: { deny: string } | undefined;
    if (options.gate) {
      // The toolCallId the request was first asked under, as the journal has it: the same question a resume asks.
      const askedAs = records.find((r) => r.type === "asked")?.toolCallId ?? call.toolCallId;
      try {
        refused = await askGate(options.gate, permissionGateCall(callId, askedAs, kind, title, input), AbortSignal.any([cur.signal, connection, turn.stop.signal]));
      } catch {
        // Parked, and the session let go (or the turn was cancelled): nothing is answered, nothing recorded.
        return cancelled;
      }
    }
    // Answered and handed to the agent at once: given with it, so a later ask of the same request is a call of its own.
    cur.journal.append(PERMISSION_STREAM, { type: "answered", callId, answer: refused ? "deny" : "allow", ...(refused ? { words: refused.deny } : {}) } satisfies PermissionRecord);
    cur.journal.append(PERMISSION_STREAM, { type: "given", callId, turn: turnId } satisfies PermissionRecord);
    await cur.journal.flush();
    return choose(refused ? "reject_once" : "allow_once");
  };

  const onMcpCall = async (rt: Runtime, name: string, args: Record<string, unknown>, callSignal: AbortSignal) => {
    const cur = rt.current;
    const turn = cur?.turn;
    if (!cur || !turn) return { text: "acp: no turn is running to take this call", isError: true };
    if (turn.limitHit) return { text: turn.limitHit, isError: true };
    // The call stops with its MCP request, the drive, or the turn (a cancel, the plan's limit): an agent that answers its
    // prompt `cancelled` and leaves the request open does not keep the tool running. The turn's end waits for it.
    const running = runMcpCall(rt, cur, name, args, AbortSignal.any([callSignal, cur.signal, turn.stop.signal]));
    cur.inflight.add(running);
    try {
      return await running;
    } finally {
      cur.inflight.delete(running);
    }
  };

  const runMcpCall = async (rt: Runtime, cur: Current, name: string, args: Record<string, unknown>, signal: AbortSignal) => {
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
    // The recipe's keys, read by name from the host's environment (a host may hold them readable by name alone), refused
    // before anything starts when one is not there.
    const hostEnv = options.env ?? process.env;
    const keyEnv: Record<string, string> = {};
    const absent: string[] = [];
    for (const name of recipe.keys ?? []) {
      // Read by its own name, handed under the one the agent reads (recipe.keyEnv): a value the host holds under that
      // name is never the agent's.
      const value = hostEnv[name];
      if (typeof value === "string" && value !== "") keyEnv[recipe.keyEnv?.[name] ?? name] = value;
      else absent.push(name);
    }
    if (absent.length) throw new Error(`${ACP_CODES.keyMissing}: ${recipe.label ?? recipe.id} runs on ${absent.join(" and ")}, which this host does not hold; the agent was not started`);
    // A tool of ours the agent would name past its cap is not listed (capped); the run is told which, and goes on.
    const serverName = mcpServerName(recipe.announces);
    if (capped.length) {
      const words = toolsLeftOut(recipe.label ?? recipe.id, announcesAt(recipe.announces, serverName)?.prefix ?? "", capped);
      log("acp: tools left out of the agent's listing, named past its cap", { tools: capped });
      ctx.live({ type: "notice", text: words });
    }
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
    // The recipe's allowFile (Goose's permission file): the tools this start lists, in the agent's own form, and nothing
    // else, so the agent runs them unasked and our gate asks at the MCP call.
    const allowed = recipe.allowFile ? { [recipe.allowFile.path]: allowFileText(recipe.allowFile.form, listed.map((tool) => tool.name)) } : {};
    for (const [path, text] of [...Object.entries(recipe.files ?? {}), ...Object.entries(allowed)]) {
      const clean = homePath(path);
      if (!clean) throw new Error(`acp: the file ${JSON.stringify(path)} must be inside the private HOME`);
      const file = join(home, clean);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, text, { mode: 0o600 });
      own.add(clean.split("\\").join("/"));
    }
    // The credentials the recipe names are never written: each path is an empty folder the agent cannot write a file at,
    // so an agent that tolerates a failed save (Cursor 2026.11.13 says so on stderr and runs on the key in its env) holds
    // its credential in memory alone, and a hard kill leaves none on disk. Nor are they mirrored, whatever their names and
    // wherever the recipe's state paths reach.
    for (const path of recipe.credentials ?? []) {
      const clean = homePath(path)!;
      mkdirSync(join(home, clean), { recursive: true, mode: 0o700 });
      chmodSync(join(home, clean), 0o500);
      own.add(clean.split("\\").join("/"));
    }

    const stopped = new AbortController();
    const signal = AbortSignal.any([ctx.signal, stopped.signal]);
    const key = randomBytes(32).toString("base64url");
    const rt = { ctx, loading: false, fresh: true, wiped: false, firstBlocks: [], calls: new CallIds(), server: serverName, announces: announcesAt(recipe.announces, serverName), counted: new Set(), claimed: new Set(), ownIds: new Set(), sessionId: "", mirror: new StateMirror(home, (recipe.state ?? []).map((p) => homePath(p)!), own, records, log, (words) => (rt.current?.ctx ?? ctx).live({ type: "notice", text: words })) } as unknown as Runtime;
    const mcp = await startMcpServer({ tools: listed.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> })), key, log, call: (name, args, callSignal) => onMcpCall(rt, name, args, callSignal) });
    let proxy: { env: Record<string, string>; close(): Promise<void> } | undefined;
    let agent: AgentProcess | undefined;
    let disposed: Promise<void> | undefined;
    /** Close the proxy this start holds, once: whoever comes first (the drive's end, or a start the stop overtook). */
    const closeProxy = async () => {
      const open = proxy;
      proxy = undefined;
      await open?.close().catch(() => {});
    };
    rt.mcp = mcp;
    rt.dispose = () =>
      (disposed ??= (async () => {
        stopped.abort(new Error("the agent's drive ended"));
        if (agent) await Promise.race([agent.exited, sleep(EXIT_WAIT_MS)]);
        await mcp.close().catch(() => {});
        await closeProxy();
        // A recipe that names a credential the agent derives from its key (Cursor's auth.json): its HOME and tmp go with
        // its process, whole, so no credential outlives the drive. What the next start needs comes back from the records.
        if (recipe.credentials?.length) {
          rt.wiped = true;
          for (const dir of [home, tmp]) {
            try {
              rmSync(dir, { recursive: true, force: true });
            } catch (error) {
              log("acp: the agent's private HOME could not be removed", { dir, error: said(error) });
            }
          }
        }
      })());
    ctx.signal.addEventListener("abort", () => void rt.dispose(), { once: true });
    try {
      if (options.beforeStart) await unlessAborted(options.beforeStart(recipe.command), signal);
      if (recipe.billing.kind === "proxy") {
        if (!options.proxy) throw new Error("acp: proxy billing needs the adapter's proxy option");
        proxy = await options.proxy({ halt: (reason) => ctx.halt?.(reason) });
        // A stop while the proxy started: the drive's end ran before there was a proxy to close. It is closed here, and
        // the agent is never started.
        if (signal.aborted) {
          await closeProxy();
          throw signal.reason ?? new Error("acp: the drive ended while the proxy started");
        }
      }
      agent = startAgent({
        command: recipe.command,
        args: recipe.args ?? [],
        cwd: root,
        env: {
          ...(recipe.env ?? {}),
          ...keyEnv,
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
        keys: Object.values(keyEnv),
        ...(hushed ? { stderr: "none" as const } : {}),
        signal,
        onUpdate: (notification) => onUpdate(rt, notification),
        onPermission: (request, connection) => onPermission(rt, request, connection),
      });
      rt.agent = agent;
      const live = agent;
      const startMs = options.startMs ?? START_MS;
      const ask = <T>(what: string, run: () => Promise<T>) =>
        within(unlessAborted(run(), signal), startMs, what).catch(async (error: unknown) => {
          if (signal.aborted) throw signal.reason;
          // An agent that says why on its way out: its stderr is read once it has ended.
          await stderrRead(live);
          const named = refusalIn(`${live.stderrTail()}\n${message(error)}`);
          if (named) throw new Error(named);
          if (!live.alive() || live.connection.signal.aborted) throw new Error(`${ACP_CODES.agentExited}: the agent ended during ${what}: ${whyEnded(live, error)}`);
          throw new Error(`acp: ${what} failed: ${agentSaid(error)}`);
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
      // The recipe's sign-in method, told before any session opens: one the agent lists, or none is tried.
      if (recipe.authMethod) {
        const methods = (init.authMethods ?? []).map((method) => method.id);
        if (!methods.includes(recipe.authMethod)) throw new Error(`${ACP_CODES.authUnlisted}: ${recipe.label ?? recipe.id} signs in with ${recipe.authMethod}, which its initialize does not list (${methods.join(", ") || "it lists none"}); no session was opened`);
        try {
          await ask("authenticate", () => live.connection.agent.request("authenticate", { methodId: recipe.authMethod! }));
        } catch (error) {
          if (signal.aborted || !live.alive()) throw error;
          throw new Error(`${ACP_CODES.authFailed}: ${recipe.label ?? recipe.id} refused its sign-in method ${recipe.authMethod}: ${message(error).replace(/^acp: authenticate failed: /, "")}; no session was opened`);
        }
      }

      const server: AcpMcpServer =
        recipe.declares.mcp === "http"
          ? { type: "http", name: rt.server, url: mcp.url, headers: [{ name: "Authorization", value: `Bearer ${key}` }] }
          : { name: rt.server, command: process.execPath, args: [STDIO_BRIDGE], env: [{ name: "AGENTRUN_MCP_URL", value: mcp.url }, { name: "AGENTRUN_MCP_KEY", value: key }] };
      const instructions = options.instructions?.trim() ? options.instructions : undefined;
      const systemPrompt: SystemPrompt | undefined = instructions && caps.sessionCapabilities?.systemPrompt ? { mode: "append", content: [{ type: "text", text: instructions }] } : undefined;
      const last = journalRecords<{ sessionId?: unknown }>(ctx.state(), SESSION_STREAM).map((r) => r.data?.sessionId).filter((id): id is string => typeof id === "string").at(-1);
      /** What session/load or session/new answered: the models it lists, for one. */
      let opening: unknown;
      if (recipe.declares.load && last) {
        // The agent's history comes back as session/update notifications before the answer: kept off the timeline.
        rt.loading = true;
        try {
          opening = await ask("session/load", () => live.connection.agent.request("session/load", { sessionId: last, cwd: root, mcpServers: [server], ...(systemPrompt ? { systemPrompt } : {}) }));
          rt.sessionId = last;
          rt.fresh = false;
        } catch (error) {
          if (signal.aborted || !live.alive()) throw error;
          log("acp: the agent did not load its session; a new one starts with the conversation so far", { error: agentSaid(error) });
        } finally {
          rt.loading = false;
        }
      }
      if (rt.fresh) {
        const opened = await ask("session/new", () => live.connection.agent.request("session/new", { cwd: root, mcpServers: [server], ...(systemPrompt ? { systemPrompt } : {}) }));
        rt.sessionId = opened.sessionId;
        journal.append(SESSION_STREAM, { sessionId: opened.sessionId });
        mirrorInto(rt, journal);
        await journal.flush();
        if (instructions && !systemPrompt) rt.firstBlocks.push(`Instructions for this session, from the host that runs you:\n\n${instructions}`);
        const context = contextNote(ctx.state());
        if (context) rt.firstBlocks.push(context);
        opening = opened;
      }
      if (recipe.model !== undefined) {
        // The run's model, among those the agent lists for its key: by its id, else by its name before the brackets.
        // A loaded session that lists none keeps the one chosen for it before (MODEL_STREAM).
        const models = (opening as { models?: { availableModels?: unknown } } | undefined)?.models?.availableModels;
        const ids = Array.isArray(models) ? models.map((m) => (m as { modelId?: unknown })?.modelId).filter((id): id is string => typeof id === "string") : undefined;
        const before = journalRecords<{ modelId?: unknown }>(ctx.state(), MODEL_STREAM).map((r) => r.data?.modelId).filter((id): id is string => typeof id === "string").at(-1);
        const wanted = recipe.model;
        const chosen = ids ? (ids.find((id) => id === wanted) ?? ids.find((id) => id.split("[")[0] === wanted)) : rt.fresh ? undefined : before;
        if (!chosen) {
          const said = ids?.length ? `it lists ${ids.join(", ")}` : "it lists none";
          throw new Error(`${ACP_CODES.modelUnlisted}: the model ${JSON.stringify(wanted)} is not one ${recipe.label ?? recipe.id} lists for this key (${said}); no prompt was sent`);
        }
        await ask("session/set_model", () => live.connection.agent.request("session/set_model", { sessionId: rt.sessionId, modelId: chosen }));
        if (chosen !== before) {
          journal.append(MODEL_STREAM, { modelId: chosen });
          await journal.flush();
        }
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
    const cur: Current = { ctx, journal, bridge, signal: ctx.signal, inflight: new Set() };

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
    // So is each request for a tool of the agent's own the turn left waiting: its answer is taken now, or the drive parks
    // here, with no agent started and no prompt sent. Past REASK_LIMIT, the open turn ends here, saying so, with nothing
    // of the inbox placed: a message sent while the run waited is a turn of its own, below, the agent started for it.
    const { lines: permissionLines, limit: reaskLimit } = await settlePermissions(ctx, journal);
    if (reaskLimit) {
      log("acp: the agent kept asking for other calls instead of the allowed one", { limit: REASK_LIMIT });
      journal.message({ type: "turn", status: "failed", error: reaskLimit } satisfies TranscriptEntry);
      await journal.flush();
      await ctx.refresh();
      if (ctx.pending().length === 0) return;
    }

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
        // The turn's stop aborts the calls of ours running in it; its end waits for them to stop (runTurn), so true says
        // both the agent and our tools let go: none writes through this drive's journal after it.
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
      const turn: Turn = { final: "", kept: "", stop: new AbortController(), ended: new Promise<void>((resolve) => (ended = resolve)) };
      cur.turn = turn;
      let answer: { stopReason?: string } | undefined;
      let failure: unknown;
      // Past the plan's limit of tool calls the turn is cancelled (countCall); an agent that goes on anyway has
      // LIMIT_STOP_MS, then its process is ended.
      let limitTimer: NodeJS.Timeout | undefined;
      const pastLimit = new Promise<"past limit">((resolve) =>
        turn.stop.signal.addEventListener("abort", () => void (turn.limitHit && (limitTimer = setTimeout(() => resolve("past limit"), LIMIT_STOP_MS))), { once: true }),
      );
      try {
        const asked = agent.agent.connection.agent.request("session/prompt", { sessionId: agent.sessionId, prompt });
        asked.catch(() => {});
        const result = await unlessAborted(Promise.race([asked, pastLimit]), ctx.signal);
        if (result === "past limit") {
          log("acp: the agent went on past the plan's limit after session/cancel; its process is ended", { waitedMs: LIMIT_STOP_MS });
          // Its store is taken before its process ends: a recipe with a credential loses its HOME with it.
          mirrorInto(agent, journal);
          await agent.dispose();
          if (runtime === agent) runtime = undefined;
        } else answer = result;
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(limitTimer);
        cur.turn = undefined;
        turn.stop.abort();
        // The calls of ours still running were told to stop (the turn's signal): the turn ends once they did, so none
        // writes to the records after it.
        if (!(await settledWithin(cur.inflight, CALL_STOP_MS))) log("acp: a call of ours did not stop with its turn", { waitedMs: CALL_STOP_MS });
        ended();
      }
      if (ctx.signal.aborted) throw ctx.signal.reason;
      mirrorInto(agent, journal);
      // Cancelled by the session's interrupt: no end is written, the turn stays open (its host settles it).
      if (interrupting) {
        await journal.flush();
        return { status: "interrupted" };
      }
      let outcome: Outcome;
      if (turn.limitHit) outcome = { status: "failed", error: turn.limitHit };
      else if (failure !== undefined) {
        // An agent that says why on its way out: its stderr is read once it has ended.
        await stderrRead(agent.agent);
        const named = refusalIn(`${agent.agent.stderrTail()}\n${message(failure)}`);
        outcome = { status: "failed", error: named ?? (agent.agent.alive() && !agent.agent.connection.signal.aborted ? `acp: session/prompt failed: ${agentSaid(failure)}` :`${ACP_CODES.agentExited}: the agent ended during the turn: ${whyEnded(agent.agent, failure)}`) };
      } else {
        const reason = answer?.stopReason;
        if (reason === "end_turn") outcome = { status: "completed" };
        else if (reason === "max_tokens") outcome = { status: "completed", stopReason: "length" };
        else if (reason === "cancelled") outcome = { status: "interrupted" };
        else if (reason === "refusal") outcome = { status: "failed", error: `${ACP_CODES.refusal}: the agent refused to go on` };
        else if (reason === "max_turn_requests") outcome = { status: "failed", error: `${ACP_CODES.agentTurnRequests}: the agent stopped the turn at its own limit of requests` };
        else outcome = { status: "failed", error: `acp: the agent ended the turn with an unknown stop reason ${JSON.stringify(reason)}` };
      }
      // Only whitespace after the call (a trailing newline) is no answer of its own: the text before it is.
      const lastText = turn.final.trim() ? turn.final : turn.kept;
      if (lastText) journal.message({ type: "message", role: "assistant", text: lastText });
      journal.message({ type: "turn", ...outcome } as TranscriptEntry);
      await journal.flush();
      return outcome;
    };

    try {
      // A turn a crash cut off: the kernel's note (quoting the turn's prompts, which a new agent session never saw), as a
      // user message, with the pending messages it carries.
      const note = reaskLimit ? undefined : recoveryNote(ctx.state(), { prompts: true });
      if (note) {
        const text = [
          note.text,
          ...(refusedLines.length ? [`The host answered these calls of yours since:\n${refusedLines.join("\n")}`] : []),
          ...(permissionLines.length ? [`The person answered these requests of yours while the run waited:\n${permissionLines.join("\n")}`] : []),
        ].join("\n\n");
        journal.message({ type: "message", role: "user", text, synthetic: "recovery" });
        await placeSubmissions(ctx, note.pending);
        await runTurn([text], `recovery:${transcriptOf(ctx.state()).length}`, [...note.turn.placed, ...note.pending.map((s) => s.id)]);
        // Interrupted, or the agent's process ended (past the plan's limit): the next turn is the next drive's.
        if (interrupting || !agent.agent.alive()) return;
      }
      // The inbox: one submission per turn.
      for (;;) {
        await ctx.refresh();
        const [submission] = ctx.pending();
        if (!submission) break;
        await placeSubmissions(ctx, [submission]);
        await runTurn([submission.text ?? ""], submission.id);
        if (interrupting || !agent.agent.alive()) return;
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
