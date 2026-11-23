// GitHub Copilot CLI: $COPILOT_HOME (~/.copilot)/session-state/<session id>/events.jsonl, one session event a line
// ({type, data, id, parentId, timestamp, agentId?, checkpoint?}); an older CLI wrote session-state/<session id>.jsonl.
// Sources: github/copilot-cli changelog.md (0.0.342: sessions in ~/.copilot/session-state; 0.0.422: "Session usage
// metrics (requests, tokens, code changes) are now persisted to events.jsonl after each session ends"); github/copilot-sdk
// at 5378d2d47d nodejs/src/generated/session-events.ts (the event schema), docs/features/session-persistence.md (the
// folder, events.N.jsonl archives and checkpoint records), docs/features/streaming-events.md (which events are persisted)
// and docs/features/usage-and-billing.md (inputTokens holds the cache read and write); @github/copilot 1.0.40 and
// 1.0.63 app.js (the config folder is --config-dir, else COPILOT_HOME, else ~/.copilot; a usage tracker made new for
// each process, fed only by live assistant.usage events).
//
// Tokens: assistant.usage, the one per-request record, is ephemeral: never written to disk. What is written is the
// session.shutdown each process writes as it exits: each model's tokens (modelMetrics), its subagents' with them. A CLI
// that keeps its accounting across processes (session.usage_checkpoint, the shutdown's usageAccountingWatermarks)
// writes the session's whole total there, so only what a shutdown adds to the totals read before it counts; an older
// CLI's shutdown counts its own process alone. A model's tokens go on the last request of that model since the process
// started (since session.start or session.resume), or on a request of their own when it has none there (a compaction's
// model). A session with no shutdown (still running, or killed) has its requests at unknown tokens. The CLI writes no
// price in dollars (it bills premium requests and AI credits), so the cost is the catalog's, which needs each request's
// tokens: unknown (null) unless each request's model ran no other request in its process.
//
// Each persisted event counts once ("u:" its id), each message once ("m:" its messageId). A model call is one request:
// a response split into chunks (each chunk a message of its own, chunkIndex > 0 after the first) joins the request of
// its first chunk, its apiCallId the same. A shutdown read already in another file (a copied session) adds no tokens,
// but moves what this file has counted, so its next whole total adds only its own. A record marked checkpoint (a
// rotated journal's copy of its archive) is a copy: read for the session's id, folder and model alone. events.N.jsonl archives, which a CLI writes only
// when COPILOT_SESSION_EVENT_LOG_ROTATION_BYTES is set, are not read; history-session-state, the format before 0.0.342,
// neither.
import { basename, dirname, join } from "node:path";
import { type LineSource, lineReader, type ReadContext } from "../lines.js";
import { entries } from "../reader.js";
import { argsOf, effortOf, isObject, str } from "../text.js";
import type { Answer, ToolCall, Usage } from "../types.js";
import { normalizeUsage } from "../usage.js";

/** `segment`: the requests (indexes into the state's answers) since the process started or resumed the session; `open`,
 *  the request a later chunk of its response joins, and `call`, its model call's apiCallId; `counted`, each model's
 *  tokens counted so far; `durable`, whether the session keeps its accounting across processes (a
 *  session.usage_checkpoint was read). */
type Own = { segment: number[]; open?: number; call?: string; counted: Map<string, Usage>; durable: boolean };

/** A Copilot model id as "provider/model": github-copilot's, unless it names its provider. */
const modelOf = (model: string): string => (model.includes("/") ? model : `github-copilot/${model}`);

