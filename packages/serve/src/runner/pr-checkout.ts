// A run's checkout of the pull request it was started for, made by the server before the first turn when the agent's
// definition says `checkout: pull_request` (a template's manifest sets it). The agent then starts with the repository at
// the pull request's head in `repo/` of its folder, its base and their merge base fetched beside it, and never holds a
// GitHub token: the fetch is the server's own, one exec on the run's Workspace (Mode 1 a process on this machine, Mode 2
// Archil's serverless exec over the run's folder), never a command of the agent's. On an Archil region with no serverless
// exec (archil-settings.ts noExecRegionOf) the disk runs no command: the fetch runs in the run's computer, through its
// own exec, once it has mounted the run's folder (checkoutWhereNoExec), and a run with no such computer has none.
//
// Which computer that may be: only one this claim started (computer-for-claim.ts ClaimComputer.fresh), where nothing of
// the agent's has run yet, since the checkout comes before the run's first turn. A sandbox an earlier claim kept at its
// park and this claim took back, the agent's own computer (a persistent setting, shared by its runs) and a paired
// computer (a person's own machine) may already have run the agent's code: a process it left there can read a git's
// environment, and a program it put ahead of git on the PATH, or a hook, runs in the fetch. The server hands such a
// computer no GitHub token: no checkout is made in it, and the run and its timeline are told why up front.
//
// What it reads of the run: its first message's payload tag alone (github.ts githubPullOf), which the server wrote from a
// signed GitHub delivery: the repository, the pull request's number, its head and its base. Nothing else names a
// repository to fetch.
//
// The credential: an installation token of the server's GitHub App, minted for that one repository with
// {contents: "read"} alone, handed to the exec on its stdin (Archil's: a spill file deleted on every path; a computer's:
// process.write to the process's stdin), turned there into an Authorization header, scoped to GitHub's site, in the
// environment of the git calls that reach GitHub alone (GIT_PRELUDE `net`: the fetches, ls-remote). It is never in argv,
// the environment the exec starts with, any other git call's, .git/config, the remote's URL, the run's folder, an env
// the agent's commands get, or the log (it joins the run's redactor). No App, or one not installed on the repository:
// the fetch is anonymous, which a public repository answers. The token is revoked once the fetch is done (GitHub's
// DELETE /installation/token), and is never kept.
//
// Git there reads no system or global config (no filter, textconv or fsmonitor a machine's config could attach), copies
// no template at its init (an image's template hooks and config), runs no hook (core.hooksPath=/dev/null), fetches no
// tags and no submodules. Its fetches run in a repository it makes in this machine's own /tmp, never in the run's
// folder, so the one repository config they read is the one this exec wrote, and they verify TLS and go through no
// proxy; the repository moves into the run's folder once the header is gone (GIT_PRELUDE). sh, git and the rest are
// found in /usr/bin and /bin first (checkoutEnv).
//
// What the run is told: one line in its system prompt, the checkout's facts, or why there is none and that the GitHub
// tools can read the change instead. The checkout is removed when the claim lets go (spec-holds.ts), and made again by
// the next claim of the same run where that claim may make one: on a region with no exec, a claim that takes back a
// kept sandbox gets none, and a repo/ an earlier claim's removal left there is named as not its checkout.
import { randomUUID } from "node:crypto";
import { noExecWords } from "../archil-settings.js";
import { GITHUB_WEB, type GithubPull, githubPullOf, githubTargetOf } from "../github.js";
import { isObject } from "../validate.js";
import { COMMAND_MAX_MS } from "../workspace/archil-exec.js";
import { shellEnv } from "../workspace/hands.js";
import type { Workspace } from "../workspace/workspace.js";
import { githubAppAccess } from "./github-app.js";
import type { GithubAppMint } from "./mcp-github.js";
import type { AdapterSpecDeps } from "./adapter-run-spec.js";

