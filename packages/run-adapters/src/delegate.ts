// A lead hands one task to a named sub-agent, which runs as a child node on the same kernel. Written for AgentRun.
//
// `delegateTool` is an ordinary host tool, `delegate({ agent, task, context? })`, for a lead on any harness. Each call runs
// one child: an `agent` node, through `createHarnessRunner`, with the agent's own system prompt (as the host gave it) and
// its own subset of the lead's tools, answering in a fixed shape (`DELEGATE_RESULT_SCHEMA`). The child is durable under its
// own key, `step:<the lead's key>/delegate:<call id>`, so the call is replay-safe: a delegate that finished answers again
// from its recorded result, and one a crash cut off resumes from its own store (its finished paid requests are never sent
// again). Its paid requests are booked under that key and go through the lead's `beforeRequest`, so one budget covers the
// lead and every child; its deadline is the lead's, or the agent's share of what is left. Children run one at a time, and
// a child has no delegate tool (depth 1). The lead reads at most DELEGATE_ANSWER_MAX_CHARS of an answer: one past it is
// cut to fit, its JSON whole, and says what was cut and that the whole answer is kept in the child's records, which no tool
// of the lead's reads (delegateText), so a result stays under the host's bound (HOST_RESULT_MAX_CHARS).
import { Mutex } from "./process/tools.js";
import { createHarnessRunner, RUNNER_RECORDS, SUBMIT_TOOL, type BeforeRequest } from "./runner.js";
import type { AgentAdapter, HarnessEvent, HostTool, NodeRequest, SessionStore } from "./types.js";

/** The tool's name, as the lead calls it. */
export const DELEGATE_TOOL = "delegate";
/** The most characters of a delegate's answer (its JSON) the lead reads. */
export const DELEGATE_ANSWER_MAX_CHARS = 60_000;
/** Of a cut answer, the most its citations and its gaps take (as JSON): the answer's text gets the rest. */
const CITATIONS_MAX_CHARS = 20_000;
const GAPS_MAX_CHARS = 5_000;

/** What every delegate answers: its finding, the sources it rests on, and what it could not settle. */
export const DELEGATE_RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    answer: { type: "string" },
    citations: {
      type: "array",
      items: { type: "object", properties: { url: { type: "string" }, title: { type: "string" }, quote: { type: "string" } }, required: ["url"], additionalProperties: false },
    },
    gaps: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "citations"],
  additionalProperties: false,
});

/** One named sub-agent, as the host defines it. */
export interface DelegateAgent {
  /** What the lead is told this agent is for. */
  description: string;
  /** The child's system prompt, verbatim. */
  system: string;
  /** The lead's tools this agent gets, by name: a subset of `DelegateOptions.tools`. */
  tools: readonly string[];
  /** The models-table tier the child runs on (the node's `tier`). */
  tier?: NodeRequest["tier"];
  /** The share of the lead's remaining time the child may take, in (0, 1] (default 1). */
  deadlineShare?: number;
}

/** A child's event: the runner's event, with the delegate call it belongs to. */
export type DelegateEvent = HarnessEvent & { delegate: { agent: string; callId: string; parentKey: string } };

export interface DelegateOptions {
  /** The sub-agents by name (lowercase letters, digits and dashes). */
  agents: Readonly<Record<string, DelegateAgent>>;
  /** The lead's tools: each agent gets the ones it names, and no others. */
  tools: readonly HostTool[];
  /** The harness children run on, or one per agent (an agent's own skills, say). */
  adapter: AgentAdapter | ((agent: string) => AgentAdapter);
  /** The run's store: each child keeps its session there, under its own key. */
  store: SessionStore;
  /** The lead's session key: a child's is `<parentKey>/delegate:<call id>`. */
  parentKey: string;
  /** The lead's check before each paid request, so one budget covers the lead and its children. */
  beforeRequest?: BeforeRequest;
  /** Every child event, with the delegate call it belongs to. */
  onEvent?: (event: DelegateEvent) => void;
  /** The lead's deadline (epoch ms), if it has one: a child's is this, or its agent's share of the time left. */
  deadlineAt?: () => number | undefined;
  /** A child's limit when the lead has no deadline (absent: the runner's own default, 120 s; null for none). */
  timeoutMs?: number | null;
  /** The most paid requests a child makes per attempt (the runner's default when absent). */
  maxTurns?: number | null;
}

