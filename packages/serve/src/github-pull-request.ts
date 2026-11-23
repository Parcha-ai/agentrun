// A pull request that adds files to one repository, made through GitHub's REST API with one installation token of the
// server's GitHub App, narrowed to that repository with contents and pull requests write (suggestions.ts mints it): the
// default branch's head, a tree of the new files over it, a commit, a branch at that commit, then the pull request. No git
// binary and no clone: GitHub's Git Data API. A file the base already has is refused before anything is written, so a pull
// request made here only ever adds files, and never touches a workflow (`.github/`), which the caller refuses first.
// What GitHub answers is worded here; its own words are never passed on whole.
import { githubCall } from "./github.js";
import { isObject } from "./validate.js";

/** A file the pull request adds: its path from the repository's root, and its text. */
export type NewFile = { readonly path: string; readonly content: string };

/** Why a write was refused: a file already there, the token's permissions, a branch name taken five times, or GitHub. */
export class GithubWriteRefused extends Error {
  constructor(
    readonly kind: "file_exists" | "not_permitted" | "branch_taken" | "github_failed",
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

/** The commit pushed: on `branch`, made over the default branch `base` at `baseSha`. */
export type Pushed = { readonly branch: string; readonly commit: string; readonly base: string; readonly baseSha: string };

/** How many names a branch is tried under (`b`, `b-2`, ... `b-5`) before it is refused. */
const BRANCH_TRIES = 5;

const segments = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const field = (json: unknown, name: string): unknown => (isObject(json) ? json[name] : undefined);

/** A refusal for an answer GitHub gave a write: 403 and 404 are the token's permissions (GitHub answers 404 for a write
 *  an installation may not make on a repository it can read), anything else GitHub's failure. */
function refused(step: string, repo: string, status: number): GithubWriteRefused {
  if (status === 403 || status === 404) return new GithubWriteRefused("not_permitted", `GitHub refused to ${step} on ${repo} (HTTP ${status}): the GitHub App's installation needs Contents: write and Pull requests: write there.`);
  return new GithubWriteRefused("github_failed", `GitHub did not ${step} on ${repo} (HTTP ${status}).`);
}

/** The default branch of `repo` and its head, read with `token`. */
async function defaultHead(api: string, token: string, repo: string, signal?: AbortSignal): Promise<{ base: string; baseSha: string; tree: string }> {
  const opts = { jwt: token, ...(signal ? { signal } : {}) };
  const about = await githubCall(api, `/repos/${repo}`, opts);
  const base = field(about.json, "default_branch");
  if (about.status !== 200 || typeof base !== "string" || !base) throw refused("read the repository", repo, about.status);
  const ref = await githubCall(api, `/repos/${repo}/git/ref/heads/${segments(base)}`, opts);
  const baseSha = field(field(ref.json, "object"), "sha");
  if (ref.status !== 200 || typeof baseSha !== "string") throw refused(`read the head of ${base}`, repo, ref.status);
  const commit = await githubCall(api, `/repos/${repo}/git/commits/${baseSha}`, opts);
  const tree = field(field(commit.json, "tree"), "sha");
  if (commit.status !== 200 || typeof tree !== "string") throw refused(`read the commit ${baseSha}`, repo, commit.status);
  return { base, baseSha, tree };
}

/** The files of `files` that `repo` already has at `sha` (each asked by path: 200 there, 404 not). */
export async function filesThere(api: string, token: string, repo: string, sha: string, files: readonly NewFile[], signal?: AbortSignal): Promise<string[]> {
  const there: string[] = [];
  for (const file of files) {
    const read = await githubCall(api, `/repos/${repo}/contents/${segments(file.path)}?ref=${sha}`, { jwt: token, ...(signal ? { signal } : {}) });
    if (read.status === 200) there.push(file.path);
    else if (read.status !== 404) throw refused(`read ${file.path}`, repo, read.status);
  }
  return there;
}

/** `files` committed over the head of `repo`'s default branch, on a new branch named `branch` (or `branch-2` ... when
 *  that name is taken). Refused, with nothing written, when a file is already there. */
export async function pushFiles(api: string, token: string, repo: string, change: { branch: string; message: string; files: readonly NewFile[] }, signal?: AbortSignal): Promise<Pushed> {
  const opts = { jwt: token, ...(signal ? { signal } : {}) };
  const { base, baseSha, tree } = await defaultHead(api, token, repo, signal);
  const there = await filesThere(api, token, repo, baseSha, change.files, signal);
  if (there.length) throw new GithubWriteRefused("file_exists", `${repo} already has ${there.join(", ")} on ${base}: a suggested agent's pull request only adds files, so nothing was written.`, there[0]);
  const made = await githubCall(api, `/repos/${repo}/git/trees`, { ...opts, method: "POST", body: { base_tree: tree, tree: change.files.map((file) => ({ path: file.path, mode: "100644", type: "blob", content: file.content })) } });
  const newTree = field(made.json, "sha");
  if (made.status !== 201 || typeof newTree !== "string") throw refused("write the files", repo, made.status);
  const committed = await githubCall(api, `/repos/${repo}/git/commits`, { ...opts, method: "POST", body: { message: change.message, tree: newTree, parents: [baseSha] } });
  const commit = field(committed.json, "sha");
  if (committed.status !== 201 || typeof commit !== "string") throw refused("commit the files", repo, committed.status);
  for (let i = 1; i <= BRANCH_TRIES; i++) {
    const branch = i === 1 ? change.branch : `${change.branch}-${i}`;
    const ref = await githubCall(api, `/repos/${repo}/git/refs`, { ...opts, method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit } });
    if (ref.status === 201) return { branch, commit, base, baseSha };
    // 422: the name is taken (GitHub's "Reference already exists"): the next name.
    if (ref.status !== 422) throw refused(`make the branch ${branch}`, repo, ref.status);
  }
  throw new GithubWriteRefused("branch_taken", `${repo} already has branches ${change.branch} to ${change.branch}-${BRANCH_TRIES}: delete the old ones, then create again.`);
}

/** The pull request of `pushed.branch` into its base, or the open one GitHub already has for that branch. */
export async function openPull(api: string, token: string, repo: string, pushed: Pick<Pushed, "branch" | "base">, text: { title: string; body: string }, signal?: AbortSignal): Promise<{ number: number; url: string }> {
  const opts = { jwt: token, ...(signal ? { signal } : {}) };
  const opened = await githubCall(api, `/repos/${repo}/pulls`, { ...opts, method: "POST", body: { title: text.title, head: pushed.branch, base: pushed.base, body: text.body } });
  const number = field(opened.json, "number");
  const url = field(opened.json, "html_url");
  if (opened.status === 201 && Number.isSafeInteger(number) && typeof url === "string") return { number: number as number, url };
  if (opened.status === 422) {
    // One already open for this branch (a create sent again): that one.
    const owner = repo.split("/")[0]!;
    const open = await githubCall(api, `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${pushed.branch}`)}`, opts);
    const first = Array.isArray(open.json) ? open.json[0] : undefined;
    const n = field(first, "number");
    const u = field(first, "html_url");
    if (open.status === 200 && Number.isSafeInteger(n) && typeof u === "string") return { number: n as number, url: u };
  }
  throw refused(`open the pull request from ${pushed.branch}`, repo, opened.status);
}

/** The branch removed: what a create that failed after its push leaves behind. Best effort; false when GitHub did not. */
export async function deleteBranch(api: string, token: string, repo: string, branch: string): Promise<boolean> {
  const gone = await githubCall(api, `/repos/${repo}/git/refs/heads/${segments(branch)}`, { method: "DELETE", jwt: token }).catch(() => undefined);
  return gone?.status === 204;
}
