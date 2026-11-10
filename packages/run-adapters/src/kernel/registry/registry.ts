// The kernel's one registry of host tools: the model-visible definitions (defs.ts), each with its executor. read,
// write and edit, and bash's own run, are the host's (pi's tools over the run's hands, until their semantics move
// here); the kernel bounds bash and runs the five background tools itself. A computer of a kind past files and a shell
// adds its kind's tools after them, in a fixed order: the desktop's and the phone's run on the kernel's own executors
// over the hands' narrow ports; the browser's are the host's contracts and runs (pi-browser's). A registry missing an
// executor for a tool the model sees is refused when it is built, so a run never offers a tool it cannot run. A kind's
// tool the run does not have is refused in words that name the setting.
import { BACKGROUND_EXECUTORS, NEEDS_A_COMPUTER, NO_SHELL } from "./background.js";
import { boundedBash } from "./bash.js";
import type { BrowserContract } from "./browser.js";
import { CAPABILITY_KINDS, capabilityToolDefs, hostToolDefs, type ShellPlace, type ToolDef } from "./defs.js";
import { DESKTOP_EXECUTORS, DESKTOP_TOOL_DEFS } from "./desktop.js";
import { answerOf, type CapabilityKind, type Executor, type HostExecutors, needsKindWords, type ToolAnswer, type ToolCall } from "./hands.js";
import { BACKGROUND_TOOLS } from "./limits.js";
import { PHONE_EXECUTORS, PHONE_TOOL_DEFS } from "./phone.js";

export type Registry = {
  /** The tools the model sees, in order. */
  list(): readonly ToolDef[];
  get(name: string): ToolDef | undefined;
  invoke(name: string, args: unknown, call: ToolCall): Promise<ToolAnswer>;
};

/** The registry of a run's host tools, by where its shell is, and its computer's kinds (`kinds`: none, or the desktop,
 *  the phone or the browser it is), with the host's executors. `browserTools`: pi-browser's BROWSER_TOOLS, as the host
 *  lists them for this run; needed with the browser kind, and naming them in a refusal without it. `without`: a kind's
 *  tools this run's computer does not offer (its capabilities lack them: an iPhone's tree and keys, say), not listed to
 *  the model; one called anyway runs, and its port's absence answers in words. */
export function createRegistry(options: { maxExecS: number; shell: ShellPlace; kinds?: readonly CapabilityKind[]; executors: HostExecutors; browserTools?: readonly BrowserContract[]; without?: readonly string[] }): Registry {
  const { shell, executors } = options;
  const kinds = CAPABILITY_KINDS.filter((kind) => options.kinds?.includes(kind));
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
  for (const kind of kinds) {
    for (const def of capabilityToolDefs(kind, options.browserTools ? { browserTools: options.browserTools } : {})) {
      // A tool two kinds share (the hand-over) is listed once, as the first kind gives it.
      if (runs.has(def.name)) continue;
      const run = kind === "desktop" ? DESKTOP_EXECUTORS[def.name] : kind === "phone" ? PHONE_EXECUTORS[def.name] : executors.browser?.[def.name];
      if (!run) throw new Error(`the registry has no executor for ${def.name}, a ${kind} tool the model sees: the host gives the browser's runs`);
      runs.set(def.name, run);
      if (!options.without?.includes(def.name)) defs.push(def);
    }
  }
  // Every kind's tool by name, the run's or not, for the refusal of one it does not have.
  const kindOf = new Map<string, CapabilityKind>([
    ...DESKTOP_TOOL_DEFS.map((def) => [def.name, "desktop"] as const),
    ...PHONE_TOOL_DEFS.map((def) => [def.name, "phone"] as const),
    ...(options.browserTools ?? []).map((contract) => [contract.name, "browser"] as const),
  ]);
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
        const kind = kindOf.get(name);
        if (kind) throw new Error(needsKindWords(name, kind));
        throw new Error(`there is no host tool ${name} in this run`);
      });
    },
  };
}
