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
// The registry itself joins here (runTools) once the kernel's registry is in the base; until then runHands gives what it
// binds.
import type { Context } from "@earendil-works/chord";
import type { AttachableComputer, MountCheck } from "./attach.js";
import { piExecutor, type PiExecutor } from "./executors.js";
import { ARCHIL_MAX_EXEC_S, type Hands, handsOf, MAX_EXEC_S, shellEnv } from "./hands.js";
import { COMPUTER_ROOT } from "./paths.js";
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
    hands: handsOf(attached, { maxExecS, env }),
    shell: computer === undefined ? "local" : "computer",
    maxExecS,
    cwd,
    executors: { read: executor(read), write: executor(tools.write!), edit: executor(tools.edit!), bash: executor(tools.bash!) },
    async sweep() {
      // Through the run's own Workspace, not the computer's: the sweep holds whether or not the computer still answers.
      for (const dir of [OUTPUT_DIR, TMP_DIR]) await workspace.remove(dir, { recursive: true, force: true });
    },
  };
}
