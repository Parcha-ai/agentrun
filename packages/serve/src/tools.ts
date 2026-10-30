// The tools a revision may name here: one closed table. Each entry is how the run's process binds the name and which
// environment variables it needs. A name outside the table cannot be named, and nothing is loaded from anywhere else.
// `bash` is not in it: a run gets no shell on this machine.
import type { TSchema } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineExtension, defineTool, type Extension, type Harness, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import { ArchilCodingTools, type AppContext } from "@parcha/pi-durable-disk";
import { FETCH_PAGE_TOOL, fetchOptions, fetchPage, fetchPageTool } from "./fetch-page.js";
import { FAUX_ENV } from "./model.js";
import { forModel } from "./result.js";

export const ASK_TOOL = "ask_person";
/** Under `--faux` only: a module whose default export gives the browser's `{ provider, driver }`, in place of
 *  Browserbase's (the tests' fake backend). */
export const FAUX_BROWSER_ENV = "AGENTRUN_SERVE_FAUX_BROWSER";

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
    return forModel(asked(question), { details: { question }, control: { terminate: true } });
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
  /** Runs when the run's process lets the run go (its work done, or a SIGTERM), while the Harness is still open. */
  beforeRelease(stop: (harness: Harness) => void | Promise<void>): void;
};

/** What a name stands for in the run: the pi tools it offers, and the extensions a conversation selects for them. */
export type ToolBinding = { tools: readonly ToolRegistration[]; extensions: readonly Extension[] };

export type ToolEntry = {
  /** One line, for capabilities. */
  summary: string;
  /** The environment variables it needs, by name. */
  needs: readonly string[];
  /** Whether a workflow's model node may name it. */
  nodes: boolean;
  /** What the name stands for, bound in the run's process once. */
  bind(host: ToolHost): Promise<ToolBinding>;
  /** What a workflow's `call` node `via: "tool"` naming it runs: its interpolated `args` in, the value its `out` schema
   *  checks out. Absent, no call node may name it. */
  effect?(args: Record<string, unknown>, run: { signal: AbortSignal; env: NodeJS.ProcessEnv }): Promise<unknown>;
};

const fileTool = (name: string, summary: string): ToolEntry => ({
  summary,
  needs: [],
  nodes: true,
  bind: async () => ({ tools: (CodingTools.tools ?? []).filter((tool) => tool.name === name), extensions: [CodingTools] }),
});

/** Where the browser files what it reads: `work/evidence/`, so the run's files show it and the agent can read it back. A
 *  text body follows one line of the read's facts; a capture's bytes go beside its facts. Each read takes the next free
 *  number, reserved by an exclusive create, so reads at once (parallel nodes, one turn's calls) and the reads of a later
 *  process never overwrite one another. */
