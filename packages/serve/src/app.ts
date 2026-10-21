// The app `pi-durable-disk run --app` loads for each run serve starts: the definition and skills from the agent home,
// the model this host binds (model.ts), and the tools the definition names, from the harness (`agentApp` on the host the
// environment gives, `hostFromEnv`), with serve's own `ask_person`, which ends the agent's turn until the person answers.
import { join, resolve } from "node:path";
import type { TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { agentApp, hostFromEnv } from "@parcha/agentrun-harness";
import { openAgentHome, readAgentHome, type AgentHomeState } from "@parcha/pi-durable-agent";
import type { AppContext, AppOptions } from "@parcha/pi-durable-disk";
import { runModels, thinkingOf } from "./model.js";

export const ASK_TOOL = "ask_person";

/** What the result of `ask_person` says; the person's page shows the question as a waiting row. */
export const asked = (question: string) => `Asked the person: ${question.slice(0, 500)}. Waiting for their answer.`;

export const askPerson = defineTool({
  name: ASK_TOOL,
  description: "Ask the person who started this run a question you cannot answer yourself. Call it alone. It ends your turn; the person's reply comes as their next message.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { question: { type: "string", minLength: 1, description: "The question, in one or two plain sentences." } },
    required: ["question"],
  } as unknown as TSchema,
  replay: "safe",
  execute: async (args) => {
    const { question } = args as { question: string };
    return { content: [{ type: "text", text: asked(question) }], details: { question }, control: { terminate: true } };
  },
});

/**
 * The definition's instructions, then each skill it names (`<name>/SKILL.md` in the home), in order. The one place a
 * run's instructions are made.
 */
export function promptOf(state: Pick<AgentHomeState, "definition" | "skills">): string {
  const skills = state.definition.skills.map((name) => {
    const file = state.skills[`${name}/SKILL.md`];
    if (!file) throw new Error(`the definition names the skill ${name}, and the agent home has no ${name}/SKILL.md`);
    return `<skill name="${name}">\n${file.content.trim()}\n</skill>`;
  });
  return [state.definition.instructions.trim(), ...(skills.length ? ["Your skills follow. Use the one that fits the step you are on.", ...skills] : [])].join("\n\n");
}

// The harness's and pi-durable-disk's types name the pi-durable they resolve, which a build at another pi version (the
// pi-floor legs) can hold apart from this package's own: the options cross that boundary as values, typed on this side.
type RunApp = { registry: Registry; root: { agent: { tools: ToolRegistration[] } } };

export default async function app(where: AppContext): Promise<AppOptions> {
  const state = await readAgentHome(await openAgentHome(resolve(join(where.root, "..", ".."))));
  const { models, model } = await runModels(process.env);
  const place = { id: where.ref.id, root: where.root, work: where.work, store: where.store };
  // The same host toolOffer reads: a local Chrome only (tools.ts).
  const host = await hostFromEnv(place, { models, lead: model, env: process.env, browserbase: false });
  // No browser option: the host has a browser only when the environment gives it one, and a browser tool on a host
  // without one is refused with what would give it one.
  const { tools } = state.definition;
  const options = await agentApp(place, host, { instructions: promptOf(state), tools: tools.filter((name) => name !== ASK_TOOL), thinking: thinkingOf(process.env) });
  const run = options as unknown as RunApp;
  if (tools.includes(ASK_TOOL)) {
    run.registry.install(defineExtension({ name: "person", tools: [askPerson] }));
    const offered = run.root.agent.tools;
    run.root.agent.tools = tools.map((name) => (name === ASK_TOOL ? (askPerson as ToolRegistration) : offered.find((tool) => tool.name === name)!));
  }
  return options as unknown as AppOptions;
}
