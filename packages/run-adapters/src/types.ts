// The seam between AgentRun's hosts and an agent harness that is not Pi, starting with Codex. It is harness-neutral.
// One interface serves both hosts: a DSL host's `runNode` (createHarnessRunner) and serve's runs. Nothing here
// imports a host.
import type { ProviderPolicy } from "./host/proxy.js";
import type { WorkflowDeps } from "@parcha/agentrun-dsl";
import type { Ended } from "./booking.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** What a node runner is asked, with the step it runs as under recovery and the node's own turn limit (#1061). */
export type NodeRequest = Parameters<NonNullable<WorkflowDeps["runNode"]>>[0] & {
  step?: { sessionId: string; attempt: number; earlierSessionIds: readonly string[] };
  /** An `agent` node's `max_turns`; applied within the runner's own cap. */
  maxTurns?: number;
};

/** An image a tool answers with: its media type (`image/png`) and its bytes, base64. */
export interface ToolImage {
  mimeType: string;
  data: string;
}

/**
 * The most characters a host tool's result reaches a harness with: its text as the model reads it (`text.length`). The
 * kernel's tool bridge, which every host tool's result passes on its way to a harness, cuts every result past it: its
 * start, cut where a character ends, then a line saying where it was cut (`[cut at N of M characters]`), the call's end
 * flagged `truncated`; the call's record keeps it whole. Each harness tells its CLI to pass a result this long to the
 * model whole: the Claude Agent CLI otherwise saves one past 50,000 characters to a file and tells the model to read it
 * (which a confined session cannot), and Codex cuts the middle of one past its truncation policy. The Claude Agent CLI
 * takes at most 500,000 here.
 */
export const HOST_RESULT_MAX_CHARS = 120_000;

/**
 * The error a turn ends with when its provider stopped the answer on its content filter (Anthropic's `refusal` stop, an
 * OpenAI answer `incomplete` for `content_filter`): a harness's model proxy reads the stop in the answer it passes
 * (`ProviderPolicy.filtered`) and the harness halts the turn with this text at once, so its CLI never asks for the refused
 * answer again. A host reads a run's end by it (agentrun-serve's `moderated`).
 */
export const CONTENT_FILTERED = "content_filter: the model provider stopped this answer";

/** A tool the host gives a session. */
export interface HostTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `safe`: may run again after a crash. `never`: at most once; a call a crash cut off is reported, never repeated. */
  replay: "safe" | "never";
  /** The tool's answer: its text (cut at HOST_RESULT_MAX_CHARS on its way to the harness), and any images it shows (a
   *  screenshot), which a harness that can show them sends the model with the text; `parked`: the host parked the call
   *  for a person's approval, so it did not run, and the text says it waits. `sessionDir` is the runner's own,
   *  when it has one: a tool that runs a node of its own (the delegate) gives its child a private directory the same
   *  way, by the child's key. */
  call(args: unknown, context: { callId: string; signal: AbortSignal; sessionDir?: (key: string) => string; /** The kernel's attempt at this call: 0 the first time; above 0 when a crash cut an earlier attempt of a replay-safe tool and this one runs it again, so the earlier one may have been sent. */ attempt?: number }): Promise<{ text: string; isError?: boolean; images?: readonly ToolImage[]; parked?: true }>;
}

/** A tool of a remote MCP server, as the server listed it when its owner saved it (the run's pinned copy). */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** What an MCP tool call answers the model: its text, and whether the tool said it failed. */
export interface McpCallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  /** The host parked the call for a person's approval: it did not run, and the text says it waits. The harness's own
   *  client never sees this flag (the door sends `content` and `isError`). */
  parked?: true;
}

/** A session's remote MCP servers: each one's granted tools, and the call that reaches them through the host, which holds
 *  their credentials. A harness with its own MCP client points it at the session's model proxy (`/mcp/<server>`). */
