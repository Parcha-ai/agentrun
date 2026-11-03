import { allPages, type Client } from "./client";
import { type ToolOffer, toolsFor } from "./agentForm";
import { keeper } from "./idempotency";

// Mission Control's first-run templates: one click makes the agent (once) and runs it, so a first look at the console
// is an agent at work in seconds. Each shows the product doing something different, and needs no key beyond a model.

export type Template = { id: string; name: string; description: string; instructions: string; tools: string[]; input: string; shows: string };

export const TEMPLATES: readonly Template[] = [
  {
    id: "hello", name: "Hello, AgentRun", shows: "Writes a file, then answers",
    description: "A first agent: writes hello.md and answers in one line.",
    instructions: "You are a friendly first agent on this machine. Do what the person asks, briefly and plainly.",
    tools: ["write"],
    input: "Write hello.md listing three things you could help me with on this machine, then answer in one line.",
  },
  {
    id: "web", name: "Summarize a web page", shows: "Reads the web, then sums it up",
    description: "Reads a public web page and sums it up in three bullets.",
    instructions: "Read the page you are given and summarize it in three short bullets, then name the one thing worth remembering.",
    tools: ["web_fetch"],
    input: "Summarize https://en.wikipedia.org/wiki/Hacker_News in three bullets.",
  },
  {
    id: "plan", name: "Plan a task", shows: "Thinks it through, no tools",
    description: "Turns a goal into steps, risks and a first move.",
    instructions: "Turn the goal you are given into a short plan: the steps in order, the main risks, and what to do first. Keep it to one screen.",
    tools: [],
    input: "Plan a weekend launch of a small side project: the steps, the risks, and what to do first.",
  },
];

/** A harness as capabilities list it, with the model it runs when a definition names none (null: none). */
export type TemplateHarness = { id: string; available: boolean; default_model?: string | null };

/** The harness the templates run on: the first available one the server names a default model for, pi first. None
 *  when no harness has a model to run, and then the model step comes first. */
export function templateHarness(harnesses: readonly TemplateHarness[]): string | null {
  const order = ["pi", "claude-agent", "codex"];
  const ready = harnesses.filter((h) => h.available && h.default_model);
  ready.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
  return ready[0]?.id ?? null;
}

/** Whether the template's tools run on `harness` here, or why not. */
export function templateOffer(t: Template, harness: string, offers: readonly ToolOffer[]): { ok: true } | { ok: false; reason: string } {
  const runs = toolsFor(harness, [...offers]).filter((o) => o.available).map((o) => o.name);
  const missing = t.tools.find((tool) => !runs.includes(tool));
  return missing ? { ok: false, reason: `${missing} can't run on this server yet` } : { ok: true };
}

/** One click: the template's agent is made the first time (an archived one doesn't count), each click starts a run of
 *  it with the template's input, and the answer is the run's id. `keys` holds the start's Idempotency-Key until a start
 *  lands, so a click after a lost answer is the same start (the server answers with that run), never a second one. */
export async function tryTemplate(v2: Pick<Client, "listAgents" | "createAgent" | "startRun">, t: Template, harness: string, keys = keeper()): Promise<string> {
  const agents = await allPages((cursor) => v2.listAgents({ cursor }), (p) => p.agents);
  const existing = agents.find((a) => a.definition.name === t.name && !a.archived_at);
  const agentId = existing?.agent_id ?? (await v2.createAgent({ definition: { version: 1, name: t.name, description: t.description, instructions: t.instructions, harness, tools: t.tools, skills: [] } })).agent_id;
  const body = { input: { content: t.input } };
  const { run } = await v2.startRun(agentId, body, keys.keyFor(t.name, body));
  keys.done();
  return run.run_id;
}
