// The tools a revision may name here: one closed table. Each entry is how the run's process binds the name and which
// environment variables it needs. A name outside the table cannot be named, and nothing is loaded from anywhere else.
// The file tools and `bash` bind from the run's coding source (coding-tools.ts): on the runner, pi's coding tools
// without `bash`, so a run gets no shell on this machine; in a box, pi's four, each call made in the box. `bash` may be
// named only by an agent whose place is a box (runnable.ts).
import type { TSchema } from "@earendil-works/pi-ai";
import { pathToFileURL } from "node:url";
import { defineExtension, defineTool, type Extension, type Harness, type ToolRegistration, type Tx } from "@earendil-works/pi-durable";
import type { AppContext } from "@parcha/pi-durable-disk";
import type { Revision } from "@parcha/pi-durable-agent";
import type { CodingSource } from "./coding-tools.js";
import { writeInWork } from "./workspace.js";
import { FETCH_PAGE_TOOL, fetchOptions } from "./fetch-page.js";
import { DEFAULT_HARNESS, HARNESSES } from "./harness.js";
import { REPLAY } from "./host-tools.js";
import { type Complete, LLM_TOOL } from "./llm.js";
import { DOCUMENTS_ENV, PDF_PAGES_TOOL, pdfPages } from "./pdf-pages.js";
import { monidTool } from "./monid.js";
import { FAUX_ENV, workflowNodes } from "./model.js";
import { bookedIn, booking, type Ledger } from "./paid-calls.js";
import { forModel } from "./result.js";
import { fetchFor, WEB_FETCH_TOOL, webFetchTool } from "./web-fetch.js";
import { searchFor, WEB_SEARCH_TOOL, webSearchTool } from "./web-search.js";
import { capabilityOf, explainsView, isUnavailable, NO_PARALLEL_KEY, type Pickable, PICKABLE, PROVIDERS, type Tooling, type ToolSettingsMap } from "./tool-plane.js";
import { PARALLEL_KEY_ENV } from "./decisions.js";

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

/** What a tool's binding gets from the run's process. */
export type ToolHost = {
  where: AppContext;
  /** The run's environment: the server's, without the server's token. */
  env: NodeJS.ProcessEnv;
  /** The run's coding tools, by its place (coding-tools.ts codingSource). */
  coding: CodingSource;
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

/** What a call node's effect gets from the run's process: its signal, environment and work directory, one completion
 *  on the run's models (the `llm` tool's), and the ledger its paid requests are booked in (paid-calls.ts). */
export type EffectRun = { signal: AbortSignal; env: NodeJS.ProcessEnv; work: string; complete?: Complete; ledger?: Ledger };

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
  effect?(args: Record<string, unknown>, run: EffectRun): Promise<unknown>;
  /** Only a workflow's call node runs it: no agent and no model node may name it. */
  callOnly?: true;
  /** Only an agent whose place is a sandbox may name it: it runs in the box (runnable.ts). */
  sandboxOnly?: true;
  /** No agent whose place is a sandbox may name it: it writes the run's work/ from this machine by paths a box's command
   *  could turn through a link (runnable.ts). */
  runnerOnly?: true;
};

const callOnly = (summary: string, effect: NonNullable<ToolEntry["effect"]>): ToolEntry => ({
  summary, needs: [], nodes: false, callOnly: true, effect,
  bind: async () => { throw new Error("a call-only tool binds no agent tool"); },
});

/** web_fetch, bound under `name`: its own, or a legacy name for it (LEGACY_NAMES, fetch_page). */
const webFetchEntry = (name: string): ToolEntry => ({
  summary: "Read one public web page from a public host through the guarded direct fetch, or through Parallel's extract where Parallel is picked (falling back to the direct fetch, saying why, when Parallel answers no page): { ok, url, status, title, text, truncated?, original_chars?, links, via, parallel?, refused?, error? }; a private or local address, a port other than 80 or 443, or a scheme other than http(s) is refused, never sent to Parallel.",
  needs: [],
  nodes: true,
  bind: async (host) => {
    const tool = booking(webFetchTool(host.env, name)) as unknown as ToolRegistration;
    const extension = defineExtension({ name: name.replaceAll("_", "-"), tools: [tool] });
    host.install(extension);
    return { tools: [tool], extensions: [extension] };
  },
  effect: async (args, run) => bookedIn(run.ledger, async () => fetchFor(run.env, args.url, { ...(await fetchOptions(run.env, FAUX_ENV)), signal: run.signal })),
});

/** A coding tool, from the run's coding source: a name it does not hold (bash on the runner) binds no tool. */
const fileTool = (name: string, summary: string, sandboxOnly = false): ToolEntry => ({
  summary,
  needs: [],
  nodes: !sandboxOnly,
  ...(sandboxOnly ? { sandboxOnly: true as const } : {}),
  bind: async (host) => {
    const tools = host.coding.tools.filter((tool) => tool.name === name);
    return { tools, extensions: tools.length ? [host.coding.extension] : [] };
  },
});