export interface SessionMcp {
  servers: readonly { name: string; tools: readonly McpTool[] }[];
  /** Never throws: a failure is an `isError` result the model reads. `callId` is the harness's id for the call. */
  call(server: string, tool: string, args: Record<string, unknown>, context: { signal: AbortSignal; callId?: string }): Promise<McpCallResult>;
}

/** One durable record of a session, in the order it was appended. */
export interface SessionRecord {
  kind: string;
  data: JsonValue;
}

/** Where a session's records live: the run's store, written through whoever owns it. A key is one session for its
 *  whole life, across processes. Records are written only through a writer, and one writer holds a session at a time:
 *  `open` takes the session, and from the moment it resolves every writer opened earlier for that key is fenced, whether
 *  or not the new one has written anything. A process whose lease lapsed while it was still alive therefore cannot write
 *  into a session a newer process holds. */
export interface SessionStore {
  read(key: string): Promise<SessionRecord[]>;
  /** Take the session. Resolves once the new holder is durable: every earlier writer of `key` is fenced from then on. */
  open(key: string): Promise<SessionWriter>;
}

/** The one holder that may write a session. */
export interface SessionWriter {
  readonly key: string;
  read(): Promise<SessionRecord[]>;
  /** Resolves once the records are durable, in order. Rejects with `SessionFenced`, writing none of them, once a newer
   *  `open` of the key has resolved. */
  append(records: readonly SessionRecord[]): Promise<void>;
  /** Make every record appended so far survive a lost box, not only a dead process: the kernel calls it after an
   *  effect's start and before the effect runs. A writer whose appends are durable already resolves at once. A wrapper
   *  passes it on (serialWriter): a writer without one is refused at the first effect that needs it. */
  sync(): Promise<void>;
}

/** What one session is. */
export interface SessionSpec {
  /** The session's durable identity: a node step's `sessionId`, or a key of the runner's own for a call with no step. */
  key: string;
  label: string;
  executionPath?: string;
  system: string[];
  /** Exactly these tools; the harness's own stay off. */
  tools: HostTool[];
  /** The remote MCP servers it may call, for a harness that has its own MCP client. */
  mcp?: SessionMcp;
  context: "fresh" | "fork";
  tier?: NodeRequest["tier"];
  effort?: NodeRequest["effort"];
  thinking?: NodeRequest["thinking"];
}

/** A paid model request, as the session is about to send it. */
export interface ModelRequest {
  model: string;
  /** The most input tokens the request can be billed for (the model proxy's `inputTokensMaxOf`: the body's UTF-8 bytes
   *  plus what the provider adds), undefined when it was not measured. */
  inputTokensMax?: number;
  /** The most output tokens the request asks for, when its body says (the proxy's policy reads it). */
  outputTokensAsked?: number;
  /** The least output it may be limited to and still answer: its answer's 1,024 tokens, plus the least thinking its
   *  provider takes when it thinks (the proxy's policy says). Absent: 1,024. */
  outputTokensLeast?: number;
  /** What it charges beside its tokens (a decision's per-request and per-image prices), in USD: held with them. */
  feeUsd?: number;
  /** A paid tool call, no model request (a web search's request, a monid call): held at `feeUsd` alone by the cap's tool
   *  rule, `name` and `basis` in a refusal's words. `call`: the tool call it was booked under, written on its
   *  runner.request so the run view puts its charge under that call. `charged_by`: who charges for it (the tool's
   *  provider: parallel, monid, an MCP server, a browser vendor), written there too, as main's charge row names it.
   *  `tool` and `tag`: the tool whose charge it is (a browser's, "browser") and its session, written there for the run
   *  view to place it as main's charge of that tool. `owed`: money its provider is already owed (a browser session's
   *  release, the time a person used): held at `feeUsd` and booked, never asked of the cap's rule, so a run past its cap
   *  or of unknown spend still counts it (main keeps it so: keepHold). */
  paid?: { name: string; basis: string; call?: string; charged_by?: string; tool?: string; tag?: string; owed?: true };
  /** A side call, never its turn's own: on another model than the session's (a client's title, a summary), or the
   *  host's own request beside the harness's (`host`). */
  side?: true;
  /** It carries the host's note (ModelPort.note) in its body: the note is delivered once this request is admitted.
   *  `inputTokensMaxWithoutNote`: its input measured as its client sent it, before the note was placed. */
  noted?: true;
  inputTokensMaxWithoutNote?: number;
  /** A request the host sent beside the harness's own, on the session's own route (its model proxy, under a side key
   *  the proxy minted for this label: ModelProxy.sideKey): a learned workflow's model node, say. The harness's own
   *  requests carry none, and it cannot send one that does: it holds only the session's key. */
  host?: string;
}