const AGENT_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** What is wrong with the delegate's definition, or nothing: checked when the tool is made. */
export function delegateProblems(options: Pick<DelegateOptions, "agents" | "tools">): string[] {
  const problems: string[] = [];
  const lead = new Set(options.tools.map((t) => t.name));
  const names = Object.keys(options.agents);
  if (names.length === 0) problems.push("no agents to delegate to");
  if (lead.has(DELEGATE_TOOL)) problems.push(`the lead already has a tool named ${DELEGATE_TOOL}`);
  for (const name of names) {
    const agent = options.agents[name]!;
    if (!AGENT_NAME.test(name)) problems.push(`the agent name ${JSON.stringify(name.slice(0, 80))} is not lowercase letters, digits and dashes`);
    if (typeof agent.system !== "string" || agent.system.length === 0) problems.push(`the agent ${name} has no system prompt`);
    const seen = new Set<string>();
    for (const tool of agent.tools) {
      if (seen.has(tool)) problems.push(`the agent ${name} names the tool ${tool} twice`);
      seen.add(tool);
      if (tool === DELEGATE_TOOL) problems.push(`the agent ${name} may not delegate further (depth 1)`);
      else if (tool === SUBMIT_TOOL) problems.push(`the agent ${name} names ${SUBMIT_TOOL}, which the runner gives every child itself`);
      else if (!lead.has(tool)) problems.push(`the agent ${name} names the tool ${tool}, which the lead does not have`);
    }
    const share = agent.deadlineShare;
    if (share !== undefined && !(share > 0 && share <= 1)) problems.push(`the agent ${name}'s deadline share ${share} is not in (0, 1]`);
  }
  return problems;
}

/** The items of `list` that fit in `max` characters of JSON (with their commas), from its start. */
function fitting(list: readonly unknown[], max: number): unknown[] {
  const kept: unknown[] = [];
  for (let used = 2; kept.length < list.length; ) {
    const cost = JSON.stringify(list[kept.length]).length + 1;
    if (used + cost > max) break;
    used += cost;
    kept.push(list[kept.length]);
  }
  return kept;
}

/**
 * A delegate's answer as the lead reads it: its JSON, when that is within DELEGATE_ANSWER_MAX_CHARS. Past it, the answer
 * is cut to fit and its JSON stays whole: the citations and the gaps that fit their share, from the first, and the
 * longest start of the answer's text that fits the rest, with `cut` saying the whole's length and what was cut of each
 * part; then a line saying so to the model, and that the whole answer is kept in the child's records (`step:<session>`),
 * which none of the lead's tools reads.
 */
export function delegateText(value: unknown, session: string): string {
  const whole = JSON.stringify(value);
  if (whole.length <= DELEGATE_ANSWER_MAX_CHARS) return whole;
  const given = (value !== null && typeof value === "object" ? value : {}) as { answer?: unknown; citations?: unknown; gaps?: unknown };
  const answer = typeof given.answer === "string" ? given.answer : JSON.stringify(given.answer ?? "");
  const lists = { citations: Array.isArray(given.citations) ? given.citations : undefined, gaps: Array.isArray(given.gaps) ? given.gaps : undefined };
  const kept = { citations: lists.citations && fitting(lists.citations, CITATIONS_MAX_CHARS), gaps: lists.gaps && fitting(lists.gaps, GAPS_MAX_CHARS) };
  const shape = (text: string) => ({
    answer: text,
    ...(kept.citations ? { citations: kept.citations } : {}),
    ...(kept.gaps ? { gaps: kept.gaps } : {}),
    cut: {
      original_chars: whole.length,
      ...(text.length < answer.length ? { answer: [text.length, answer.length] } : {}),
      ...(kept.citations && kept.citations.length < lists.citations!.length ? { citations: [kept.citations.length, lists.citations!.length] } : {}),
      ...(kept.gaps && kept.gaps.length < lists.gaps!.length ? { gaps: [kept.gaps.length, lists.gaps!.length] } : {}),
    },
  });
  // The longest start of the answer's text whose JSON keeps the whole within the cap, never half a surrogate pair.
  let length = 0;
  for (let high = answer.length; length < high; ) {
    const mid = Math.ceil((length + high) / 2);
    if (JSON.stringify(shape(answer.slice(0, mid))).length <= DELEGATE_ANSWER_MAX_CHARS) length = mid;
    else high = mid - 1;
  }
  if (length > 0 && length < answer.length && (answer.charCodeAt(length - 1) & 0xfc00) === 0xd800) length -= 1;
  const fitted = shape(answer.slice(0, length));
  const parts = [
    ...(length < answer.length ? [`its answer is cut at ${length} of ${answer.length} characters`] : []),
    ...(["citations", "gaps"] as const).flatMap((part) => (kept[part] && kept[part]!.length < lists[part]!.length ? [`${lists[part]!.length - kept[part]!.length} of its ${lists[part]!.length} ${part} are left out`] : [])),
  ];
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}` : parts[0] ?? "it is cut";
  return `${JSON.stringify(fitted)}\nThe delegate's answer was ${whole.length} characters, past the ${DELEGATE_ANSWER_MAX_CHARS} a delegate's answer holds here: ${what}. The whole answer is kept in this run's records (the session step:${session}), which none of your tools reads: ask the delegate again, with a narrower task, for what was cut.`;
}