export const evidenceIn = (work: string) => {
  let seq = 0;
  return {
    file: async (label: string, record: { tool: string; facts: Record<string, unknown>; body: string | Uint8Array; ext?: string }) => {
      const dir = join(work, "evidence");
      await mkdir(dir, { recursive: true });
      const facts = JSON.stringify({ label, tool: record.tool, ...record.facts });
      const text = typeof record.body === "string";
      for (;;) {
        const name = `${String(++seq).padStart(4, "0")}-${record.tool}`;
        try {
          await writeFile(join(dir, text ? `${name}.md` : `${name}.json`), text ? `${facts}\n\n${record.body}` : `${facts}\n`, { flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        if (text) return { path: `evidence/${name}.md`, bodyLine: 3 };
        await writeFile(join(dir, `${name}.${record.ext ?? "bin"}`), record.body);
        return { path: `evidence/${name}.json`, bodyPath: `evidence/${name}.${record.ext ?? "bin"}` };
      }
    },
  };
};

/** A Browserbase browser driven through Stagehand, on pi-browser's durable adapter: its sessions' custody lives in the
 *  run's own store. No recording and no live view; a session the run still holds is released when the run is let go. */
const browserTool: ToolEntry = {
  summary: "Drive a Browserbase browser: open pages, read and screenshot them, and act on them.",
  needs: ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"],
  nodes: true,
  bind: async (host) => {
    const [{ BACKGROUND_CONTEXT: context }, { createBrowserExtension }, { DEFAULT_BROWSER_POLICY }] = await Promise.all([
      import("@earendil-works/chord/context"),
      import("@parcha/pi-browser/durable"),
      import("@parcha/pi-browser"),
    ]);
    const faux = host.env[FAUX_ENV] ? host.env[FAUX_BROWSER_ENV] : undefined;
    const parts = faux
      ? ((await import(pathToFileURL(faux).href)) as { default: (env: NodeJS.ProcessEnv) => { provider: unknown; driver: unknown } }).default(host.env)
      : { provider: (await import("@parcha/pi-browser/providers/browserbase")).browserbaseProvider({ env: host.env }), driver: (await import("@parcha/pi-browser/driver/stagehand")).stagehandDriver() };
    const browser = createBrowserExtension({ provider: () => parts.provider as never, driver: parts.driver as never, evidence: evidenceIn(host.where.work) as never, workspace: () => host.where.work });
    const extension = browser.extension as unknown as Extension;
    host.install(extension);
    host.onConversation(async (tx, conversationId) => {
      Object.assign(await tx.doc(browser.docs.Config, conversationId as never), { label: "run", run: host.where.ref.id, policy: DEFAULT_BROWSER_POLICY });
    });
    host.beforeResume(async (harness) => void (await browser.reconcile(harness as never, () => true, context)));
    host.beforeRelease(async (harness) => {
      const held = await harness.snapshot(browser.docs.Inventory as never, context) as { rows?: Record<string, { conversationId: number; state: string }> } | undefined;
      for (const id of new Set(Object.values(held?.rows ?? {}).filter((row) => row.state !== "released").map((row) => row.conversationId))) {
        const conversation = await harness.conversation(id as never, context);
        if (conversation) await browser.release(conversation as never, "close", context);
      }
      await browser.drain(harness as never, context);
    });
    return { tools: browser.tools as unknown as readonly ToolRegistration[], extensions: [extension] };
  },
};

export const TOOLS: Readonly<Record<string, ToolEntry>> = Object.freeze({
  read: fileTool("read", "Read a file in the run's work/."),
  write: fileTool("write", "Write a file in the run's work/."),
  edit: fileTool("edit", "Edit a file in the run's work/."),
  [ASK_TOOL]: {
    summary: "Ask the person who started the run; the turn ends until a message answers.",
    needs: [],
    nodes: false,
    bind: async (host) => {
      const person = defineExtension({ name: "person", tools: [askPerson] });
      host.install(person);
      return { tools: [askPerson as ToolRegistration], extensions: [person] };
    },
  },
  [FETCH_PAGE_TOOL]: {
    summary: "Fetch one public web page: { ok, url, status, title, text, links }; a private or local address, or a scheme other than http(s), is refused.",
    needs: [],
    nodes: true,
    bind: async (host) => {
      const tool = fetchPageTool(() => fetchOptions(host.env, FAUX_ENV)) as unknown as ToolRegistration;
      const extension = defineExtension({ name: "fetch-page", tools: [tool] });
      host.install(extension);
      return { tools: [tool], extensions: [extension] };
    },
    effect: async (args, run) => fetchPage(args.url, { ...(await fetchOptions(run.env, FAUX_ENV)), signal: run.signal }),
  },
  browser: browserTool,
});

/** Every name a revision may name, those a workflow's model node may, and those a workflow's call node may run. */
export const BOUND_TOOLS: readonly string[] = Object.keys(TOOLS);
export const NODE_TOOLS: readonly string[] = BOUND_TOOLS.filter((name) => TOOLS[name]!.nodes);
export const CALL_TOOLS: readonly string[] = BOUND_TOOLS.filter((name) => TOOLS[name]!.effect !== undefined);

/** The tools a workflow names (`nodes` from workflowNodes): on its model nodes (`tools`), and on its `call` nodes
 *  `via: "tool"` (`tool`). */
export function workflowTools(nodes: readonly Record<string, unknown>[]): { nodes: string[]; calls: string[] } {
  const named = new Set<string>();
  const calls = new Set<string>();
  for (const node of nodes) {
    if (node.node === "call" && node.via === "tool" && typeof node.tool === "string") calls.add(node.tool);
    else if (Array.isArray(node.tools)) for (const name of node.tools) if (typeof name === "string") named.add(name);
  }
  return { nodes: [...named], calls: [...calls] };
}

/** The table's entry for `name`, or undefined for a name it does not hold. */
export const toolOf = (name: string): ToolEntry | undefined => (Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined);

/** The variables `entry` needs that `env` does not set, by name. */
export const missingEnv = (entry: ToolEntry, env: NodeJS.ProcessEnv): string[] => entry.needs.filter((name) => !env[name]);

/** What keeps `names` from being bound here: names outside the table (or, for a workflow's model nodes, that a node may
 *  not name), and the variables each tool in it needs that `env` does not set. Undefined when nothing does. */
export function toolRefusal(names: readonly string[], env: NodeJS.ProcessEnv, where: "agent" | "nodes" | "calls" = "agent"): { message: string; unbound: string[]; missing: Record<string, string[]> } | undefined {
  const allowed = where === "nodes" ? NODE_TOOLS : where === "calls" ? CALL_TOOLS : BOUND_TOOLS;
  const unbound = names.filter((name) => !allowed.includes(name));
  if (unbound.length) {
    const said = { agent: "agentrun-serve binds the tools", nodes: "A workflow's model nodes get the tools", calls: "A workflow's call nodes run the tools" }[where];
    return { message: `${said} ${allowed.join(", ")}; this ${where === "agent" ? "revision" : "workflow"} also ${where === "calls" ? "calls" : "names"} ${unbound.join(", ")}.`, unbound, missing: {} };
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
    return { name, summary: entry.summary, nodes: entry.nodes, calls: entry.effect !== undefined, available: missing.length === 0, ...(missing.length ? { missing } : {}) };
  });