const BUCKETS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const combine = (a: Usage, b: Usage | undefined, op: (x: number, y: number) => number): Usage => {
  const out = Object.fromEntries(BUCKETS.map((k) => [k, op(a[k], b?.[k] ?? 0)])) as Usage;
  if (a.reasoning !== undefined || b?.reasoning !== undefined) out.reasoning = Math.min(out.output, op(a.reasoning ?? 0, b?.reasoning ?? 0));
  return out;
};
const plus = (a: Usage, b: Usage | undefined) => combine(a, b, (x, y) => x + y);
const less = (a: Usage, b: Usage | undefined) => combine(a, b, (x, y) => Math.max(0, x - y));
const most = (a: Usage, b: Usage | undefined) => combine(a, b, Math.max);

/** Whether a user message is the person's: not a subagent's prompt, nor one the CLI or an agent wrote in the user role
 *  (autopilot's continuation, a skill's injection, an inter-agent prompt). */
const persons = (value: Record<string, unknown>, data: Record<string, unknown>): boolean =>
  value.agentId === undefined && data.isAutopilotContinuation !== true && data.agentAuthored !== true && !/^(?:agent|skill)-/.test(str(data.source) ?? "");

/** A shutdown's tokens, on its process's requests. A `copy` (its event read already, in another file) adds none: it only
 *  moves what this file has counted, so that a later shutdown holding the whole total adds only its own. */
function shutdown(data: Record<string, unknown>, at: number, { state, add }: ReadContext<Own>, copy = false): void {
  const { own } = state;
  if (data.shutdownType === "error" && !copy) state.session.state = "failed";
  // The session's whole total, where the CLI kept its accounting across processes; else this process's alone.
  const whole = own.durable || "usageAccountingWatermarks" in data || "accountingSnapshot" in data || "providerModelMetrics" in data;
  const metrics = isObject(data.modelMetrics) ? data.modelMetrics : {};
  for (const [name, entry] of Object.entries(metrics)) {
    const total = isObject(entry) ? normalizeUsage("copilot", entry.usage) : undefined;
    if (!total || !name) continue;
    const before = own.counted.get(name);
    const usage = whole ? less(total, before) : total;
    own.counted.set(name, whole ? most(total, before) : plus(total, before));
    if (copy || BUCKETS.every((k) => usage[k] === 0)) continue;
    const model = modelOf(name);
    let index = own.segment.findLast((i) => state.answers[i]!.model === model);
    if (index === undefined) {
      add({ role: "assistant", text: "", calls: [], at, model });
      own.segment.push((index = state.answers.length - 1));
    }
    const turn = state.answers[index]!;
    turn.usage = turn.usage ? plus(turn.usage, usage) : usage;
  }
}

