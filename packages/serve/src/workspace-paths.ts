// How serve names a path in the run's workspace to a person or a model: relative to the workspace, never by the server's
// data directory. The rule is one for every place that shows a path: a host tool's error or write result
// (host-tools.ts), and a timeline row's file (runs.ts, through the projector's `path` option). A refusal of a path
// outside the workspace names the path the call gave, as it gave it, and no other (`asGivenRefusals`), wherever the
// coding tools come from (coding-tools.ts: pi's own runs and the other harnesses' host tools, on the runner and in a box).
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { PathOutsideWorkError } from "@parcha/pi-durable-disk";
import { realOf } from "./workspace/paths.js";

// How a text names the run's folder, and a path as the kernel resolves it, are the Workspace's (workspace/paths.ts).
export { realOf, workspaceRelative } from "./workspace/paths.js";

/** A refusal already named by the path the call gave: `asGivenRefusals` passes it on as it is. */
class GivenPathRefusal extends PathOutsideWorkError {}

/**
 * Refuses `given`, a path a call gave that leaves the workspace, in the one words every refusal uses:
 * `<given>: outside the workspace`, and no other path (not the workspace, a box's work dir, or where it resolves). It is
 * the confinement's typed refusal (`PathOutsideWorkError`, `outside_work`), so its type tells it from any other error.
 * For a tool that checks a path itself (a box's file tools); pi's own tools refuse through the confinement, named by
 * `asGivenRefusals`.
 */
export function refuseOutsideWorkspace(given: string): never {
  throw new GivenPathRefusal(given, "outside_work", `${given}: outside the workspace`);
}

/**
 * pi's file `tools`, each with its confinement's refusal named by the path the call gave, as it gave it:
 * `../../.token: outside the workspace`. The confinement names no path itself: pi's tools resolve a path against the
 * workspace before they ask for it, so every path it sees is the host's own (`<data>/runs/.token`), and the call's
 * `path` is the only one the model gave. A refusal is told by its type (`PathOutsideWorkError`), never by its text; one
 * already named (`refuseOutsideWorkspace`), every other error, and every result are the tool's own.
 */
export function asGivenRefusals(tools: readonly ToolRegistration[]): ToolRegistration[] {
  return tools.map((tool): ToolRegistration => ({
    ...tool,
    async execute(args, api, context) {
      try {
        return await tool.execute(args, api, context);
      } catch (error) {
        const reason = error instanceof PathOutsideWorkError ? error.reason : undefined;
        const given = (args as { path?: unknown } | undefined)?.path;
        if (reason === undefined || error instanceof GivenPathRefusal || typeof given !== "string" || given === "") throw error;
        throw new GivenPathRefusal(given, reason, `${given}: ${(error as Error).message}`);
      }
    },
  }));
}

/** How a run's rows name a file path, a whole path (never a text): one in the run's directory relative to its workspace
 *  (`<run>/work`: `hello.md`, `.`, `../work 2024/a.md`, `..`), and any other path, or one that is not absolute, exactly
 *  as given. Checked against the workspace as serve names it and as the kernel resolves it (a harness's CLI sends the
 *  resolved one: its working directory is `work/`). By `path.relative`, segment by segment, so a sibling whose name
 *  starts with `work` is never taken for it. Text, such as a tool's error, goes through `workspaceRelative`. */
export function rowPaths(runDir: string): (path: string) => string {
  if (!isAbsolute(runDir)) return (path) => path;
  const work = join(runDir, "work");
  const works = [...new Set([work, realOf(work)])];
  /** Whether `rel`, a `path.relative`, stays inside its base: not `..`, not under `..`, not absolute (another root). */
  const within = (rel: string) => rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  return (path) => {
    if (!isAbsolute(path)) return path;
    for (const named of works) {
      if (!within(relative(dirname(named), path))) continue;
      return relative(named, path) || ".";
    }
    return path;
  };
}
