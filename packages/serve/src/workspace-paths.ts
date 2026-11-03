// How serve names a path in the run's workspace to a person or a model: relative to the workspace, never by the server's
// data directory. The rule is one for every place that shows a path: a host tool's error or write result
// (host-tools.ts), and a timeline row's file (runs.ts, through the projector's `path` option). A refusal of a path
// outside the workspace names the path the call gave, as it gave it, and no other (`asGivenRefusals`), wherever the
// coding tools come from (coding-tools.ts: pi's own runs and the other harnesses' host tools, on the runner and in a box).
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { PathOutsideWorkError, refusalOf } from "@parcha/pi-durable-disk";

/**
 * `text` with the workspace's absolute path taken out: `<work>/notes/a.md` reads `notes/a.md`, the workspace itself `.`,
 * a path beside it `../x` (pi's tools resolve a relative path before they refuse it), and pi's refusal ("<path>: outside
 * the workspace <work>") names no directory. `works` is the workspace as the environment names it and as the kernel
 * resolves it (they differ under a symlinked directory). For a refusal, an error, and a write's or edit's result; a
 * read's result is the file's own text and is never changed.
 */
export function workspaceRelative(text: string, works: readonly string[]): string {
  const escape = (path: string) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A name counts only where a path starts (not inside a longer one), and, unless a "/" follows, where it ends (a quote, a
  // space, a separator or the text's end).
  const start = "(?<![\\w./~-])";
  const end = "(?![^'\"\\s,;:)\\]])";
  let out = text;
  // Longest first, so a name inside another is taken out before the outer one could take its prefix.
  for (const work of [...new Set(works)].filter((w) => w.length > 1).sort((a, b) => b.length - a.length)) {
    const name = `${start}${escape(work)}`;
    out = out
      .replace(new RegExp(`outside the workspace ${name}${end}`, "g"), "outside the workspace")
      .replace(new RegExp(`${name}/`, "g"), "")
      .replace(new RegExp(`${name}${end}`, "g"), ".");
    const parent = dirname(work);
    if (parent.length > 1) out = out.replace(new RegExp(`${start}${escape(parent)}/`, "g"), "../").replace(new RegExp(`${start}${escape(parent)}${end}`, "g"), "..");
  }
  return out;
}

/** A refusal already named by the path the call gave: `asGivenRefusals` passes it on as it is. */
class GivenPathRefusal extends PathOutsideWorkError {}

/**
 * Refuses `given`, a path a call gave that leaves the workspace, in the one words every refusal uses:
 * `<given>: outside the workspace`, and no other path (not the workspace, a box's work dir, or where it resolves). It is
 * the confinement's typed refusal (`PathOutsideWorkError`, `outside_work`), so `refusalOf` tells it from any other error.
 * For a tool that checks a path itself (a box's file tools); pi's own tools refuse through the confinement, named by
 * `asGivenRefusals`.
 */
export function refuseOutsideWorkspace(given: string): never {
  throw new GivenPathRefusal(given, "outside_work", `${given}: outside the workspace`);
}

/**
 * pi's file `tools`, each with its confinement's refusal named by the path the call gave, as it gave it:
 * `../../.token: outside the workspace`. The confinement names no path itself: pi's tools resolve a path against the
 * workspace before they ask for it, so every path it sees is the host's own (`<data>/runs/.token`), and the call's `path`
 * is the only one the model gave. A refusal is told by its type (`refusalOf`), never by its text; one already named
 * (`refuseOutsideWorkspace`), every other error, and every result are the tool's own.
 */
export function asGivenRefusals(tools: readonly ToolRegistration[]): ToolRegistration[] {
  return tools.map((tool): ToolRegistration => ({
    ...tool,
    async execute(args, api, context) {
      try {
        return await tool.execute(args, api, context);
      } catch (error) {
        const reason = refusalOf(error);
        const given = (args as { path?: unknown } | undefined)?.path;
        if (reason === undefined || error instanceof GivenPathRefusal || typeof given !== "string" || given === "") throw error;
        throw new GivenPathRefusal(given, reason, `${given}: ${(error as Error).message}`);
      }
    },
  }));
}

/** `path` as the kernel resolves it, or itself when it cannot be resolved. */
export const realOf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

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
