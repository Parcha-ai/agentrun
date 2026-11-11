// How serve names a path in the run's workspace to a person or a model: relative to the workspace, never by the server's
// data directory. The rule is one for every place that shows a path: a host tool's error or write result
// (host-tools.ts), and a row's file path (rowPaths).
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { realOf } from "./workspace/paths.js";

// How a text names the run's folder, and a path as the kernel resolves it, are the Workspace's (workspace/paths.ts).
export { realOf, workspaceRelative } from "./workspace/paths.js";

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
