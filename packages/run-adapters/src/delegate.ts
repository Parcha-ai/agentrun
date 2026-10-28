// A lead hands one task to a named sub-agent, which runs as a child node on the same kernel. Written for AgentRun.
//
// `delegateTool` is an ordinary host tool, `delegate({ agent, task, context? })`, for a lead on any harness. Each call runs
// one child: an `agent` node, through `createHarnessRunner`, with the agent's own system prompt (as the host gave it) and
// its own subset of the lead's tools, answering in a fixed shape (`DELEGATE_RESULT_SCHEMA`). The child is durable under its
// own key, `step:<the lead's key>/delegate:<call id>`, so the call is replay-safe: a delegate that finished answers again
// from its recorded result, and one a crash cut off resumes from its own store (its finished paid requests are never sent
// again). Its paid requests are booked under that key and go through the lead's `beforeRequest`, so one budget covers the
// lead and every child; its deadline is the lead's, or the agent's share of what is left. Children run one at a time, and
// a child has no delegate tool (depth 1).
import { Mutex } from "./process/tools.js";
import { createHarnessRunner, type BeforeRequest } from "./runner.js";
import type { AgentAdapter, HarnessEvent, HostTool, NodeRequest, SessionStore } from "./types.js";

/** The tool's name, as the lead calls it. */
export const DELEGATE_TOOL = "delegate";

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
  /** A child's limit when the lead has no deadline (default 120 s; null for none). */
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
  for (const name of names) {
    const agent = options.agents[name]!;
    if (!AGENT_NAME.test(name)) problems.push(`the agent name ${JSON.stringify(name.slice(0, 80))} is not lowercase letters, digits and dashes`);
    if (typeof agent.system !== "string" || agent.system.length === 0) problems.push(`the agent ${name} has no system prompt`);
    for (const tool of agent.tools) {
      if (tool === DELEGATE_TOOL) problems.push(`the agent ${name} may not delegate further (depth 1)`);
      else if (!lead.has(tool)) problems.push(`the agent ${name} names the tool ${tool}, which the lead does not have`);
    }
    const share = agent.deadlineShare;
    if (share !== undefined && !(share > 0 && share <= 1)) problems.push(`the agent ${name}'s deadline share ${share} is not in (0, 1]`);
  }
  return problems;
}

/** The `delegate` host tool: refuses a bad definition when made. */
export function delegateTool(options: DelegateOptions): HostTool {
  const problems = delegateProblems(options);
  if (problems.length) throw new Error(`agentrun-adapters: delegate: ${problems.join("; ")}`);
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
    call: (args, { callId, signal }) => serial.run(async () => {
      const { agent: name, task, context } = (args ?? {}) as { agent?: unknown; task?: unknown; context?: unknown };
      const agent = typeof name === "string" ? options.agents[name] : undefined;
      if (!agent) return { text: `Not delegated: ${JSON.stringify(String(name).slice(0, 80))} is not one of the agents (${names.join(", ")}).`, isError: true };
      if (typeof task !== "string" || task.trim() === "") return { text: "Not delegated: give the task as text.", isError: true };
      const tag = { agent: name as string, callId, parentKey: options.parentKey };
      const deadlineAt = options.deadlineAt?.();
      const left = deadlineAt === undefined ? undefined : deadlineAt - Date.now();
      if (left !== undefined && left <= 0) return { text: "Not delegated: the lead has no time left.", isError: true };
      const timeoutMs = left === undefined ? options.timeoutMs : Math.max(1, Math.floor(left * (agent.deadlineShare ?? 1)));
      const runNode = createHarnessRunner(typeof options.adapter === "function" ? options.adapter(name as string) : options.adapter, {
        store: options.store,
        tools: agent.tools.map((t) => byName.get(t)!),
        signal,
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
          step: { sessionId: `${options.parentKey}/delegate:${callId}`, attempt: 0, earlierSessionIds: [] },
        });
        return { text: JSON.stringify(answer) };
      } catch (error) {
        return { text: `The delegate ${name as string} stopped without an answer: ${String((error as Error)?.message ?? error).slice(0, 400)}`, isError: true };
      }
    }),
  };
}