/** What an agent's revision keeps of its definition's `checkout` (validate.ts CHECKOUTS; `none` keeps nothing):
 *  `pull_request`, the pull request the run's GitHub event names; `repository`, the head of the default branch of the
 *  repository the run names (repoCheckout below). */
export type Checkout = "pull_request" | "repository";

/** The folder, in the run's own, the checkout lands in. */
export const CHECKOUT_DIR = "repo";
/** How long the whole checkout may take: inside Archil's exec bound, on either mode. */
export const CHECKOUT_MS = COMMAND_MAX_MS;
/** The commits each side is first fetched with, then deepened by (doubling) until the merge base is in: about 3,200
 *  commits back at most, past which the run is told there is no merge base and the base's diff is the two-dot one. A merge
 *  base found is taken only when no shallow edge lies outside its ancestry: a history cut short can show an older common
 *  commit (a long branch that merged an old side branch) while the path to the true merge base is cut off, so the fetch
 *  deepens until every edge is at or behind the merge base it found. Each fetch runs with git's auto maintenance off: a
 *  fetch otherwise starts a detached gc that writes into .git/objects while the checkout's removal deletes it. */
const DEPTH = 50;
const DEEPENS = 6;

/** The file in the checkout's .git naming the claim that made it: a removal takes only its own claim's checkout. */
const OWNER_FILE = "agentrun-claim";

/** The private repository a checkout fetches into (GIT_PRELUDE), in its machine's own /tmp, named by the claim's checkout
 *  id: a stop kills the exec's processes at once and no trap of the script's runs, so the checkout's removal takes it
 *  too. */
const PRIVATE_DIR = "/tmp/agentrun-checkout-";

/** The checkout's removal, one exec: $1 the folder, $2 the claim's checkout id. The private repository goes whatever is
 *  there; the folder only when its owner file names this claim. */
const REMOVAL_SCRIPT = `rm -rf -- "${PRIVATE_DIR}\${2:?}" || exit 1; [ "$(cat "\${1:?}/.git/${OWNER_FILE}" 2>/dev/null)" = "$2" ] || exit 0; rm -rf -- "\${1:?}"`;

/** What both scripts run once they have read the header: git with no system or global config and no prompt, and two ways
 *  to call it. `g`, every git call, with hooks off (core.hooksPath=/dev/null, as source-sync's git runs). `net`, a call
 *  that reaches GitHub (a fetch, ls-remote): `g` with the Authorization header in that one git's environment
 *  (GIT_CONFIG_COUNT, as prefix assignments). The header itself is a variable of the script's ($auth), never exported, so
 *  no other git call and nothing else the script runs carries it; the script empties it after its last fetch. An empty
 *  one: an anonymous fetch, no header at all. Every `net` call verifies TLS and goes through no proxy
 *  (http.sslVerify=true, and an empty http.proxy, which turns the proxy variables off too).
 *
 *  Then the private repository: the run's checkout folder is removed first (a fetch that fails leaves none), and the
 *  repository is made in a folder of this machine's own /tmp ($P, PRIVATE_DIR and the claim's checkout id, made new with
 *  mode 0700, removed on every exit the script sees, and by the checkout's removal after a stop), never in the run's
 *  folder. Every call that reaches GitHub runs there, so the one config git reads beside the command line's is the one
 *  this script wrote: nothing another writer of the run's folder puts in a .git/config there (a URL's own proxy or
 *  sslVerify, which beat a generic -c, or an insteadOf) decides where the header goes. `land` moves the repository into
 *  the run's folder once the header is gone and the last fetch is done: every file of its .git (refs, objects, the
 *  shallow file), with no gitdir file or core.worktree that points back at $P. The owner file is written into the
 *  folder's .git before anything is moved: between two filesystems (/tmp and the run's mount) mv copies, then removes,
 *  and a copy cut short (a stop, the deadline, a full disk) leaves a folder the checkout's removal still knows as this
 *  claim's. */