/** Where the browser files what it reads: `work/evidence/`, so the run's files show it and the agent can read it back. A
 *  text body follows one line of the read's facts; a capture's bytes go beside its facts. Each read takes the next free
 *  number, reserved by an exclusive create, so reads at once (parallel nodes, one turn's calls) and the reads of a later
 *  process never overwrite one another. */
export const evidenceIn = (work: string) => {
  let seq = 0;
  return {
    file: async (label: string, record: { tool: string; facts: Record<string, unknown>; body: string | Uint8Array; ext?: string }) => {
      const facts = JSON.stringify({ label, tool: record.tool, ...record.facts });
      const text = typeof record.body === "string";
      for (;;) {
        const name = `${String(++seq).padStart(4, "0")}-${record.tool}`;
        try {
          // Never through a link a box's command planted in work/ (files.ts).
          await writeInWork(work, ["evidence"], text ? `${name}.md` : `${name}.json`, text ? `${facts}\n\n${record.body}` : `${facts}\n`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        if (text) return { path: `evidence/${name}.md`, bodyLine: 3 };
        await writeInWork(work, ["evidence"], `${name}.${record.ext ?? "bin"}`, record.body);
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
  // Its downloads and uploads go through work/ by path (pi-browser), which a box's command could turn through a link.
  runnerOnly: true,
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
  bash: fileTool("bash", "Run a bash command in the run's box, from its work/, never on this server itself: only an agent whose place is a sandbox names it. Its output's tail; 300 s unless the call names a timeout.", true),
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
  [WEB_FETCH_TOOL]: webFetchEntry(WEB_FETCH_TOOL),
  [WEB_SEARCH_TOOL]: {
    summary: "Search the web: codex's own search (claude-agent's where it is picked), on pi the model provider's hosted search (Anthropic, OpenAI), with none of those Parallel's Search API where the server holds its key, else Exa's keyless search; or the provider picked: { query, n? } -> { provider, query, results: [{ url, title, snippet, published? }], text? }, provider naming the one that served it, 1 to 25 results, each snippet at most 3,000 characters; { error } when the search gives no answer.",
    needs: [],
    nodes: true,
    bind: async (host) => {
      const tool = booking(webSearchTool(host.env)) as unknown as ToolRegistration;
      const extension = defineExtension({ name: "web-search", tools: [tool] });
      host.install(extension);
      return { tools: [tool], extensions: [extension] };
    },
    effect: async (args, run) => bookedIn(run.ledger, () => searchFor(run.env, args, run.signal)),
  },
  browser: browserTool,
  // monid's catalog on one key (monid.ts): every harness calls each by its wire name, `monid_discover` and the rest.
  "monid.discover": monidTool("discover"),
  "monid.inspect": monidTool("inspect"),
  "monid.run": monidTool("run"),
  [PDF_PAGES_TOOL]: callOnly(
    "A workflow call: { path, maxPages?, dpi? } -> { name, pageCount, dpi, pages: [{ page, image }], text }; the document's first pages drawn as PNGs under work/pages/<stem>/<dpi>/ (the dpi lowered so a page's long side is at most 1568 px), from the server's documents (--documents) or the run's work directory.",
    (args, run) => pdfPages(args, { work: run.work, documents: run.env[DOCUMENTS_ENV], signal: run.signal }),
  ),
  [LLM_TOOL]: callOnly(
    "A workflow call: { prompt, system?, maxTokens?, tier? } -> { text, model, usage, cost_usd }; one completion on the model of the tier (default), no tools and no loop.",
    (args, run) => {
      if (!run.complete) throw new Error("llm: this run has no model to complete on");
      return run.complete(args, run.signal);
    },
  ),
});

/** Every name a revision may name, those a workflow's model node may, and those a workflow's call node may run. */
export const BOUND_TOOLS: readonly string[] = Object.keys(TOOLS).filter((name) => !TOOLS[name]!.callOnly);
export const NODE_TOOLS: readonly string[] = BOUND_TOOLS.filter((name) => TOOLS[name]!.nodes);
export const CALL_TOOLS: readonly string[] = Object.keys(TOOLS).filter((name) => TOOLS[name]!.effect !== undefined);
/** Whether `name` is one of `allowed`, or a legacy name for one (fetch_page, web_fetch's): a revision that names it
 *  still saves and runs, though the table lists it no more. */
export const allows = (allowed: readonly string[], name: string): boolean => allowed.includes(capabilityOf(name));

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

/** The tools a revision grants its run: an agentic revision's `tools`; a workflow revision's `tools` with those its model
 *  and call nodes name, which its run binds whether `tools` lists them or not. */
export async function grantedTools(revision: { kind: string; tools?: readonly string[]; workflow?: unknown }): Promise<string[]> {
  if (revision.kind !== "workflow") return [...(revision.tools ?? [])];
  const { inspectWorkflow } = await import("@parcha/agentrun-dsl");
  const named = workflowTools(workflowNodes(revision.workflow, inspectWorkflow(revision.workflow)));
  return [...new Set([...(revision.tools ?? []), ...named.nodes, ...named.calls])];
}

/** The table's entry for `name`, or undefined for a name it does not hold. */
export const toolOf = (name: string): ToolEntry | undefined => (Object.hasOwn(TOOLS, name) ? TOOLS[name] : name === FETCH_PAGE_TOOL ? webFetchEntry(FETCH_PAGE_TOOL) : undefined);

/** What a stored revision's tools resolve from (tool-plane.ts): the tools it grants, its harness, model and settings. */
export async function toolingOf(revision: Revision): Promise<Tooling> {
  const tools = await grantedTools(revision.kind === "agentic" ? { kind: "agentic", tools: revision.body.tools } : { kind: "workflow", tools: revision.body.tools, workflow: revision.body.workflow });
  return { tools, ...(revision.kind === "workflow" ? { workflow: true as const } : {}), ...(revision.body.harness ? { harness: revision.body.harness } : {}), ...(revision.kind === "agentic" && revision.body.model ? { model: revision.body.model } : {}), ...(revision.body.toolSettings ? { overrides: revision.body.toolSettings as ToolSettingsMap } : {}) };
}

/** The variables `entry` needs that `env` does not set, by name. */
export const missingEnv = (entry: ToolEntry, env: NodeJS.ProcessEnv): string[] => entry.needs.filter((name) => !env[name]);

/** What keeps `names` from being bound here: names outside the table (or, for a workflow's model nodes, that a node may
 *  not name), and the variables each tool in it needs that `env` does not set. Undefined when nothing does. */
export function toolRefusal(names: readonly string[], env: NodeJS.ProcessEnv, where: "agent" | "nodes" | "calls" = "agent"): { message: string; unbound: string[]; missing: Record<string, string[]> } | undefined {
  const allowed = where === "nodes" ? NODE_TOOLS : where === "calls" ? CALL_TOOLS : BOUND_TOOLS;
  const unbound = names.filter((name) => !allows(allowed, name));
  if (unbound.length) {
    const said = { agent: "agentrun-serve binds the tools", nodes: "A workflow's model nodes get the tools", calls: "A workflow's call nodes run the tools" }[where];
    return { message: `${said} ${allowed.join(", ")}; this ${where === "agent" ? "revision" : "workflow"} also ${where === "calls" ? "calls" : "names"} ${unbound.join(", ")}.`, unbound, missing: {} };
  }
  const missing = Object.fromEntries(names.map((name) => [name, missingEnv(toolOf(name)!, env)] as const).filter(([, vars]) => vars.length));
  const lacking = Object.entries(missing);
  if (!lacking.length) return undefined;
  const said = lacking.map(([name, vars]) => `the tool ${name} needs ${vars.join(" and ")}`).join("; ");
  return { message: `This server's environment does not set what the revision's tools need: ${said}.`, unbound: [], missing };
}

/** Every tool as capabilities show it, the server's one tool catalog: available here, or the variables it is missing
 *  (names only), and the harnesses that run it (another harness than pi runs only the host tools, host-tools.ts). A tool
 *  a user picks a provider for (tool-plane.ts) gives the providers offered, the server's (`provider`, the default where it
 *  sets none), the default, and what it resolves to on each harness under the server's `settings`: available where any
 *  is not unavailable, and missing PARALLEL_API_KEY where Parallel is picked without it. An unavailable tool says why
 *  (`reason`). `noBox`: why no box can run a sandbox-only tool here (place.ts noBoxReason), which leaves it
 *  unavailable with that reason; undefined, a box can. */
export const toolsView = (env: NodeJS.ProcessEnv, settings: ToolSettingsMap = {}, noBox?: string) => {
  const views = explainsView(env, settings);
  return Object.entries(TOOLS).map(([name, entry]) => {
    const view = (PICKABLE as readonly string[]).includes(name) ? views[name as Pickable] : undefined;
    const plane = view?.resolves;
    const missing = plane && Object.values(plane).includes(NO_PARALLEL_KEY) ? [PARALLEL_KEY_ENV] : missingEnv(entry, env);
    const boxless = entry.sandboxOnly ? noBox : undefined;
    const available = (plane ? Object.values(plane).some((resolution) => !isUnavailable(resolution)) : missing.length === 0) && boxless === undefined;
    // Unavailable says why: a sandbox-only tool no box here can run, why none can (`noBox`); on a tool a user picks a
    // provider for, the resolutions' own words (`web_search is turned off in settings`); else the variables it needs.
    const reason = available ? undefined : boxless ?? (plane ? [...new Set(Object.values(plane).filter(isUnavailable).map((resolution) => resolution.slice("unavailable: ".length)))].join("; ") : `Needs ${missing.join(", ")}`);
    return { name, summary: entry.summary, nodes: entry.nodes, calls: entry.effect !== undefined, ...(entry.callOnly ? { call_only: true } : {}), ...(entry.sandboxOnly ? { sandbox_only: true } : {}), available, ...(reason ? { reason } : {}), ...(missing.length ? { missing } : {}), harnesses: name in REPLAY ? [...HARNESSES] : [DEFAULT_HARNESS], ...(plane ? { providers: [...PROVIDERS[name as Pickable]], provider: settings[name as Pickable]?.provider ?? PROVIDERS[name as Pickable][0], default_provider: PROVIDERS[name as Pickable][0], resolves: plane, why: view!.why } : {}) };
  });
};