/** The `delegate` host tool: refuses a bad definition when made. */
export function delegateTool(options: DelegateOptions): HostTool {
  const problems = delegateProblems(options);
  if (problems.length) throw new Error(`agentrun-kernel: delegate: ${problems.join("; ")}`);
  const byName = new Map(options.tools.map((t) => [t.name, t]));
  const names = Object.keys(options.agents);
  // One child at a time, whatever the harness's own tool calls do.
  const serial = new Mutex();
  return {
    name: DELEGATE_TOOL,
    description: `Hand one task to a sub-agent, which works on it with its own tools and answers with its finding, its sources and its gaps. One at a time. The agents:\n${names.map((n) => `- ${n}: ${options.agents[n]!.description}`).join("\n")}`,
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: names },
        task: { type: "string", description: "What the sub-agent is to find out or do, complete in itself." },
        context: { type: "string", description: "What it should know from your work so far." },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
    // A child is durable under its own key: run again after a crash, it answers from its record or resumes its session.
    replay: "safe",
    call: (args, { callId, signal, sessionDir }) => serial.run(async () => {
      const { agent: name, task, context } = (args ?? {}) as { agent?: unknown; task?: unknown; context?: unknown };
      // An own entry only: a name like `constructor` is not an agent.
      const agent = typeof name === "string" && Object.hasOwn(options.agents, name) ? options.agents[name] : undefined;
      if (!agent) return { text: `Not delegated: ${JSON.stringify(String(name).slice(0, 80))} is not one of the agents (${names.join(", ")}).`, isError: true };
      if (typeof task !== "string" || task.trim() === "") return { text: "Not delegated: give the task as text.", isError: true };
      const tag = { agent: name as string, callId, parentKey: options.parentKey };
      // The child's session: its step's id, so its records are the runner's under `step:<id>`.
      const sessionId = `${options.parentKey}/delegate:${callId}`;
      const deadlineAt = options.deadlineAt?.();
      const left = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
      if (left !== undefined && left <= 0) {
        // A child that delivered before a crash answers from its record, deadline or not; only new work is refused. Read,
        // not opened: opening would fence the session for nothing.
        const saved = (await options.store.read(`step:${sessionId}`)).findLast((r) => r.kind === RUNNER_RECORDS.accepted);
        if (saved) return { text: delegateText((saved.data as { value: unknown }).value, sessionId) };
        return { text: "Not delegated: the lead has no time left.", isError: true };
      }
      const timeoutMs = left === undefined ? options.timeoutMs : Math.max(1, Math.floor(left * (agent.deadlineShare ?? 1)));
      const runNode = createHarnessRunner(typeof options.adapter === "function" ? options.adapter(name as string) : options.adapter, {
        store: options.store,
        tools: agent.tools.map((t) => byName.get(t)!),
        signal,
        // The lead's runner's private directories, if it has them: the child's is its own, by its own key.
        ...(sessionDir ? { sessionDir } : {}),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
        ...(options.beforeRequest ? { beforeRequest: options.beforeRequest } : {}),
        ...(options.onEvent ? { onEvent: (event: HarnessEvent) => options.onEvent!({ ...event, delegate: tag }) } : {}),
      });
      try {
        const answer = await runNode({
          kind: "agent",
          label: `delegate:${name as string}`,
          system: [agent.system],
          user: typeof context === "string" && context.trim() ? `${task}\n\nContext from the lead:\n${context}` : task,
          schema: DELEGATE_RESULT_SCHEMA as unknown as Record<string, unknown>,
          tools: [...agent.tools],
          ...(agent.tier === undefined ? {} : { tier: agent.tier }),
          step: { sessionId, attempt: 0, earlierSessionIds: [] },
        });
        return { text: delegateText(answer, sessionId) };
      } catch (error) {
        // Stopped (the lead paused, the process is draining): not an answer. Rethrown, the lead's harness records the call
        // as interrupted and runs the same call id again on resume, which resumes this child. A child that failed on its
        // own is an answer the lead reads.
        if (signal?.aborted) throw signal.reason ?? error;
        return { text: `The delegate ${name as string} stopped without an answer: ${String((error as Error)?.message ?? error).slice(0, 400)}`, isError: true };
      }
    }),
  };
}
