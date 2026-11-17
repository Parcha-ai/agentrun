// The agent's process: its environment and its confinement. Copied from OpenCode's (packages/serve/src/harness-opencode/
// host/server.ts, `INHERITED_ENV`, `confined`, `childEnv`), not shared: each harness keeps its own copy, so neither moves
// when the other changes. Written for AgentRun.
//  - The child's environment is an allowlist: PATH, LANG and TZ from this process, then what the drive names (its private
//    HOME and directories, the recipe's own variables). Nothing else is inherited, so no provider key, token or host secret
//    reaches it.
//  - It runs in its own process group, which a kill ends whole, and dies with this process: started with a watch on its
//    parent (the kernel host's parentWatched), inside the host's confinement.

/** The variables a child takes from this process, when they are set. */
export const INHERITED_ENV = Object.freeze(["PATH", "LANG", "TZ"] as const);

/** A command and its arguments, as the drive starts it. */
export interface ChildCommand {
  command: string;
  args: string[];
}

/** The host's confinement of a child: the same command and arguments, started under the host's own (a
 *  `setpriv --no-new-privs` prefix, say). It may only add in front, and never sees or changes the child's environment. */
export type ConfineChild = (child: Readonly<ChildCommand>) => ChildCommand;

/** The command `confine` makes of `child`, refused unless it ends with the child's command and arguments unchanged. */
export function confined(child: ChildCommand, confine: ConfineChild | undefined): ChildCommand {
  if (!confine) return child;
  const out = confine({ command: child.command, args: [...child.args] });
  const argv = [out?.command, ...(Array.isArray(out?.args) ? out.args : [])];
  const tail = argv.slice(argv.length - child.args.length - 1);
  const kept = argv.length > child.args.length + 1 && tail.length === child.args.length + 1 && tail.every((a, i) => a === (i === 0 ? child.command : child.args[i - 1]));
  if (typeof out?.command !== "string" || !argv.every((a) => typeof a === "string") || !kept) throw new Error("acp: the host's confinement must start the child's own command and arguments, after its own");
  return { command: out.command, args: out.args };
}

/** The child's environment: the allowlist from `from`, then what the caller names. */
export function childEnv(from: Readonly<Record<string, string | undefined>>, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = from[name];
    if (typeof value === "string") env[name] = value;
  }
  return { ...env, ...extra };
}
