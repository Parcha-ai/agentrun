// The host tools of a run on a harness other than pi: its coding tools, from the run's coding source (coding-tools.ts:
// pi's own read, write and edit on the run's environment, or in a box those, bash and the background tools on the
// box's), so their arguments, their confinement and their refusals are pi's, word for word, pi's web_fetch, the public-host
// guard included, web_search, and monid's three (monid.ts), which stay on this machine.
// pi's tools take only the environment, their output and their diagnostics from a call's API, and a paid one its call's
// id and the run's store, so that is all a call here gives them: the output's tail or head as the tool keeps it (pi's
// limits), then the diagnostics, also when the tool failed. read, the web tools, monid.discover, monid.inspect,
// bash_output and bash_list may run again after a crash; write, edit, bash, monid.run, bash_background, bash_input and
// bash_signal never: the kernel records each one's intent before it runs, and a call a crash cut off is answered
// interrupted, not run again. A tool is named by its catalog name here and goes to the harness under its wire name (catalog.ts: `monid.run` is `monid_run`), which the harness calls and journals. A
// refusal, an error and a write's or edit's result name a path in the workspace relative to it (`hello.md`), never by
// the server's data directory (`workspaceRelative`); in a box they name the box's paths. Each call passes the run's tool
// gate first (tool-gate.ts): a denied call is refused, an asked one parked, and the harness is told so it ends the turn.
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { ROOT_CONVERSATION_ID, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { HostTool } from "@parcha/agentrun-kernel";
import type { DurableRun } from "@parcha/pi-durable-disk";
import { wireName } from "./catalog.js";
import { BOXED_TOOLS, CodingTools } from "./coding-tools.js";
import { monidTools } from "./monid.js";
import { booking } from "./paid-calls.js";
import { withSecrets } from "./secrets.js";
import { WEB_FETCH_TOOL, webFetchTool } from "./web-fetch.js";
import { WEB_SEARCH_TOOL, webSearchTool } from "./web-search.js";
import { realOf, workspaceRelative } from "./workspace-paths.js";
import { localWorkspace } from "./workspace/index.js";
import type { Park, RunGate } from "./tool-gate.js";
import { bounded, imagesOf, textOf } from "./workspace/executors.js";

export { workspaceRelative } from "./workspace-paths.js";

/** Each tool a harness other than pi runs here, by catalog name, and whether a call a crash cut off may run again.
 *  `learned_workflow` (learned-workflow.ts LEARNED_WORKFLOW_TOOL, named here as a string so the modules do not import
 *  each other) is never run again. */
export const REPLAY: Record<string, "safe" | "never"> = { read: "safe", write: "never", edit: "never", bash: "never", [WEB_FETCH_TOOL]: "safe", [WEB_SEARCH_TOOL]: "safe", "monid.discover": "safe", "monid.inspect": "safe", "monid.run": "never", bash_background: "never", bash_output: "safe", bash_input: "never", bash_signal: "never", bash_list: "safe", learned_workflow: "never" };

// pi's limits on a tool's output, and how a call's output is held within them, are the executors' (workspace/executors.ts).
export { cutUtf8, MAX_BYTES, MAX_LINES } from "./workspace/executors.js";

/** One call's result, kept by its call id for the run's timeline (an adapter's tool_end carries none). */
export type ToolResults = Map<string, { text: string; isError: boolean }>;

/** The members of pi's ToolExecutionApi a host tool's api gives. They are typed against pi's own type (`HostApi`), so a
 *  change to any of them in pi fails the build, and they are every member pi's own tools read (scripts/host-tool-api.test.mjs
 *  reads pi's tool sources for each `api.<member>`). The rest of pi's api (taskId, registry, the task, memo, document and
 *  nested-tool members) belongs to the tool task pi runs a tool in, which a host tool, called by another harness, has
 *  none of: the full type cannot be built here, so a read of any other member throws, naming it, rather than reading as
 *  "is not a function". `conversationId` is not given: serve's browser-cost `capped` reads it, but the browser tools run
 *  on pi only, never as a host tool (BOXED_TOOLS and the web and monid tools are the host tools); a browser host tool
 *  would add it here. */
export const HOST_API_MEMBERS = ["env", "callId", "commit", "output", "outputWindow", "retainedOutput", "diagnostic", "agent", "models"] as const;
type HostApi = Pick<ToolExecutionApi, (typeof HOST_API_MEMBERS)[number]>;
const hostApi = (given: HostApi): ToolExecutionApi =>
  new Proxy(given, {
    get: (target, key) => {
      if (typeof key === "symbol" || key === "then" || Object.hasOwn(target, key)) return Reflect.get(target, key);
      throw new Error(`a host tool's api has no ${key}: pi gives it only to a tool its own tool task runs`);
    },
  }) as unknown as ToolExecutionApi;

/** The tools whose result is pi's own words about a path (`Successfully wrote to <path>`), never a file's text. */
const SAYS_PATH = new Set(["write", "edit"]);

/** What one host tool's call reads of the run, beside the gate: the run's environment (its file environment, the api's
 *  `env`), its harness's commit and its root agent (a paid call's booking and pi's read), the context and the results map,
 *  and the paid-call money seam. The same over a DurableRun (hostTools below) and over the runner's claim Harness
 *  (runner/adapter-run-spec.ts), so a tool runs and answers one way on both. */
export interface HostToolCtx {
  readonly context: Context;
  readonly results: ToolResults;
  /** The run's environment, as the api's `env` (the file environment; the web and monid tools read none of it). */
  env(): Promise<ToolExecutionApi["env"]>;
  readonly commit: ToolExecutionApi["commit"];
  readonly agent: ToolExecutionApi["agent"];
  /** The run's tool gate and the park it takes; none for the gate's own run of an approved call (the adapter loop's own
   *  gate, which gates every host-tool call before its intent). */
  readonly gated?: { gate: RunGate; park: Park };
  /** A paid tool's money, routed through one seam: undefined to run the call, else the refusal that is its answer, so a
   *  paid tool whose charge cannot be settled here is never run unbooked (runner/adapter-run-spec.ts settlePaidCall). */
  settle?(name: string, args: unknown, callId: string): { refused: string } | undefined;
}

/** One pi ToolRegistration `tool` (named `name` by its catalog name) as the kernel's HostTool an adapter session takes:
 *  the gate before the call, the paid-call seam, then the tool on the run's environment and harness, its answer the text a
 *  model reads (the output or the failure, a write's or an error's path named relative to the run's folder). Undefined when
 *  `name` is not one a host runs (REPLAY). */
export function hostToolOf(name: string, tool: ToolRegistration, ctx: HostToolCtx): HostTool | undefined {
  const replay = REPLAY[name];
  if (!replay) return undefined;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as unknown as Record<string, unknown>,
    replay,
    async call(args, { callId, signal, attempt }) {
      // A replay (the kernel's attempt above 0) may follow an attempt that was sent: the gate's refusal then says so.
      const refused = await ctx.gated?.gate.enter(name, args, callId, ctx.gated.park, (attempt ?? 0) > 0 ? { replayed: true } : {});
      if (refused) {
        const answer = { text: refused.text, isError: refused.isError };
        ctx.results.set(callId, answer);
        // A parked call did not run: the harness's session records it so (HostTool's `parked`).
        return refused.parked ? { ...answer, parked: true as const } : answer;
      }
      // The paid-call money seam: a paid tool whose charge cannot be settled here is refused in words, never run unbooked.
      const unsettled = ctx.settle?.(name, args, callId);
      if (unsettled) {
        const answer = { text: unsettled.refused, isError: true };
        ctx.results.set(callId, answer);
        return answer;
      }
      const out = bounded(tool.outputLimits);
      const notes: string[] = [];
      const env = await ctx.env();
      // The call's id and the run's store, as pi's: a paid call marks and books its charge there (monid.ts).
      const api = hostApi({
        env, callId,
        commit: ctx.commit,
        output: (chunk) => out.push(chunk), outputWindow: undefined, retainedOutput: () => out.retained(),
        diagnostic: (note) => void notes.push(note.message),
        agent: ctx.agent,
        models: createModels(),
      });
      // A tool that throws (bash on a non-zero exit or a timeout) still answers with its output, as pi's harness does;
      // monid's answer a failure as an error result, which is kept as it is.
      const result = await tool.execute(args as never, api, withAbortSignal(signal, ctx.context)).catch((error: Error) => ({ failed: error.message, isError: true }));
      // pi names a result's blocks `output`; its bash answers its exit as a result's diagnostic.
      const given = result as unknown as { output?: unknown; isError?: boolean; failed?: string; diagnostics?: readonly { message: string }[] };
      const said = [textOf(given.output) || out.text(), given.failed, ...notes, ...(given.diagnostics ?? []).map((note) => note.message)].filter((part) => part).join("\n\n");
      const isError = given.isError === true;
      const work = (env as { cwd?: unknown }).cwd;
      const works = typeof work === "string" ? [work, realOf(work)] : [];
      const answer = { text: isError || SAYS_PATH.has(name) ? workspaceRelative(said, works) : said, isError };
      ctx.results.set(callId, answer);
      const images = imagesOf(given.output);
      return images.length ? { ...answer, images } : answer;
    },
  };
}


