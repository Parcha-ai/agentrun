// The kernel's one registry of host tools: the model-visible definitions (defs.ts), each with its executor. read,
// write and edit, and bash's own run, are the host's (pi's tools over the run's hands, until their semantics move
// here); the kernel bounds bash and runs the five background tools itself. A registry missing an executor for a tool
// the model sees is refused when it is built, so a run never offers a tool it cannot run.
import { BACKGROUND_EXECUTORS, NEEDS_A_COMPUTER } from "./background.js";
import { boundedBash } from "./bash.js";
import { hostToolDefs, type ShellPlace, type ToolDef } from "./defs.js";
import { answerOf, type Executor, type HostExecutors, type ToolAnswer, type ToolCall } from "./hands.js";
import { BACKGROUND_TOOLS } from "./limits.js";

export type Registry = {
  /** The tools the model sees, in order. */
  list(): readonly ToolDef[];
  get(name: string): ToolDef | undefined;
  invoke(name: string, args: unknown, call: ToolCall): Promise<ToolAnswer>;
};

/** The registry of a run's host tools, by where its shell is, with the host's executors. */
export function createRegistry(options: { maxExecS: number; shell: ShellPlace; executors: HostExecutors }): Registry {
  const { shell, executors } = options;
  const defs = hostToolDefs({ maxExecS: options.maxExecS, shell });
  const runs = new Map<string, Executor>();
  for (const def of defs) {
    const run = def.name === "bash"
      ? executors.bash && boundedBash(executors.bash, shell === "computer")
      : BACKGROUND_EXECUTORS[def.name] ?? executors[def.name as keyof HostExecutors];
    if (!run) throw new Error(`the registry has no executor for ${def.name}, a tool the model sees: the host gives read, write, edit and bash's own run`);
    runs.set(def.name, run);
  }
  const byName = new Map(defs.map((def) => [def.name, def]));
  return {
    list: () => defs,
    get: (name) => byName.get(name) ?? defs.find((def) => def.gateName === name),
    invoke(name, args, call) {
      const run = runs.get(name);
      if (run) return run(args, call);
      return answerOf(call, async () => {
        if (shell !== "computer" && (BACKGROUND_TOOLS as readonly string[]).includes(name)) {
          throw new Error(NEEDS_A_COMPUTER);
        }
        throw new Error(`there is no host tool ${name} in this run`);
      });
    },
  };
}
