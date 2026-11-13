// The kernel's one registry of host tools: the model-visible definitions (defs.ts), each with its executor. read,
// write and edit, and bash's own run, are the host's (pi's tools over the run's hands, until their semantics move
// here); the kernel bounds bash and runs the five background tools itself. A desktop or a phone adds the computer's
// tools after them (computer.ts), as its groups offer them, under its kind's settings key: observe, act and screenshot
// run on the kernel's own executors over the hands' computer port; computer_script runs in the host's isolate, listed
// only where the host gives it. A registry missing an executor for a tool the model sees is refused when it is built,
// so a run never offers a tool it cannot run. A computer's tool the run does not have is refused in words that name
// the setting.
import { BACKGROUND_EXECUTORS, NEEDS_A_COMPUTER, NO_SHELL } from "./background.js";
import { boundedBash } from "./bash.js";
import { COMPUTER_TOOLS, computerExecutors, computerToolDefs, computerToolsFor, SCRIPT_TOOL } from "./computer.js";
import { CAPABILITY_KINDS, hostToolDefs, type ShellPlace, type ToolDef } from "./defs.js";
import { answerOf, type CapabilityKind, type Executor, type HostExecutors, needsKindWords, type ToolAnswer, type ToolCall } from "./hands.js";
import { BACKGROUND_TOOLS } from "./limits.js";

export type Registry = {
  /** The tools the model sees, in order. */
  list(): readonly ToolDef[];
  get(name: string): ToolDef | undefined;
  invoke(name: string, args: unknown, call: ToolCall): Promise<ToolAnswer>;
};

/** The registry of a run's host tools, by where its shell is, and its computer's kind (`kinds`: none, or the desktop or
 *  the phone it is) with its groups (`groups`, its hello's: which of the computer's tools it offers), with the host's
 *  executors. */
export function createRegistry(options: { maxExecS: number; shell: ShellPlace; kinds?: readonly CapabilityKind[]; groups?: readonly string[]; executors: HostExecutors }): Registry {
  const { shell, executors } = options;
  const kind = CAPABILITY_KINDS.find((each) => options.kinds?.includes(each));
  const own = hostToolDefs({ maxExecS: options.maxExecS, shell });
  const runs = new Map<string, Executor>();
  for (const def of own) {
    const run = def.name === "bash"
      ? executors.bash && boundedBash(executors.bash, shell === "computer")
      : BACKGROUND_EXECUTORS[def.name] ?? executors[def.name as "read" | "write" | "edit"];
    if (!run) throw new Error(`the registry has no executor for ${def.name}, a tool the model sees: the host gives read, write, edit and bash's own run`);
    runs.set(def.name, run);
  }
  const defs = [...own];
  if (kind) {
    const groups = options.groups ?? [];
    const offered = computerToolsFor(groups);
    const kernel = computerExecutors(kind);
    for (const def of computerToolDefs(kind, groups)) {
      if (!offered.includes(def.name)) continue;
      const run = def.name === SCRIPT_TOOL ? executors.computer_script : kernel[def.name];
      // The script is the host's to run (its isolate): a host that gives none lists none.
      if (!run) continue;
      runs.set(def.name, run);
      defs.push(def);
    }
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
        // No shell at all: bash is not listed, and a call of it anyway says how to get one.
        if (shell === "none" && name === "bash") throw new Error(NO_SHELL);
        if ((COMPUTER_TOOLS as readonly string[]).includes(name)) {
          if (kind) throw new Error(`${name} is not offered by this ${kind} computer: it offers ${(options.groups ?? []).join(", ") || "no groups"}`);
          throw new Error(`${needsKindWords(name, "desktop")} A phone computer has it too.`);
        }
        throw new Error(`there is no host tool ${name} in this run`);
      });
    },
  };
}
