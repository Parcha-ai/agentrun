import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkRun, runOf, type Change, type Problem } from "./check.js";
import { CAPS, isUntouchable, placeOf } from "./layout.js";
import type { ToolPolicy } from "./tools.js";

const exec = promisify(execFile);

export type CheckBranchInput = {
  /** A directory in the repository. */
  readonly cwd: string;
  /** The ref the run's branch merges into, usually `main` or `origin/main`. */
  readonly base: string;
  /** The run's commit; `HEAD` by default. */
  readonly head?: string;
  /** The branch the run pushes, `runs/<run id>`. By default the branch `head` names. */
  readonly branch?: string;
  readonly tools?: Partial<ToolPolicy>;
  readonly refuseValues?: readonly string[];
};

export type BranchCheck = { readonly run?: string; readonly branch?: string; readonly forkPoint?: string; readonly problems: Problem[] };

/** A ref that does not name a commit. */
export class RefError extends Error {}

// Reads only objects: no command here touches the work tree, so no filter, hook or fsmonitor of the repository runs.
const SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", [...SAFE, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function blob(cwd: string, sha: string): Promise<Buffer> {
  return (await exec("git", [...SAFE, "cat-file", "blob", sha], { cwd, encoding: "buffer", maxBuffer: 2 * CAPS.file })).stdout;
}

async function commit(cwd: string, ref: string): Promise<string> {
  try {
    return (await git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).trim();
  } catch {
    throw new RefError(`${JSON.stringify(ref)} does not name a commit`);
  }
}

/** The branch a ref names: `HEAD`'s current branch, `refs/heads/<b>`, or `refs/remotes/<remote>/<b>`. */
async function branchOf(cwd: string, head: string): Promise<string | undefined> {
  try {
    if (head === "HEAD") return (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim() || undefined;
    const full = (await git(cwd, ["rev-parse", "--symbolic-full-name", "--end-of-options", head])).trim();
    if (full.startsWith("refs/heads/")) return full.slice("refs/heads/".length);
    if (full.startsWith("refs/remotes/")) return full.split("/").slice(3).join("/") || undefined;
  } catch {
    // a detached HEAD, or a sha: no branch
  }
  return undefined;
}

const STATUS: Record<string, Change["status"]> = { A: "added", M: "modified", T: "modified", D: "deleted" };

/** Checks the run's branch in a git repository: the changes from where it starts on `base` to `head`. Throws RefError
 *  when `base` or `head` names no commit. */
export async function checkBranch(input: CheckBranchInput): Promise<BranchCheck> {
  const { cwd } = input;
  const base = await commit(cwd, input.base);
  const head = await commit(cwd, input.head ?? "HEAD");
  const branch = input.branch ?? (await branchOf(cwd, input.head ?? "HEAD"));
  const named = { ...(branch !== undefined && runOf(branch) ? { run: runOf(branch) } : {}), ...(branch !== undefined ? { branch } : {}) };
  let forkPoint: string;
  try {
    forkPoint = (await git(cwd, ["merge-base", base, head])).trim();
  } catch {
    return { ...named, problems: [{ rule: "branch", detail: "the branch shares no history with the base" }] };
  }
  const raw = (await git(cwd, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", "--no-ext-diff", forkPoint, head])).split("\0");
  const changes: Change[] = [];
  for (let at = 0; at + 1 < raw.length; at += 2) {
    const [, mode, sha, letter] = /^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) ([A-Z])/.exec(raw[at]!) ?? [];
    const path = raw[at + 1]!;
    const status = STATUS[letter ?? ""];
    if (!status) throw new Error(`git diff gave an entry this checker does not read: ${JSON.stringify(raw[at])}`);
    if (status === "deleted") { changes.push({ path, status }); continue; }
    if (mode !== "100644" || isUntouchable(path) || !placeOf(path)) { changes.push({ path, status, mode: mode! }); continue; }
    const size = Number((await git(cwd, ["cat-file", "-s", sha!])).trim());
    changes.push(size > CAPS.file ? { path, status, mode, size } : { path, status, mode, size, bytes: await blob(cwd, sha!) });
  }
  const headFiles = (await git(cwd, ["ls-tree", "-r", "-z", "--name-only", head])).split("\0").filter(Boolean);
  const problems = checkRun({ branch: branch ?? "", changes, forkPoint, headFiles, ...(input.tools ? { tools: input.tools } : {}), ...(input.refuseValues ? { refuseValues: input.refuseValues } : {}) });
  return { ...named, forkPoint, problems };
}