const GIT_PRELUDE = `export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
g() { git -c core.hooksPath=/dev/null "$@"; }
net() {
  if [ -n "\${auth:-}" ]; then GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.$scope.extraheader" GIT_CONFIG_VALUE_0="$auth" git -c core.hooksPath=/dev/null -c http.sslVerify=true -c http.proxy= "$@"
  else g -c http.sslVerify=true -c http.proxy= "$@"; fi
}
here=$(pwd) || exit 10
rm -rf "\${dir:?}" || exit 10
P=${PRIVATE_DIR}$claim
mkdir -m 700 "$P" || exit 10
trap 'rm -rf "$P"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
g init -q --template= "$P" >/dev/null 2>&1 && cd "$P" && g remote add origin "$url" || exit 10
land() { cd "$here" && rm -rf "\${dir:?}" && mkdir -p "$dir/.git" && printf '%s\\n' "$claim" > "$dir/.git/${OWNER_FILE}" && mv "$P/.git"/* "$dir/.git/" && cd "$dir"; }`;

/** The checkouts' environment (each exec's, its removal's too): the run's shell's (shellEnv), its PATH with /usr/bin and
 *  /bin first, so sh, git and every program the scripts run are the system's own, never one a folder ahead of them on
 *  the run's PATH holds (/usr/local/bin, which an image or an agent with root can fill). A PATH and not absolute names:
 *  it covers every program the scripts run, not git alone, and a machine whose git is elsewhere (Homebrew's on a Mac)
 *  still finds it after them. The box's image and the vendors' Debian images have both in /usr/bin. */
function checkoutEnv(): Readonly<Record<string, string>> {
  const env = shellEnv();
  const rest = (env.PATH ?? "").split(":").filter((dir) => dir !== "" && dir !== "/usr/bin" && dir !== "/bin");
  return { ...env, PATH: ["/usr/bin", "/bin", ...rest].join(":") };
}

/** The exec's script: $1 the remote's URL (no credential), $2 the head, $3 the base (or empty), $4 the folder, $5 the
 *  URL prefix the header is for, $6 this claim's checkout id (written to .git/${OWNER_FILE}). Its stdin's first line is
 *  an Authorization header, or empty for an anonymous fetch. Its exit codes name the step that failed (10 the folder, 11 the fetch, 12 the checkout); on success it prints the merge
 *  base, empty when none was found. */
const SCRIPT = `set -u
url=$1 head=$2 base=$3 dir=$4 scope=$5 claim=$6
IFS= read -r auth || true
${GIT_PRELUDE}
fetch() { net -c maintenance.auto=false -c gc.auto=0 fetch -q --no-tags --no-recurse-submodules origin "$@" "$head" \${base:+"$base"}; }
fetch --depth=${DEPTH} || exit 11
mb=
settled() {
  [ -n "$mb" ] || return 1
  [ -s .git/shallow ] || return 0
  while IFS= read -r edge; do g merge-base --is-ancestor "$edge" "$mb" 2>/dev/null || return 1; done < .git/shallow
}
if [ -n "$base" ]; then
  n=${DEPTH} i=0
  while :; do
    mb=$(g merge-base "$base" "$head" 2>/dev/null) || mb=
    settled && break
    [ "$i" -lt ${DEEPENS} ] || { mb=; break; }
    fetch --deepen=$n || exit 11
    n=$((n * 2)) i=$((i + 1))
  done
fi
auth=
g update-ref refs/pr/head "$head" || exit 12
if [ -n "$base" ]; then g update-ref refs/pr/base "$base" || exit 12; fi
if [ -n "$mb" ]; then g update-ref refs/pr/merge-base "$mb" || exit 12; fi
land || exit 10
g -c advice.detachedHead=false checkout -q --detach "$head" || exit 12
printf '%s\\n' "$mb"
`;

/** What the checkout gives the run's claim: the line its system prompt carries, and its removal. */
export interface PrCheckout {
  /** One line for the run's system prompt: where the checkout is and what it holds, or why there is none. */
  readonly note: string;
  /** The checkout removed from the run's folder: at the claim's release. A failure throws, for the release to log. */
  end(): Promise<void>;
}

