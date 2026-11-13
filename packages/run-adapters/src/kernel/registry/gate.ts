// The tool gate's shell family, moved from serve's tool-gate.ts unchanged, and the host tools' default permissions by
// where the run's shell is (the cutover's ruled change: with no computer, bash runs in the run's folder and is asked
// first, and the background tools are refused).
import { BACKGROUND_TOOLS, SHELL_TOOLS } from "./limits.js";

export type Permission = "allow" | "ask" | "deny";

/** The tools that run a command on the run's computer (SHELL_TOOLS), each held to bash's setting: bash: deny refuses
 *  bash_background as it refuses bash, and none of them is a settings key of its own. Under bash: ask the watchers
 *  (SHELL_WATCHERS) run unasked. */
export const SHELL_FAMILY: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(SHELL_TOOLS.map((name) => [name, "bash"])));

/** The shell tools that only watch or end a process the run already started, by its own id (an id is digits under the
 *  run's own work/background/, and another's is "no background process"): under bash: ask they run unasked, so watching
 *  an approved process costs no approval per page. bash: deny still refuses them. */
export const SHELL_WATCHERS: ReadonlySet<string> = new Set(["bash_output", "bash_list", "bash_signal"]);

/** Shell tool `name`'s permission, given bash's: a watcher's ask is allow; any other keeps bash's. */
export const shellPermission = (name: string, bash: Permission): Permission => (bash === "ask" && SHELL_WATCHERS.has(name) ? "allow" : bash);

/** The shell tool a call named `name` is, under claude-agent's host-tool name too (`mcp__hands__bash_background`), when
 *  it is one held to another's setting: its own name, which its request, its refusal and its approved call keep. */
export const shellToolOf = (name: string): string | undefined => {
  const own = name.replace(/^mcp__hands__/, "");
  return Object.hasOwn(SHELL_FAMILY, own) && SHELL_FAMILY[own] !== own ? own : undefined;
};

/** A host tool's permission when no setting names it, by where the run's shell is. On a computer every host tool is
 *  allowed, as main's defaults are. With no computer, bash runs in the run's own folder on this machine, so it is asked
 *  first, and the background tools, which need a computer, are refused. */
export function defaultPermissionOf(name: string, where: { computer: boolean }): Permission {
  if (where.computer) return "allow";
  if (name === "bash") return "ask";
  if ((BACKGROUND_TOOLS as readonly string[]).includes(name)) return "deny";
  return "allow";
}
