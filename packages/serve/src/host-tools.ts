// The host tools of a run on a harness other than pi: its coding tools, from the run's coding source (coding-tools.ts:
// pi's own read, write and edit on the run's environment, or in a box those, bash and the background tools on the
// box's), so their arguments, their confinement and their refusals are pi's, word for word, pi's web_fetch, the public-host
// guard included, web_search, and monid's three (monid.ts), which stay on this machine.
// pi's tools take only the environment, their output and their diagnostics from a call's API, and a paid one its call's
// id and the run's store, so that is all a call here gives them: the output's tail or head as the tool keeps it (pi's
// limits), then the diagnostics, also when the tool failed. read, the web tools, monid.discover, monid.inspect,
// bash_output and bash_list may run again after a crash; write, edit, bash, monid.run, bash_background, bash_input and
// bash_signal never: the kernel records each one's intent before it runs, and a call a crash cut off is answered
// interrupted, not run again. A tool is named by its catalog name here and goes to the harness under its wire name
// (catalog.ts: `monid.run` is `monid_run`), which the harness calls and journals. A refusal, an error and a write's or
// edit's result name a path in the workspace relative to it (`hello.md`), never by the server's data directory
// (`workspaceRelative`); in a box they name the box's paths. The runner's adapter loop gates each call before its intent
// (tool-gate.ts RunGate.decide), so a call that reaches a host tool here was allowed.
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { ROOT_CONVERSATION_ID, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { HostTool } from "@parcha/agentrun-kernel";
import { WEB_FETCH_TOOL } from "./web-fetch.js";
import { WEB_SEARCH_TOOL } from "./web-search.js";
import { realOf, workspaceRelative } from "./workspace-paths.js";
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
 *  "is not a function". `conversationId` is the run's root conversation, where a host tool's calls are made: serve's
 *  browser-cost `capped` reads it, now that the browser binds as a host tool on the runner. `snapshot`, `conversation`
 *  and `waitForTask` are the run's own Harness's (run.harness, the claim's journal on the runner), as `commit` is: a
 *  document, a conversation or a task of this run, never another's. A remote executor (workspace/executors.ts
 *  piExecutor) has no run Harness and gives none of these four (RUN_ONLY_MEMBERS); the coding tools it runs read none.
 *  `memo` and `taskId` are a pi tool task's own, which a host tool runs in none of: they are not given here. */
export const HOST_API_MEMBERS = ["env", "callId", "commit", "output", "outputWindow", "retainedOutput", "diagnostic", "agent", "models", "conversationId", "snapshot", "conversation", "waitForTask"] as const;
/** The members a host tool's api gives only on a run's Harness: a remote executor's api has none of them. */
export const RUN_ONLY_MEMBERS = ["conversationId", "snapshot", "conversation", "waitForTask"] as const;
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

/** What one host tool's call reads of the run: the run's environment (its file environment, the api's `env`), its
 *  harness's commit and its root agent (a paid call's booking and pi's read), the context and the results map, and the
 *  paid-call money seam, over the runner's claim Harness (runner/adapter-run-spec.ts). */
export interface HostToolCtx {
  readonly context: Context;
  readonly results: ToolResults;
  /** The run's environment, as the api's `env` (the file environment; the web and monid tools read none of it). */
  env(): Promise<ToolExecutionApi["env"]>;
  readonly commit: ToolExecutionApi["commit"];
  readonly agent: ToolExecutionApi["agent"];
  /** The run's own Harness's snapshot, conversation and waitForTask (run.harness, the claim's journal on the runner), as
   *  `commit` is: a document, conversation or task of this run only. */
  readonly snapshot: ToolExecutionApi["snapshot"];
  readonly conversation: ToolExecutionApi["conversation"];
  readonly waitForTask: ToolExecutionApi["waitForTask"];
  /** A gate for a tool that cannot be run on the runner yet: undefined to run the call, else the refusal that is its answer,
   *  so the tool is listed but never run as a stub. No tool sets it now (learned_workflow runs for real on every session's
   *  model port); it stays the seam a not-yet-runnable tool refuses through. The paid tools the loop can book
   *  (web_fetch/web_search/monid) carry no such gate; the adapter loop books their requests (bookedIn). */
  settle?(name: string, args: unknown, callId: string): { refused: string } | undefined;
}

/** One pi ToolRegistration `tool` (named `name` by its catalog name) as the kernel's HostTool an adapter session takes:
 *  the paid-call seam, then the tool on the run's environment and harness, its answer the text a
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
    async call(args, { callId, signal }) {
      // The unready-tool seam: a tool that cannot be run on the runner yet is refused in words, never run as a stub.
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
        conversationId: ROOT_CONVERSATION_ID,
        snapshot: ctx.snapshot, conversation: ctx.conversation, waitForTask: ctx.waitForTask,
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