export interface PrCheckoutOptions {
  /** The run's Workspace, whose exec runs the fetch. */
  readonly workspace: Workspace;
  /** The run's first input (its launch's): its payload tag names the pull request. */
  readonly input: unknown;
  /** Whether a github trigger started the run (its launch's inputOrigin): only then is its payload tag the server's own,
   *  and read. Anyone may write the tag's text into a run of their own. */
  readonly fromGitHub?: boolean;
  /** The server's GitHub App mint, when it has an App the runner can open (a run in a workspace's refuses, in the words
   *  the run is told): none, the fetch is anonymous. */
  readonly mint?: GithubAppMint;
  /** The token revoked at GitHub once the fetch is done: best effort, a failure leaves it to its hour. */
  readonly revoke?: (token: string) => Promise<void>;
  /** Each secret the checkout holds (the token, its header), handed to the run's redactor before it is used. */
  readonly hold?: (secrets: readonly string[]) => void;
  /** GitHub's site, where the repository is fetched from: a test's own (a folder of bare repositories, or a git server
   *  on loopback). Absent, https://github.com. */
  readonly web?: string;
  /** Ends the fetch at once: the claim's signal, aborted by a person's stop too. The checkout's removal is handed to
   *  `held` before the fetch starts, so a fetch cut short leaves its folder to the claim's release. */
  readonly signal?: AbortSignal;
  /** The checkout's removal, given the moment the fetch starts (the spec's holds), so whatever ends the claim removes it. */
  readonly held?: (part: { end(): Promise<void> }) => void;
  readonly timeoutMs?: number;
}

const noCheckout = (note: string): PrCheckout => ({ note, end: async () => {} });

/** The words of a failed exec, with the secrets cut and its last lines kept. */
const tail = (text: string, secrets: readonly string[]): string => {
  let cut = text;
  for (const secret of secrets) cut = cut.split(secret).join("[redacted]");
  const lines = cut.trim().split("\n").filter(Boolean);
  return lines.slice(-3).join(" / ").slice(0, 400);
};

/** The pull request `options.input` names, checked out in the run's folder at its head. Never throws for a checkout that
 *  could not be made: the run is told why, and reads the change some other way. */