/** The host tools `names` names, on the run's coding source `coding`. `gated`: the run's tool gate, which every call
 *  passes, and the park it takes (harness-app.ts), told of a call it parked, whose turn the harness ends; none (the
 *  gate's own run of an approved call), each call runs as asked. `extra`: the run's own tools beyond the table (its
 *  learned_workflow, learned-workflow.ts), which the gate passes like the rest. */
export function hostTools(run: DurableRun, names: readonly string[], context: Context, results: ToolResults, coding: readonly ToolRegistration[] = CodingTools.tools ?? [], gated?: { gate: RunGate; park: Park }, extra: readonly ToolRegistration[] = []): HostTool[] {
  // The coding source gives the coding tools and nothing else: the network tools are this machine's own, below.
  const stray = coding.map((tool) => tool.name).filter((name) => !BOXED_TOOLS.includes(name));
  if (stray.length) throw new Error(`the coding source holds ${stray.join(", ")}, which is no coding tool`);
  // Their paid requests (Parallel's) are booked under the call, in the run's store, as pi's are (paid-calls.ts).
  const web = [webFetchTool(process.env), webSearchTool(process.env)].map(booking) as unknown as ToolRegistration[];
  // monid's, only for a run that names one: its key is the one this process was handed over its pipe (secrets.ts),
  // never in its environment, and its long answers go in the run's work/, the claim's as pi's (`where.work`), read at
  // the call. They are outside the coding source, which holds the coding tools only.
  const monid = names.some((name) => name.startsWith("monid.")) ? monidTools(withSecrets(process.env), () => localWorkspace(run.claim.work)) : [];
  // `extra`: the run's own tools beyond the table, its learned_workflow (learned-workflow.ts) when its pin names one.
  const tools = new Map([...coding, ...web, ...monid, ...extra].map((tool) => [tool.name, tool as ToolRegistration] as const));
  // What each call reads of the run: its environment, its harness's commit and root agent (pi's read asks the calling
  // agent for its model, for an image's limits; a non-pi run's root agent has no pi model, so read uses its default).
  const ctx: HostToolCtx = {
    context,
    results,
    ...(gated ? { gated } : {}),
    env: async () => await run.env({ conversationId: ROOT_CONVERSATION_ID, read: undefined as never }, context),
    commit: (change, at, options) => run.harness.commit(change, at, options),
    agent: async (at) => {
      const root = await run.harness.conversation(ROOT_CONVERSATION_ID, at);
      if (!root) throw new Error("the run has no root conversation");
      return root.agent(at);
    },
  };
  // The registrations are keyed by their wire names: the same name for every tool here but monid's.
  return names.flatMap((name) => {
    const tool = tools.get(wireName(name));
    const host = tool ? hostToolOf(name, tool, ctx) : undefined;
    return host ? [host] : [];
  });
}