/** What a paid request cost, once it completed. */
export interface ModelUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Null when the price is unknown; `estimated` when it is not the provider's own figure (the host's price table's). */
  usd: number | null;
  estimated?: boolean;
  /** Beside the provider's own figure, what the host's price table makes of the same usage: kept to audit the table. */
  tableUsd?: number | null;
  /** A request a crash cut off: it left, and no answer came back to this run. Its tokens are unknown (0 here) and its
   *  price is null; the provider may have billed it. */
  cut?: boolean;
  /** A paid step's hold given back unused (a workflow call node's, its effect never sent the paid request it held for):
   *  nothing was sent and nothing charged, at usd 0. Its record says so, so no reader takes it for a $0 charge or an
   *  unpriced one. */
  givenBack?: true;
  /** The ids the provider's response gave the request, by header name (the provider's `request-id`, a gateway's call
   *  id such as LiteLLM's `x-litellm-call-id`): what joins this booking to the provider's own log. A cut request has
   *  them only if its response had begun. */
  providerIds?: Record<string, string>;
  /** A response its client stopped part way, its cost unknown, with what of it the client was sent (the model proxy's
   *  `stoppedAfterBytes`: its content's UTF-8 bytes where the policy reads it): the host counts it by what streamed
   *  (`Admission.stoppedUsd`), never more than its hold. */
  stoppedAfterBytes?: number;
  /** A stopped response's reasoning budget (the proxy's `stoppedHiddenTokens`): the part of it the reasoning it sent
   *  did not cover, max(0, budget - `stoppedReasoningBytes`), counts beside `stoppedAfterBytes`, never past the hold. */
  stoppedHiddenTokens?: number;
  /** The bytes of reasoning a stopped response sent (the proxy's `stoppedReasoningBytes`). */
  stoppedReasoningBytes?: number;
}

/** The session's model requests, through the runner: every paid request is announced before it is sent, and may be
 *  refused there (a turn cap, the host's budget); its usage is reported when it completes. */
export interface ModelPort {
  /** Admits a paid request, or throws to refuse it. It may return the request's ticket, which names the turn it was admitted as. */
  beforeRequest(request: ModelRequest): Promise<ModelTicket | void>;
  /** Books a completed request. `ticket` is what its own `beforeRequest` returned: requests may be in flight together, so
   *  an answer is booked under the turn it was admitted as, not the latest one. */
  /** `ended`: how the request ended, as the model proxy saw it (booking.ts), what it is booked by; absent (a host from
   *  before it), booked as before, by `usd` and `stoppedAfterBytes`. */
  afterRequest(usage: ModelUsage, ticket?: ModelTicket, ended?: Ended): Promise<void>;
  /** Records the ids a paid request's response gave it, as its headers arrive and before its answer is read. */
  responded?(ids: Record<string, string>, ticket?: ModelTicket): Promise<void>;
  /** A note its host has for the session's next main-model request (the spend cap's wrap-up), taken by this call; the
   *  session's model proxy adds it to that request's body (ModelProxyHooks.note). `request`: that request as its client
   *  sent it, measured before the note is placed (NoteRequest), so the host can price it as its admission will. */
  note?(model: string, request?: NoteRequest): string | undefined;
}

/** A request about to take its host's note, as its client sent it: its input bound and the output it asks for and needs
 *  at least, as the model proxy reads them (ModelRequest's figures, without the note). */
export type NoteRequest = { inputTokensMax?: number; outputTokensAsked?: number; outputTokensLeast?: number };

