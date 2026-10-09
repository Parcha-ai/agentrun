// "You are now running in X": what the agent is told when its computer moves. Each host describes itself (its probe
// of CPUs, memory, GPU, tools and network, plus the label its driver gave it), and the new host admits the notice into
// the conversation before it resumes anything.
//
// The notice is a pi write submission of an `env.switch` entry carrying one user-role model message, with the request
// id `env-switch:<switch id>`. pi admits a request id once per conversation, inside the commit that records it, so a
// crash or a restart in the middle of a switch never adds a second notice and never loses the first; an idle
// conversation gets the entry at once (no turn starts), a busy one at its next step boundary, before its next model
// request. Portable: no Node API.
import type { Context } from "@earendil-works/chord";
import type { AgentChange, Harness } from "@earendil-works/pi-durable";

export const NOTICE_KIND = "env.switch";

/** What a host says about itself. */
export interface EnvironmentFacts {
  /** The environment as the switcher names it: "your user's browser tab", "a Daytona sandbox", ... */
  readonly label: string;
  /** The driver's class of this host, when it has one ("daytona-medium", "daytona-gpu"). */
  readonly hostClass?: string;
  readonly cpus: number | null;
  readonly memoryGb: number | null;
  /** The GPU model(s), or null for none. */
  readonly gpu: string | null;
  /** Commands found on this host's PATH, among those an agent would reach for. */
  readonly tools: readonly string[];
  /** Whether a command the agent runs can reach the internet. */
  readonly network: boolean;
  readonly os?: string;
  /** Anything specific to this kind of host, as one sentence. */
  readonly note?: string;
}

export interface SwitchInfo {
  /** Unique per switch; the notice's request id derives from it. */
  readonly id: string;
  /** Where the agent ran before, in the switcher's words. */
  readonly from: string;
  /** Planned (the user switched) or not (the previous host went away). */
  readonly planned: boolean;
}

const list = (items: readonly string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export function noticeText(facts: EnvironmentFacts, move: SwitchInfo): string {
  const hardware = [
    facts.cpus ? `${facts.cpus} vCPU` : null,
    facts.memoryGb ? `${facts.memoryGb} GB RAM` : null,
    facts.gpu ? `GPU: ${facts.gpu}` : "no GPU",
  ].filter(Boolean);
  const parts = [
    `System notice: you are now running in ${facts.label}${facts.hostClass ? ` (${facts.hostClass})` : ""}: ${hardware.join(", ")}${facts.os ? `, ${facts.os}` : ""}.`,
    facts.tools.length > 0 ? `Commands available here include ${list(facts.tools)}.` : "",
    facts.network ? "Commands you run here can reach the internet." : "Commands you run here have no network access.",
    facts.note ?? "",
    move.planned ? `Your user moved you here from ${move.from}.` : `You were moved here from ${move.from}, which stopped unexpectedly.`,
    "Your conversation and the files in your workspace came with you; programs that were running before the move did not.",
  ];
  return parts.filter((p) => p !== "").join(" ");
}

/**
 * Admit the notice of `move` into the root conversation, once. Call it before the Harness resumes, so it is committed
 * before anything the run resumes commits.
 */
export async function admitNotice(harness: Harness, agent: AgentChange, facts: EnvironmentFacts, move: SwitchInfo, context: Context, now = Date.now()): Promise<void> {
  const root = await harness.root(context, { agent });
  const text = noticeText(facts, move);
  await root.submit(
    {
      type: "write",
      requestId: `env-switch:${move.id}`,
      entry: { kind: NOTICE_KIND, model: [{ role: "user", content: text, timestamp: now }], data: { switchId: move.id, from: move.from, planned: move.planned, facts: { ...facts, tools: [...facts.tools] } } },
    },
    context,
  );
}
