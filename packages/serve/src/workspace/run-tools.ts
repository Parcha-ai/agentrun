// A run's tools on its Workspace: what the runner's harness start (E2) calls once per run, from the run's Workspace and,
// when it has one, its computer. The tools' definitions, words and limits are the kernel registry's alone (run-adapters
// kernel/registry); this binds them to the run: its Workspace (attached to the computer, when there is one), its hands
// (hands.ts) and the executors the registry takes from the host: pi's read, write and edit, and pi's bash as bash's own
// run, all on one file environment over the Workspace (pi-env.ts).
//
// Where the run's shell is: in the computer ("computer": the folder at /workspace, every host tool), or, with none, the
// run's folder itself ("local": bash runs there, asking first, and the background tools are refused in words). The
// longest command is 600 s, or 295 s on Archil's serverless exec (Mode 2 with no computer); bash's words follow it.
//
// The shell's environment is fixed (hands.ts shellEnv): never a variable of this server's. TMPDIR is .agentrun/tmp in
// the run's folder, and bash's full output goes to .agentrun/output/<id> there; the run's end sweeps both.
//
// The computer's check: `check` is the mount check attach takes (attach.ts MountCheck), which the caller builds with
// the claim's epoch bound in, so a read-back under another epoch is refused.
//
// runTools is the one call: runHands binds the run's hands and executors, the kernel's createRegistry makes the run's
// registry over them, and bindTools gives its tools as the kernel's HostTool, through the run's gate. The run's end
// (end) ends its background processes through the computer (the kernel's endBackground), then sweeps.
import type { Context } from "@earendil-works/chord";
import type { HostTool } from "@parcha/agentrun-kernel";
import { createRegistry, endBackground, type Registry } from "@parcha/agentrun-kernel/kernel";
import type { Park, RunGate } from "../tool-gate.js";
import type { AttachableComputer, MountCheck } from "./attach.js";
import { answerText, type PiAnswer, piExecutor, type PiExecutor } from "./executors.js";
import { ARCHIL_MAX_EXEC_S, type Hands, handsOf, MAX_EXEC_S, shellEnv } from "./hands.js";
import { COMPUTER_ROOT, realOf, workspaceRelative } from "./paths.js";
import { bashTool, fileTools, OUTPUT_DIR, piEnv, readAnywhereInComputer } from "./pi-env.js";
import type { Workspace } from "./workspace.js";

/** The run's computer, as runTools takes it: the computer, and the mount check attach runs (the claim's epoch bound in). */
export type RunComputer = { readonly computer: AttachableComputer; readonly check: MountCheck };

/** The run's scratch in its own folder: bash's TMPDIR. */
export const TMP_DIR = ".agentrun/tmp";

/** What runHands binds for a run. */
export type RunHands = {
  /** The run's Workspace: attached to the computer when there is one. */
  readonly workspace: Workspace;
  readonly hands: Hands;
  /** Where the run's shell is: the registry's ShellPlace. */
  readonly shell: "computer" | "local";
  readonly maxExecS: number;
  /** The name the model knows the run's folder by: /workspace in a computer, the folder's own path otherwise. */
  readonly cwd: string;
  /** Every absolute name of the run's folder a text may hold: cwd, its path here, the aliases given. */
  readonly names: readonly string[];
  /** The registry's host executors: pi's read, write and edit, and pi's bash as bash's own run. */
  readonly executors: { readonly read: PiExecutor; readonly write: PiExecutor; readonly edit: PiExecutor; readonly bash: PiExecutor };
  /** The run's end, after its background processes are ended and before the computer is let go: bash's full outputs
   *  and its TMPDIR swept. */
  sweep(): Promise<void>;
};

/** The run's hands and host executors on `workspace`, attached to `computer` when there is one. `aliases`: other
 *  absolute names of the run's folder a tool call may give (the harness's scratch folder), taken as the folder. */
export async function runHands(workspace: Workspace, computer: RunComputer | undefined, options: { readonly mode: 1 | 2; readonly context: Context; readonly aliases?: readonly string[] }): Promise<RunHands> {
  const spec = await workspace.mountSpec();
  const here = spec.kind === "bind" ? spec.path : undefined;
  const attached = computer === undefined ? workspace : await workspace.attach(computer.computer, computer.check);
  // The folder's name: /workspace in a computer (and on Archil's exec, which has no path of this machine), its own path here.
  const cwd = computer === undefined && here !== undefined ? here : COMPUTER_ROOT;
  const names = [cwd, ...(here !== undefined && here !== cwd ? [here] : []), ...(options.aliases ?? [])];
  const maxExecS = computer === undefined && options.mode === 2 ? ARCHIL_MAX_EXEC_S : MAX_EXEC_S;
  await attached.mkdir(TMP_DIR);
  const env = shellEnv({ tmpdir: `${cwd}/${TMP_DIR}`, ...(computer === undefined ? { home: cwd } : {}) });
  const fileEnv = piEnv(attached, { cwd, aliases: names.slice(1), env, defaultTimeoutS: maxExecS });
  const tools = Object.fromEntries([...fileTools(), bashTool()].map((tool) => [tool.name, tool]));
  const read = computer === undefined ? tools.read! : readAnywhereInComputer(tools.read!, attached, names, env);
  const executor = (tool: typeof read) => piExecutor(tool, fileEnv, options.context);
  return {
    workspace: attached,
    // The computer's processes, for the five background tools: the attached Workspace's own; none with no computer.
    hands: handsOf(attached, { maxExecS, env, ...(computer === undefined ? {} : { processes: attached.process }) }),
    shell: computer === undefined ? "local" : "computer",
    maxExecS,
    cwd,
    names,
    executors: { read: executor(read), write: executor(tools.write!), edit: executor(tools.edit!), bash: executor(tools.bash!) },
    async sweep() {
      // Through the run's own Workspace, not the computer's: the sweep holds whether or not the computer still answers.
      for (const dir of [OUTPUT_DIR, TMP_DIR]) await workspace.remove(dir, { recursive: true, force: true });
    },
  };
}