/** A paid request's admission: the turn it was admitted as, which its answer is booked under. */
export interface ModelTicket {
  turn: number;
  /** The most output tokens, thinking included, the request may be sent with: what is left of its host's spend cap can
   *  buy. The session's model proxy writes it into the body; absent, the request goes as asked. */
  outputTokensMax?: number;
  /** Admitted only without its host's note (ModelRequest.noted): its bytes did not fit what is left of the cap. The
   *  request goes as its client sent it, and the note waits for another request. */
  noteDropped?: true;
}

/** What the host lends a session. */
export interface SessionIO {
  /** The session's writer, opened by the runner for this attempt. The adapter writes through it and never opens the
   *  session itself, so a drive it restarts cannot take the session back from a newer process. */
  writer: SessionWriter;
  models: ModelPort;
  signal: AbortSignal;
  /** The session's private directory, when the host gives one: its HOME and the harness's own files. */
  dir?: string;
  /** The session's working directory, when the host gives one: the workspace its file tools confine to, absolute. A
   *  harness runs there, so a path the model builds from its working directory is one the host's tools take. Without it,
   *  a harness works in an empty directory of its own. */
  cwd?: string;
  onEvent(event: AdapterEvent): void;
  /** The host's gate, asked about a call of a host tool before anything of it is written (before its intent, and before
   *  the flush a call that runs at most once takes): "allow" runs it; a deny answers the model with the host's words and
   *  runs nothing; a park holds the call, writing nothing, until the session's signal is aborted (the run parks on a
   *  person). Absent: every call runs. */
  gate?(call: GateCall, context?: unknown): Promise<GateAnswer>;
}

