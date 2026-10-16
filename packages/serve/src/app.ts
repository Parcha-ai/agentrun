// The app `pi-durable-disk run --app` loads for each run serve starts: the definition and skills from the agent home,
// the model this host binds (model.ts), and the tools the definition names: the workspace's file tools and
// `ask_person`, which ends the agent's turn until the person answers.
import { join, resolve } from "node:path";
import type { TSchema } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { openAgentHome, readAgentHome, type AgentHomeState } from "@parcha/pi-durable-agent";
import { ArchilCodingTools, type AppContext, type AppOptions } from "@parcha/pi-durable-disk";
import { runModels, thinkingOf } from "./model.js";

export const ASK_TOOL = "ask_person";
/** The tool names a definition may name here. `bash` is not bound: a local run gets no shell on this machine. */
export const BOUND_TOOLS = ["read", "write", "edit", ASK_TOOL] as const;

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

/** The definition's instructions, then each skill it names (`<name>/SKILL.md` in the home), in order. */
export function promptOf(state: Pick<AgentHomeState, "definition" | "skills">): string {
  const skills = state.definition.skills.map((name) => {
    const file = state.skills[`${name}/SKILL.md`];
    if (!file) throw new Error(`the definition names the skill ${name}, and the agent home has no ${name}/SKILL.md`);
    return `<skill name="${name}">\n${file.content.trim()}\n</skill>`;
  });
  return [state.definition.instructions.trim(), ...(skills.length ? ["Your skills follow. Use the one that fits the step you are on.", ...skills] : [])].join("\n\n");
}

// pi-durable-disk's types name the pi-durable it resolves, which a build at another pi version (the pi-floor legs) can
// hold apart from this package's own: the options cross that boundary as values, typed on this side.
const CodingTools = ArchilCodingTools as unknown as Extension;

export default async function app(where: AppContext): Promise<AppOptions> {
  const state = await readAgentHome(await openAgentHome(resolve(join(where.root, "..", ".."))));
  const { models, model } = await runModels(process.env);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(defineExtension({ name: "person", tools: [askPerson] }));
  const bound = new Map<string, ToolRegistration>([...(CodingTools.tools ?? []).map((tool) => [tool.name, tool] as const), [ASK_TOOL, askPerson as ToolRegistration]]);
  const tools: ToolRegistration[] = [];
  for (const name of state.definition.tools) {
    const tool = (BOUND_TOOLS as readonly string[]).includes(name) ? bound.get(name) : undefined;
    if (!tool) throw new Error(`the definition names the tool ${name}, which agentrun-serve does not bind (it binds ${BOUND_TOOLS.join(", ")})`);
    tools.push(tool);
  }
  const options = {
    models,
    registry,
    root: { agent: { model, thinkingLevel: thinkingOf(process.env), instructions: promptOf(state), tools } },
  };
  return options as unknown as AppOptions;
}