export async function prCheckout(options: PrCheckoutOptions): Promise<PrCheckout> {
  const { workspace } = options;
  const pull = githubPullOf(isObject(options.input) ? options.input.content : options.input, { payload: options.fromGitHub === true });
  if (!pull) return noCheckout("No checkout was made: this run was not started by a GitHub pull request event, so there is no repo/ folder. Read the change through the GitHub tools if you have them.");
  const web = (options.web ?? GITHUB_WEB).replace(/\/+$/, "");
  const name = `${pull.repo}#${pull.number}`;

  // The token: the App's, for this repository alone, contents read alone. None (no App, a run in a workspace, not
  // installed, GitHub said no): the fetch is anonymous, and the words say which, in case the repository is private.
  let token: string | undefined;
  let anonymous = "";
  if (options.mint) {
    try {
      const got = await options.mint({ repo: pull.repo, ...(pull.installation !== undefined ? { installation: pull.installation } : {}) }, { contents: "read" });
      if (got.ok) token = got.token;
      else anonymous = got.reason === "not_installed" ? `the GitHub App is not installed on ${pull.repo}` : got.message;
    } catch (error) {
      anonymous = `GitHub did not make a token (${(error as Error)?.message ?? error})`;
    }
  } else anonymous = "this server has no GitHub App";
  const header = token ? `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}` : "";
  const secrets = token ? [token, header, header.slice("Authorization: Basic ".length)] : [];
  if (secrets.length) options.hold?.(secrets);

  // This claim's checkout, by an id of its own: a claim that lost its lease and lets go late removes only the folder it
  // made, never the one a later claim of the run is fetching or reading (that claim's fetch replaces a stale one itself).
  const claim = randomUUID();
  const removal = async (): Promise<void> => {
    const result = await workspace.exec(["sh", "-c", REMOVAL_SCRIPT, "sh", CHECKOUT_DIR, claim], { env: checkoutEnv(), timeoutMs: CHECKOUT_MS });
    if (result.code !== 0) throw new Error(`the run's ${CHECKOUT_DIR}/ checkout could not be removed (exit ${result.code ?? result.signal}): ${tail(result.stderr, secrets)}`);
  };
  const failed = async (why: string): Promise<PrCheckout> => {
    // What a failed fetch left (a half folder) goes now: the run is told there is none.
    await removal().catch(() => {});
    return noCheckout(`The pull request ${name} could not be checked out (${why}), so there is no ${CHECKOUT_DIR}/ folder: read the change through the GitHub tools (its diff, and each file at the head sha ${pull.head}).`);
  };

  // From here a folder may exist: its removal is the claim's to run, whatever ends it.
  options.held?.({ end: removal });
  let result;
  try {
    result = await workspace.exec(
      ["sh", "-c", SCRIPT, "sh", `${web}/${pull.repo}.git`, pull.head, pull.base ?? "", CHECKOUT_DIR, `${web}/`, claim],
      { env: checkoutEnv(), stdin: Buffer.from(`${header}\n`, "utf8"), timeoutMs: options.timeoutMs ?? CHECKOUT_MS, ...(options.signal ? { signal: options.signal } : {}) },
    );
  } catch (error) {
    // Cut short (a stop, a lost claim): the claim's release removes what the fetch made (`held`).
    if (options.signal?.aborted) throw error;
    return failed(`the fetch could not run: ${tail(String((error as Error)?.message ?? error), secrets)}`);
  } finally {
    // The fetch is the token's one use: it goes now, not in an hour. A runner killed mid-fetch (kill -9, out of memory)
    // never gets here, and nothing revokes it later: the token, contents read on this one repository, lives until it
    // expires, within its hour, and the fetch's git in the computer holds it in its environment until it ends.
    if (token && options.revoke) await options.revoke(token).catch(() => {});
  }
  if (result.timedOut) return failed(`the fetch took more than ${Math.round((options.timeoutMs ?? CHECKOUT_MS) / 1000)} s`);
  if (result.code !== 0) {
    const step = result.code === 10 ? "its folder could not be made" : result.code === 11 ? `${web}/${pull.repo} did not give its commits${token ? "" : `, fetched with no token: ${anonymous}`}` : result.code === 12 ? "its head could not be checked out" : `git ended with ${result.code ?? result.signal}`;
    const said = tail(result.stderr, secrets);
    return failed(said ? `${step}: ${said}` : step);
  }
  const mergeBase = Buffer.from(result.stdout).toString("utf8").trim();
  return { note: checkoutNote(pull, /^[0-9a-f]{40}$/.test(mergeBase) ? mergeBase : undefined), end: removal };
}

/** The line a run with a checkout is told. */
function checkoutNote(pull: GithubPull, mergeBase: string | undefined): string {
  const base = pull.base === undefined
    ? "Its base was not named by the event, so only the head is there."
    : mergeBase === undefined
      ? `Its base ${pull.base} is fetched too (ref pr/base), but no merge base was found within ${DEPTH * 2 ** DEEPENS} commits: diff against pr/base.`
      : `Its base ${pull.base} (ref pr/base) and their merge base ${mergeBase} (ref pr/merge-base) are fetched too: read the change with \`git diff pr/merge-base pr/head\`.`;
  return `The pull request ${pull.repo}#${pull.number} is checked out in ${CHECKOUT_DIR}/, detached at its head ${pull.head} (ref pr/head), by the server before this run began. ${base} It is a shallow clone, and no credential is kept in it.`;
}

/** The checkout a claim's spec makes (the pi and the CLI spec alike) for its launch: the server's GitHub App opened as the
 *  MCP step opens it (github-app.ts, its payload tag read only for a github trigger's run), its secrets held by the run's redactor `redact`, its removal by the spec's holds (`held`) from the
 *  moment the fetch starts, and `signal` (the claim's, a person's stop included) ending the fetch. `kind` is the revision's
 *  checkout: the pull request the run's event names, or the repository the run names (repoCheckout). `run`: the claim's
 *  run; one in a workspace fetches with no token (github-app.ts). */