/** A call as the host's gate is asked about it. */
export interface GateCall {
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** The host's answer before a call's intent: run it, refuse it in these words, or park the run on it. */
export type GateAnswer = "allow" | { readonly deny: string } | { readonly park: true };

/** An event of a session, as the adapter reports it. The runner adds the node it belongs to. A call's `tool_end` is sent
 *  only once its outcome is durable in the session's records, so a host never shows a result its store does not have;
 *  `result` is the text recorded, when the adapter reports it. A call stopped before its outcome was recorded gets no
 *  `tool_end`: its turn's `turn_end` closes it. */
export type AdapterEvent =
  | { type: "text"; delta: string }
  /** The model's message ended inside the turn, and another may follow in it (a CLI that resumes a cut answer itself):
   *  what it said so far is one message. */
  | { type: "text_end" }
  | { type: "tool_start"; callId: string; name: string; args: unknown; parent?: string }
  | { type: "tool_end"; callId: string; name: string; isError: boolean; result?: string; truncated?: true }
  /** `stopReason: "length"` only when the turn's final answer was cut at the model's output limit (unfinished), with that
   *  answer's output tokens when the adapter knows them: a host reads the answer as cut, never as the run's end. */
  | { type: "turn_end"; status: TurnStatus; stopReason?: "length"; outputTokens?: number };

/** An event as a host receives it: the adapter's, the runner's own, and the node each belongs to. */
export type HarnessEvent = (AdapterEvent
  | { type: "request_start"; turn: number; model: string }
  | { type: "request_end"; turn: number; usage: ModelUsage; ended?: Ended }) & { key: string; label: string; executionPath?: string };

export type TurnStatus = "completed" | "interrupted" | "failed";

/** A session as `open` found it: new, cut off inside a turn (the adapter owes a recovery turn), or between turns. */
export type SessionState = "new" | "open_turn" | "idle";

export interface AdapterSession {
  readonly state: SessionState;
  /** Place the input, then send it: a new turn. `id`: the input's own request id (a follow-up's, such as a raised run's
   *  turn), so placing it again is the same input, never the run's first one. `origin`: who wrote it when the person did
   *  not (a trigger's first input, its launch's): an adapter that keeps the run's record writes it with the input. */
  send(text: string, options?: { id?: string; origin?: { readonly [key: string]: unknown } }): Promise<void>;
  /** Resume the turn a crash cut off, from the session's records. Only when `state` is `open_turn`. */
  recover(): Promise<void>;
  /** Record the open turn as ended, interrupted, and send nothing: the turn is not to be resumed (a person stopped it, and
   *  an interrupt writes no end in the session). Only when `state` is `open_turn`; the session is `idle` after, here and
   *  when a later process opens it, and the next `send` is a turn of its own. A follow-up closes a cut turn the same way
   *  (kernel/follow-up.ts, FollowUpTarget.settleOpenTurn), naming its own prompt (`opening`): that one is withdrawn and
   *  never carried, and the rest is left as it is. */
  settleOpenTurn(options?: { opening?: string }): Promise<void>;
  /** Resolves when the turn in flight ends. */
  turnEnd(): Promise<{ status: TurnStatus; error?: string }>;
  /** Stop the turn in flight; calls it left open end interrupted. With `drainMs`, a pause: no new turn is sent, and the
   *  calls in flight run on until their outcomes are recorded, for at most `drainMs`, before the turn stops; the host
   *  refuses new calls and paid requests meanwhile (the runner's `stop` does). An adapter that cannot drain stops at
   *  once, as with no `drainMs`. It only stops the turn: the turn stays open in the session's records, and an adapter
   *  whose session can tell reads `open_turn` after it while it does, so a host that is done with the turn (a person's
   *  stop) settles it with `settleOpenTurn()`, and one that is not (a pause) leaves it for the next process. */
  interrupt(options?: { drainMs?: number }): Promise<void>;
  /** Stop the harness's processes and let go of the session. */
  close(): Promise<void>;
  /** A person's message placed in the turn in flight, at its next boundary, for a harness that takes one mid-turn (pi).
   *  `id`: the request id the placement carries (the host's command), so the host can tell the commit that placed it.
   *  `mode`: "steer" (the default) steers the turn in flight; "followUp" waits for the turn's end and runs as a turn of
   *  its own (a message that answers nothing, such as a trigger's). `origin`: who wrote it when the person did not (a
   *  trigger's message), kept on the message the harness records, as the Timeline shows it. Absent when the harness takes
   *  no message mid-turn: the host refuses the steer in words. */
  steer?(text: string, id?: string, mode?: "steer" | "followUp", options?: { readonly origin?: { readonly [key: string]: unknown } }): Promise<void>;
  /** The session's own model route, for a request the host sends beside the harness's own (a learned workflow's model
   *  node): its model proxy's address with a side key minted for `label` (ModelProxy.sideKey), the model its policy
   *  takes and the API it speaks. Undefined while no proxy is up (no turn has attached one yet). Every model request of
   *  a session goes through that one proxy: the same policy, origin, credential, price and booking. */
  port?(label: string): SessionPort | undefined;
}

/** The API a harness's model proxy speaks: what its provider, its keys and its catalog follow from. */
export type Wire = "anthropic-messages" | "openai-responses";

/** What a harness is, as its adapter states it: the host reads these and never branches on a harness's name. They
 *  describe the harness; none renames or reshapes what its model sees, and none turns its own built-ins, sandbox or
 *  session machine on. */
export interface AdapterFacts {
  /** The harness's id ("claude-agent", "codex", "opencode"). */
  readonly id: string;
  /** Its name in a sentence ("Claude", "Codex", "OpenCode"). */
  readonly label: string;
  /** The API its model proxy speaks. */
  readonly wire: Wire;
  /** Whether it takes a message mid-turn (else a message waits for the turn's end). */
  readonly steer: boolean;
  /** False when a tool call that started is never run again by a restart, replay-safe or not: the harness's own process
   *  holds the turn, and only its model calls again (a CLI). Absent: a restart reruns a replay-safe call, by the
   *  kernel's rule. */
  readonly rerunsStarted?: false;
  /** How many times the harness resumes an answer its model's output limit cut, itself, inside one turn (a CLI's own
   *  recovery): above 0, a turn never ends on such a cut until those run out; 0, a cut ends its turn, as pi's does.
   *  Absent: not declared. */
  readonly recoversCutAnswers?: number;
  /** What one run of it holds in memory, in MiB: the host admits runs by it. */
  readonly runMib: number;
  /** Whether it binds a session's remote MCP servers (its own MCP client, at the session's gateway). */
  readonly mcp: boolean;
  /** The thinking levels it takes, lowest first: a run's level above its highest runs at that highest. */
  readonly thinking: readonly ("low" | "medium" | "high" | "xhigh" | "max")[];
  /** Its own web search, when the provider runs it: `native`, the provider's search through the session's proxy (its
   *  input read at an allowance); `live`, the harness's own live search, booked per call. None: it has no search of
   *  its own. */
  readonly webSearch?: "native" | "live";
  /** Its model is its own, chosen on its own wire's settings, never the host's default for the other harnesses. */
  readonly ownModel: boolean;
  /** The model as the harness names it (Anthropic's id has no dot). */
  normalizeModel(model: { provider: string; modelId: string }): { provider: string; modelId: string };
  /** How it is installed and pinned: the line that installs it into a project, the package it pins, and the codes its
   *  own setup errors carry when installing (`install`) or the pinned build (`pins`) is the fix. */
  readonly install: { npmLine: string; spec: string; codes: { install: string; pins: string } };
  /** The problems its own MCP client has with a tool's input schema (`tool` as it names it, `mcp__<server>__<tool>`):
   *  shapes it drops or retypes, measured on its pinned build, so a grant of that tool would offer the model another
   *  tool than the one granted. None: its client takes any schema the kernel's check does. */
  schemaProblems?(tool: string, schema: Record<string, unknown>): string[];
  /** A name its client calls a session's MCP tool by beside `mcp__<server>__<tool>` (OpenCode's `<server>_<tool>`). */
  readonly toolAlias?: RegExp;
  /** Its CLI's own tools, by the name a call reaches the host by, each with the host's table tool it is (Claude's
   *  `Bash` is `bash`): a host holds such a call to that tool's setting. None: its CLI calls only the host's tools. */
  readonly nativeTools?: Readonly<Record<string, string>>;
  /** The policy its model proxy applies, for a host that serves the same route itself (a test's faux harness). */
  policy(options: { model: string; tools: readonly string[]; auth?: "bearer" | "x-api-key"; webSearch?: true | "live"; webSearchAllowance?: number; maxOutputTokens?: number }): ProviderPolicy;
}

/** A session's model proxy, as the host reaches it for its own requests beside the harness's (AdapterSession.port). */
export interface SessionPort {
  /** The proxy's origin, on the loopback interface with a port of its own (ModelProxy.url). */
  url: string;
  /** The side key the request presents, as a bearer token. */
  key: string;
  /** The model the session's policy takes (its own id, as the harness sends it). */
  model: string;
  /** The API the proxy serves: Anthropic's Messages (claude-agent) or OpenAI's Responses (codex, opencode). */
  api: "anthropic-messages" | "openai-responses";
}

export interface AdapterCapabilities {
  /** Its harness's own MCP client, when it has one: it calls `spec.mcp`'s servers at the session proxy's `/mcp/<server>`,
   *  which the kernel's model proxy mounts from the session's MCP and this fact (ModelProxyOptions.mcp). */
  mcpClient?: McpClient;
}

/** A harness's own MCP client, as its adapter declares it: the `_meta` key of a `tools/call` that carries the harness's
 *  own id for the call (Claude Code's `claudecode/toolUseId`, Codex's `callId`), the id its timeline and gate know the
 *  call by. The route reads that key and no other. */
export interface McpClient {
  callIdMeta: string;
}

export interface AgentAdapter {
  readonly id: string;
  capabilities(): AdapterCapabilities;
  /** Problems with a session before anything is spent; an empty list opens it. */
  check(spec: SessionSpec): string[];
  /** Opens the session, restoring it from `io.writer` when its key has records. */
  open(spec: SessionSpec, io: SessionIO): Promise<AdapterSession>;
}