/** A tool as the kernel's registry lists it: what bindTools reads of its ToolDef. */
export type RegistryDef = { readonly name: string; readonly description: string; readonly parameters: object; readonly replaySafe: boolean };
/** The kernel's registry, as bindTools calls it (run-adapters kernel/registry Registry). */
export type RunRegistry = {
  list(): readonly RegistryDef[];
  invoke(name: string, args: unknown, call: { readonly hands: Hands; readonly signal?: AbortSignal; output?(chunk: string): void }): Promise<PiAnswer>;
};
/** One call's answer, kept by its call id for the run's timeline (an adapter's tool_end carries none). */
export type ToolResults = Map<string, { text: string; isError: boolean }>;

/** The tools whose answer is pi's own words about a path (`Successfully wrote to <path>`), never a file's text. */
const SAYS_PATH: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * `registry`'s tools that `names` names, in that order, bound to `run`: each as the kernel's HostTool, which an adapter's
 * session takes. A call passes the run's gate first (`gated`: the gate and the park it takes; none for the gate's own
 * run of an approved call): a refused one runs nothing, a parked one says it waits. Then the registry runs it on the
 * run's hands, and its answer is the text a model reads (executors.ts answerText): the output, the failure's words, the
 * diagnostics; in a failure, a write's or an edit's answer a path in the run's folder is named relative to it. A
 * failure the registry throws is the answer's text. `results` keeps each answer by its call id.
 */
export function bindTools(run: RunHands, registry: RunRegistry, names: readonly string[], options: { readonly gated?: { readonly gate: RunGate; readonly park: Park }; readonly results?: ToolResults } = {}): HostTool[] {
  const defs = new Map(registry.list().map((def) => [def.name, def] as const));
  const works = [...new Set(run.names.flatMap((name) => [name, realOf(name)]))];
  return names.flatMap((name): HostTool[] => {
    const def = defs.get(name);
    if (!def) return [];
    return [{
      name: def.name,
      description: def.description,
      inputSchema: def.parameters as Record<string, unknown>,
      replay: def.replaySafe ? "safe" : "never",
      async call(args, { callId, signal, attempt }) {
        // A replay (the kernel's attempt above 0) may follow an attempt that was sent: the gate's refusal then says so.
        const refused = await options.gated?.gate.enter(name, args, callId, options.gated.park, (attempt ?? 0) > 0 ? { replayed: true } : {});
        if (refused) {
          const answer = { text: refused.text, isError: refused.isError === true };
          options.results?.set(callId, answer);
          return refused.parked ? { ...answer, parked: true as const } : answer;
        }
        let given: PiAnswer;
        try {
          given = await registry.invoke(name, args, { hands: run.hands, signal });
        } catch (error) {
          given = { text: "", isError: true, error: (error as Error)?.message ?? String(error) };
        }
        const said = answerText(given);
        const isError = given.isError === true;
        const answer = { text: isError || SAYS_PATH.has(name) ? workspaceRelative(said, works) : said, isError };
        options.results?.set(callId, answer);
        return given.images?.length ? { ...answer, images: given.images } : answer;
      },
    }];
  });
}

/** A run's tools: what E2's harness start calls runTools for. */
export type RunTools = {
  /** The run's Workspace: attached to the computer when there is one. */
  readonly workspace: Workspace;
  /** The run's registry: the kernel's definitions, words and limits, over this run's hands and executors. */
  readonly registry: Registry;
  readonly hands: Hands;
  /** The registry's tools `names` names, as the kernel's HostTool an adapter's session takes, each call through the
   *  run's gate (`gated`; none for the gate's own run of an approved call), each answer kept in `results` (bindTools). */
  hostTools(names: readonly string[], gated?: { readonly gate: RunGate; readonly park: Park }, results?: ToolResults): HostTool[];
  /** The run's end, before the computer is let go: its background processes ended (TERM, then KILL 3 s later; none with
   *  no computer), then bash's full outputs and TMPDIR swept. */
  end(): Promise<void>;
};

/**
 * A run's tools on `workspace`, attached to `computer` when there is one. `computer.check` is the mount check attach
 * runs (attach.ts MountCheck: `{ readBackOf, epoch }`), which the caller builds with the claim's epoch, so a read-back
 * under another epoch is refused. `options.mode`: 1, or 2 (the run's folder on Archil); `options.aliases`: other absolute
 * names of the run's folder a tool call may give (the harness's scratch folder). The tools' definitions, words and
 * limits come only from the kernel's registry; this binds its executors to the run.
 */
export async function runTools(workspace: Workspace, computer: RunComputer | undefined, options: { readonly mode: 1 | 2; readonly context: Context; readonly aliases?: readonly string[] }): Promise<RunTools> {
  const run = await runHands(workspace, computer, options);
  const registry = createRegistry({ maxExecS: run.maxExecS, shell: run.shell, executors: run.executors });
  return {
    workspace: run.workspace,
    registry,
    hands: run.hands,
    hostTools: (names, gated, results) => bindTools(run, registry, names, { ...(gated ? { gated } : {}), ...(results ? { results } : {}) }),
    async end() {
      await endBackground(run.hands);
      await run.sweep();
    },
  };
}