export async function prCheckoutForClaim(
  deps: Pick<AdapterSpecDeps, "store" | "sealKey" | "githubApi" | "githubWeb">,
  run: string,
  workspace: Workspace,
  launch: { readonly input: unknown; readonly repo?: string | undefined; readonly inputOrigin?: { readonly kind: string; readonly source?: string } | undefined },
  redact: { hold(values: readonly string[]): void },
  signal?: AbortSignal,
  held?: (part: { end(): Promise<void> }) => void,
  kind: Checkout = "pull_request",
): Promise<PrCheckout> {
  const fromGitHub = launch.inputOrigin?.kind === "trigger" && launch.inputOrigin.source === "github";
  const access = await githubAppAccess(deps.store, deps.sealKey, launch.input, { run, ...(deps.githubApi ? { api: deps.githubApi } : {}), fromGitHub, hold: (values) => redact.hold(values), ...(launch.repo !== undefined ? { repo: launch.repo } : {}) });
  const common = { workspace, input: launch.input, fromGitHub, ...(access ? { mint: access.mint } : {}), ...(access?.revoke ? { revoke: access.revoke } : {}), hold: (secrets: readonly string[]) => redact.hold(secrets), ...(deps.githubWeb ? { web: deps.githubWeb } : {}), ...(signal ? { signal } : {}), ...(held ? { held } : {}) };
  if (kind === "repository") return repoCheckout({ ...common, ...(launch.repo !== undefined ? { repo: launch.repo } : {}) });
  return prCheckout(common);
}

/** A claim's checkout on a Mode 2 server whose Archil region `region` has no serverless exec (archil-settings.ts
 *  noExecRegionOf), where the disk runs no command (its every exec answers "Exec is not enabled"): made as
 *  prCheckoutForClaim makes it, the same script and the token on its stdin, in the run's computer through its own exec,
 *  once it has mounted the run's folder (`mounted.workspace`: the run's Workspace attached to it, run-tools.ts
 *  RunTools.workspace where the run's shell is the computer's), and only where this claim started that computer
 *  (`mounted.fresh`: ClaimComputer.fresh; the header comment says why). The mount holds the disk's write delegation, and
 *  the fetch writes through it. With no computer that mounts the folder, or one this claim did not start, none is made
 *  and no token minted: the run is told why, and `say` puts it on its timeline (with no computer, the fix: a sandbox
 *  computer). With a computer this claim did not start, the run is also told that a repo/ there, if there is one, is
 *  not this claim's checkout (an earlier claim's, its removal failed) and may be stale. */
export async function checkoutWhereNoExec(
  deps: Parameters<typeof prCheckoutForClaim>[0],
  run: string,
  mounted: { readonly workspace: Workspace; readonly fresh: boolean } | undefined,
  region: string,
  launch: Parameters<typeof prCheckoutForClaim>[3],
  redact: { hold(values: readonly string[]): void },
  signal: AbortSignal | undefined,
  held: (part: { end(): Promise<void> }) => void,
  kind: Checkout,
  say?: (words: string) => void,
): Promise<PrCheckout> {
  if (mounted?.fresh) return prCheckoutForClaim(deps, run, mounted.workspace, launch, redact, signal, held, kind);
  const instead = kind === "pull_request" ? "Read the change through the GitHub tools if you have them." : "Read it through the GitHub tools if you have them, else say that you could not read it.";
  const where = `${noExecWords(region)}, so the server checks a repository out only in a computer that mounts the run's folder`;
  if (mounted) {
    // The computer may have run the agent's code (a kept sandbox, the agent's own, a paired one): no token goes into it.
    const why = `${where}, and the run's computer is not one this claim started (a sandbox kept through a wait, the agent's own computer or a paired one): it may already have run the agent's code, so the server hands it no GitHub token`;
    say?.(`No checkout in repo/: ${why}.`);
    // A repo/ there now can only be an earlier claim's checkout whose removal at its release failed: the run is told so
    // either way, with no look at the folder (a computer's stat has no deadline of its own).
    return noCheckout(`No checkout was made: ${why}. A ${CHECKOUT_DIR}/ folder in the run's folder, if there is one, is not this claim's checkout: an earlier claim's, whose removal failed, so it may be stale. ${instead}`);
  }
  say?.(`No checkout in repo/: ${where}, and this run has none. Give the agent a sandbox computer (a box) to get its checkout.`);
  return noCheckout(`No checkout was made, so there is no ${CHECKOUT_DIR}/ folder: ${where}, and this run has none. ${instead}`);
}