function record(value: Record<string, unknown>, at: number, context: ReadContext<Own>): boolean | void {
  const { state, seen, keep, add } = context;
  const { session, names, own } = state;
  const data = isObject(value.data) ? value.data : {};
  const type = value.type;
  // What the session is, from any record, a checkpoint's copy too.
  if (type === "session.start" || type === "session.resume") {
    if (type === "session.start" && str(data.sessionId)) session.id = data.sessionId as string;
    const cwd = isObject(data.context) ? str(data.context.cwd) : undefined;
    if (cwd && !session.cwd) session.cwd = cwd;
    if (str(data.selectedModel)) session.model = modelOf(data.selectedModel as string);
    state.effort = effortOf(data.reasoningEffort) ?? state.effort;
    // A run the CLI started on another session's exit: its usage is that session's.
    const parent = type === "session.start" ? str(data.detachedFromSpawningParentSessionId) : undefined;
    if (parent) Object.assign(session, { child: true, parent });
  } else if (type === "session.model_change") {
    if (str(data.newModel)) session.model = modelOf(data.newModel as string);
    if (data.reasoningEffort !== undefined) state.effort = effortOf(data.reasoningEffort);
  } else if (type === "session.usage_checkpoint") own.durable = true;
  if (value.checkpoint === true) return false;
  const id = str(value.id);
  if (id) {
    if (seen.has(`u:${id}`)) {
      if (type === "session.shutdown") shutdown(data, at, context, true);
      return false;
    }
    seen.add(`u:${id}`);
  }
  if (type === "session.start" || type === "session.resume") {
    own.segment = [];
    own.open = own.call = undefined;
  } else if (type === "user.message") {
    const text = typeof data.content === "string" ? data.content : "";
    if (persons(value, data)) add({ role: "user", text, at });
    else if (keep) add({ role: "note", author: "copilot", text, at });
  } else if (type === "assistant.message") {
    const requests = Array.isArray(data.toolRequests) ? data.toolRequests.filter(isObject) : [];
    const calls: ToolCall[] = requests.map((call) => {
      const callId = String(call.toolCallId ?? "");
      names.set(callId, String(call.name ?? ""));
      return { type: "toolCall", id: callId, name: String(call.name ?? ""), arguments: keep ? argsOf(call.arguments) : {} };
    });
    const text = keep && typeof data.content === "string" ? data.content : "";
    // Each message once, a chunk of a split response too (each chunk is a message with its own messageId).
    const key = str(data.messageId);
    if (key) {
      if (seen.has(`m:${key}`)) return false;
      seen.add(`m:${key}`);
    }
    // A later chunk of one model call's response (the same apiCallId, where it names one): the same request.
    const apiCall = str(data.apiCallId);
    const chunk = typeof data.chunkIndex === "number" && data.chunkIndex > 0;
    const joined = chunk && own.open !== undefined && (!apiCall || !own.call || apiCall === own.call) ? state.answers[own.open] : undefined;
    if (joined) {
      if (text) joined.text = [joined.text, text].filter(Boolean).join("\n");
      joined.calls.push(...calls);
      return;
    }
    const model = str(data.model) ? modelOf(data.model as string) : session.model;
    // The session's model is its main agent's: a subagent's runs under it.
    if (model && value.agentId === undefined) session.model = model;
    session.state = "completed";
    const turn: Answer = { role: "assistant", text, calls, at, ...(key ? { key } : {}), ...(model ? { model } : {}), ...(state.effort ? { effort: state.effort } : {}) };
    add(turn);
    own.open = state.answers.length - 1;
    own.call = apiCall;
    own.segment.push(own.open);
  } else if (type === "tool.execution_start") {
    if (str(data.toolCallId) && str(data.toolName)) names.set(data.toolCallId as string, data.toolName as string);
  } else if (type === "tool.execution_complete") {
    const callId = String(data.toolCallId ?? "");
    const output = isObject(data.result) && typeof data.result.content === "string" ? data.result.content : isObject(data.error) ? (str(data.error.message) ?? "") : "";
    // Without turns, no output text: the result is kept for whether it failed, in the result and the cursor alike.
    add({ role: "toolResult", callId, name: names.get(callId) ?? "", text: keep ? output : "", isError: data.success === false, at });
  } else if (type === "abort") session.state = "stopped";
  else if (type === "session.error") session.state = "failed";
  else if (type === "session.shutdown") shutdown(data, at, context);
}

/** A Copilot session file's id from its path: its folder's name (session-state/<id>/events.jsonl), else the older
 *  flat file's name (session-state/<id>.jsonl). A session.start's sessionId, where there is one, wins over it. */
export const copilotSessionId = (file: string): string => (basename(file) === "events.jsonl" ? basename(dirname(file)) : basename(file, ".jsonl"));

const spec: LineSource<"copilot", Own> = {
  source: "copilot",
  name: "Copilot CLI",
  harness: "pi",
  async files(home, env) {
    const root = join(env?.COPILOT_HOME || join(home, ".copilot"), "session-state");
    const out: string[] = [];
    for (const entry of await entries(root)) {
      if (entry.isDirectory()) out.push(join(root, entry.name, "events.jsonl"));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(join(root, entry.name));
    }
    return out;
  },
  start: () => ({ segment: [], counted: new Map(), durable: false }),
  record,
  idOf: copilotSessionId,
};

export const copilot = lineReader(spec);
