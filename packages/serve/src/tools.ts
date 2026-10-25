// The tools a revision may name here: one closed table. Each entry is how the run's process binds the name and which
// environment variables it needs. A name outside the table cannot be named, and nothing is loaded from anywhere else.
// `bash` is not in it: a run gets no shell on this machine.
import type { TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, type Harness, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { ArchilCodingTools, type AppContext } from "@parcha/pi-durable-disk";

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

// pi-durable-disk's types name the pi-durable it resolves, which a build at another pi version (the pi-floor legs) can
// hold apart from this package's own: the extension crosses that boundary as a value, typed on this side.
export const CodingTools = ArchilCodingTools as unknown as Extension;

/** What a tool's binding gets from the run's process. */
export type ToolHost = {
  where: AppContext;
  /** The run's environment: the server's, without the server's token. */
  env: NodeJS.ProcessEnv;
  /** Installs an extension in the run's registry, before the run opens. */
  install(extension: Extension): void;
  /** Runs in the commit that creates each of the run's conversations. */
  onConversation(write: (tx: Tx, conversationId: number) => void | Promise<void>): void;
  /** Runs once the run's Harness is open, before anything in it resumes. */
  beforeResume(settle: (harness: Harness) => void | Promise<void>): void;
};

export type ToolEntry = {
  /** One line, for capabilities. */
  summary: string;
  /** The environment variables it needs, by name. */
  needs: readonly string[];
  /** Whether a workflow's model node may name it. */
  nodes: boolean;
  /** The pi tools the name stands for, bound in the run's process once. */
  bind(host: ToolHost): Promise<readonly ToolRegistration[]>;
};

const fileTool = (name: string, summary: string): ToolEntry => ({
  summary,
  needs: [],
  nodes: true,
  bind: async () => (CodingTools.tools ?? []).filter((tool) => tool.name === name),
});

export const TOOLS: Readonly<Record<string, ToolEntry>> = Object.freeze({
  read: fileTool("read", "Read a file in the run's work/."),
  write: fileTool("write", "Write a file in the run's work/."),
  edit: fileTool("edit", "Edit a file in the run's work/."),
  [ASK_TOOL]: {
    summary: "Ask the person who started the run; the turn ends until a message answers.",
    needs: [],
    nodes: false,
    bind: async (host) => {
      host.install(defineExtension({ name: "person", tools: [askPerson] }));
      return [askPerson as ToolRegistration];
    },
  },
});

/** Every name a revision may name, and those a workflow's model node may. */
export const BOUND_TOOLS: readonly string[] = Object.keys(TOOLS);
export const NODE_TOOLS: readonly string[] = BOUND_TOOLS.filter((name) => TOOLS[name]!.nodes);

/** The table's entry for `name`, or undefined for a name it does not hold. */
export const toolOf = (name: string): ToolEntry | undefined => (Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined);

/** The variables `entry` needs that `env` does not set, by name. */
export const missingEnv = (entry: ToolEntry, env: NodeJS.ProcessEnv): string[] => entry.needs.filter((name) => !env[name]);

/** What keeps `names` from being bound here: names outside the table (or, for a workflow's model nodes, that a node may
 *  not name), and the variables each tool in it needs that `env` does not set. Undefined when nothing does. */
export function toolRefusal(names: readonly string[], env: NodeJS.ProcessEnv, nodes = false): { message: string; unbound: string[]; missing: Record<string, string[]> } | undefined {
  const allowed = nodes ? NODE_TOOLS : BOUND_TOOLS;
  const unbound = names.filter((name) => !allowed.includes(name));
  if (unbound.length) {
    const where = nodes ? "A workflow's model nodes get the tools" : "agentrun-serve binds the tools";
    return { message: `${where} ${allowed.join(", ")}; this ${nodes ? "workflow" : "revision"} also names ${unbound.join(", ")}.`, unbound, missing: {} };
  }
  const missing = Object.fromEntries(names.map((name) => [name, missingEnv(TOOLS[name]!, env)] as const).filter(([, vars]) => vars.length));
  const lacking = Object.entries(missing);
  if (!lacking.length) return undefined;
  const said = lacking.map(([name, vars]) => `the tool ${name} needs ${vars.join(" and ")}`).join("; ");
  return { message: `This server's environment does not set what the revision's tools need: ${said}.`, unbound: [], missing };
}

/** Every tool as capabilities show it: available here, or the variables it is missing (names only). */
export const toolsView = (env: NodeJS.ProcessEnv) =>
  Object.entries(TOOLS).map(([name, entry]) => {
    const missing = missingEnv(entry, env);
    return { name, summary: entry.summary, nodes: entry.nodes, available: missing.length === 0, ...(missing.length ? { missing } : {}) };
  });