/** The file in the checkout's .git that lists its files, one path a line (git ls-tree), so an agent with `read` and no
 *  shell can still find what to open. */
export const FILE_LIST = "agentrun-files";

/** The exec's script for a repository's checkout: $1 the remote's URL (no credential), $2 the folder, $3 the URL prefix
 *  the header is for, $4 this claim's checkout id. Its stdin's first line is an Authorization header, or empty. It fetches
 *  the remote's HEAD (its default branch) one commit deep, and checks it out detached (ref repo/head). Its exit codes name
 *  the step that failed (10 the folder, 11 the fetch, 12 the checkout); on success it lists the files in
 *  .git/${FILE_LIST} and prints the commit, how many files there are and the default branch's name (empty when the
 *  remote did not say). */
const REPO_SCRIPT = `set -u
url=$1 dir=$2 scope=$3 claim=$4
IFS= read -r auth || true
${GIT_PRELUDE}
branch=$(net ls-remote --symref origin HEAD 2>/dev/null | awk '$1 == "ref:" { sub("^refs/heads/", "", $2); print $2; exit }')
net -c maintenance.auto=false -c gc.auto=0 fetch -q --no-tags --no-recurse-submodules --depth=1 origin HEAD || exit 11
auth=
g update-ref refs/repo/head FETCH_HEAD || exit 12
land || exit 10
g -c advice.detachedHead=false checkout -q --detach refs/repo/head || exit 12
g ls-tree -r --name-only HEAD > .git/${FILE_LIST} || exit 12
printf '%s %s %s\\n' "$(g rev-parse HEAD)" "$(wc -l < .git/${FILE_LIST} | tr -d ' ')" "$branch"
`;

/** What a repository's checkout reads of the run, beside a pull request's options: `repo`, the launch's (the start body's,
 *  checked against the agent's binding), else the first https://github.com/<owner>/<repo> the run's first message names
 *  (github.ts githubTargetOf: its owner's words, or a github trigger's payload tag). */
export type RepoCheckoutOptions = PrCheckoutOptions & { readonly repo?: string };

/** The repository the run names, checked out in the run's folder at the head of its default branch, one commit deep: the
 *  server's own fetch, with the App's token for that one repository and `contents: read` alone (or none: anonymous, which
 *  a public repository answers), revoked once the fetch is done, never kept. Never throws for a checkout that could not be
 *  made: the run is told why. */
export async function repoCheckout(options: RepoCheckoutOptions): Promise<PrCheckout> {
  const { workspace } = options;
  const named = options.repo !== undefined ? { repo: options.repo } : githubTargetOf(isObject(options.input) ? options.input.content : options.input, { payload: options.fromGitHub === true });
  const [owner, name, extra] = (named?.repo ?? "").split("/");
  if (!named || !owner || !name || extra !== undefined || !REPO_OWNER.test(owner) || !REPO_NAME_PART.test(name) || name === "." || name === "..") return noCheckout("No checkout was made: this run names no GitHub repository (https://github.com/<owner>/<repo> in its first message), so there is no repo/ folder.");
  const repo = `${owner}/${name}`;
  const web = (options.web ?? GITHUB_WEB).replace(/\/+$/, "");

  let token: string | undefined;
  let anonymous = "";
  if (options.mint) {
    try {
      const got = await options.mint({ repo, ...("installation" in named && named.installation !== undefined ? { installation: named.installation } : {}) }, { contents: "read" });
      if (got.ok) token = got.token;
      else anonymous = got.reason === "not_installed" ? `the GitHub App is not installed on ${repo}` : got.message;
    } catch (error) {
      anonymous = `GitHub did not make a token (${(error as Error)?.message ?? error})`;
    }
  } else anonymous = "this server has no GitHub App";
  const header = token ? `Authorization: Basic ${Buffer.from(`x-access-token:${token}`, "utf8").toString("base64")}` : "";
  const secrets = token ? [token, header, header.slice("Authorization: Basic ".length)] : [];
  if (secrets.length) options.hold?.(secrets);

  const claim = randomUUID();
  const removal = async (): Promise<void> => {
    const result = await workspace.exec(["sh", "-c", REMOVAL_SCRIPT, "sh", CHECKOUT_DIR, claim], { env: checkoutEnv(), timeoutMs: CHECKOUT_MS });
    if (result.code !== 0) throw new Error(`the run's ${CHECKOUT_DIR}/ checkout could not be removed (exit ${result.code ?? result.signal}): ${tail(result.stderr, secrets)}`);
  };
  const failed = async (why: string): Promise<PrCheckout> => {
    await removal().catch(() => {});
    return noCheckout(`The repository ${repo} could not be checked out (${why}), so there is no ${CHECKOUT_DIR}/ folder: read it through the GitHub tools if you have them, else say that you could not read it.`);
  };

  options.held?.({ end: removal });
  let result;
  try {
    result = await workspace.exec(
      ["sh", "-c", REPO_SCRIPT, "sh", `${web}/${repo}.git`, CHECKOUT_DIR, `${web}/`, claim],
      { env: checkoutEnv(), stdin: Buffer.from(`${header}\n`, "utf8"), timeoutMs: options.timeoutMs ?? CHECKOUT_MS, ...(options.signal ? { signal: options.signal } : {}) },
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return failed(`the fetch could not run: ${tail(String((error as Error)?.message ?? error), secrets)}`);
  } finally {
    // Revoked now, as prCheckout's: a runner killed mid-fetch leaves it to expire within its hour.
    if (token && options.revoke) await options.revoke(token).catch(() => {});
  }
  if (result.timedOut) return failed(`the fetch took more than ${Math.round((options.timeoutMs ?? CHECKOUT_MS) / 1000)} s`);
  if (result.code !== 0) {
    const step = result.code === 10 ? "its folder could not be made" : result.code === 11 ? `${web}/${repo} did not give its default branch${token ? "" : `, fetched with no token: ${anonymous}`}` : result.code === 12 ? "its head could not be checked out" : `git ended with ${result.code ?? result.signal}`;
    const said = tail(result.stderr, secrets);
    return failed(said ? `${step}: ${said}` : step);
  }
  const [sha = "", count = "", branch = ""] = Buffer.from(result.stdout).toString("utf8").trim().split(/\s+/);
  const at = /^[0-9a-f]{40}$/.test(sha) ? sha : "its head";
  const named_ = /^[A-Za-z0-9._\/-]{1,255}$/.test(branch) ? ` ${branch}` : "";
  const files = /^\d{1,9}$/.test(count) ? `Its ${count} ${count === "1" ? "file is" : "files are"} listed in ${CHECKOUT_DIR}/.git/${FILE_LIST}, one path a line. ` : "";
  return { note: `The repository ${repo} is checked out in ${CHECKOUT_DIR}/ at the head of its default branch${named_}, commit ${at} (ref repo/head), by the server before this run began. ${files}It is a shallow clone (that one commit, no history), and no credential is kept in it.`, end: removal };
}

const REPO_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_NAME_PART = /^[A-Za-z0-9._-]{1,100}$/;
