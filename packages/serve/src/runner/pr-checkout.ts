// A run's checkout of the pull request it was started for, made by the server before the first turn when the agent's
// definition says `checkout: pull_request` (a template's manifest sets it). The agent then starts with the repository at
// the pull request's head in `repo/` of its folder, its base and their merge base fetched beside it, and never holds a
// GitHub token: the fetch is the server's own, one exec on the run's Workspace (Mode 1 a process on this machine, Mode 2
// Archil's serverless exec over the run's folder), never a command of the agent's.
//
// What it reads of the run: its first message's payload tag alone (github.ts githubPullOf), which the server wrote from a
// signed GitHub delivery: the repository, the pull request's number, its head and its base. Nothing else names a
// repository to fetch.
//
// The credential: an installation token of the server's GitHub App, minted for that one repository with
// {contents: "read"} alone, handed to the exec on its stdin (Archil's: a spill file deleted on every path), turned there
// into an Authorization header in git's environment (GIT_CONFIG_COUNT), scoped to GitHub's site. It is never in argv,
// .git/config, the remote's URL, the run's folder, an env the agent's commands get, or the log (it joins the run's
// redactor). No App, or one not installed on the repository: the fetch is anonymous, which a public repository answers.
// The token is revoked once the fetch is done (GitHub's DELETE /installation/token), and is never kept.
//
// Git there reads no system or global config (no filter, textconv or fsmonitor a machine's config could attach), fetches
// no tags and no submodules, and checks out with the repository's own config alone, which this exec wrote.
//
// What the run is told: one line in its system prompt, the checkout's facts, or why there is none and that the GitHub
// tools can read the change instead. The checkout is removed when the claim lets go (spec-holds.ts), and made again by
// the next claim of the same run.
import { randomUUID } from "node:crypto";
import { GITHUB_WEB, type GithubPull, githubPullOf } from "../github.js";
import { isObject } from "../validate.js";
import { COMMAND_MAX_MS } from "../workspace/archil-exec.js";
import { shellEnv } from "../workspace/hands.js";
import type { Workspace } from "../workspace/workspace.js";
import { githubAppAccess } from "./github-app.js";
import type { GithubAppMint } from "./mcp-github.js";
import type { AdapterSpecDeps } from "./adapter-run-spec.js";

/** What an agent's revision keeps of its definition's `checkout` (validate.ts CHECKOUTS; `none` keeps nothing). */
export type Checkout = "pull_request";

/** The folder, in the run's own, the checkout lands in. */
export const CHECKOUT_DIR = "repo";
/** How long the whole checkout may take: inside Archil's exec bound, on either mode. */
export const CHECKOUT_MS = COMMAND_MAX_MS;
/** The commits each side is first fetched with, then deepened by (doubling) until the merge base is in: about 3,200
 *  commits back at most, past which the run is told there is no merge base and the base's diff is the two-dot one. A merge
 *  base found is taken only when no shallow edge lies outside its ancestry: a history cut short can show an older common
 *  commit (a long branch that merged an old side branch) while the path to the true merge base is cut off, so the fetch
 *  deepens until every edge is at or behind the merge base it found. */
const DEPTH = 50;
const DEEPENS = 6;

/** The file in the checkout's .git naming the claim that made it: a removal takes only its own claim's checkout. */
const OWNER_FILE = "agentrun-claim";

/** The exec's script: $1 the remote's URL (no credential), $2 the head, $3 the base (or empty), $4 the folder, $5 the
 *  URL prefix the header is for, $6 this claim's checkout id (written to .git/${OWNER_FILE}). Its stdin's first line is
 *  an Authorization header, or empty for an anonymous fetch. Its exit codes name the step that failed (10 the folder, 11 the fetch, 12 the checkout); on success it prints the merge
 *  base, empty when none was found. */
const SCRIPT = `set -u
url=$1 head=$2 base=$3 dir=$4 scope=$5 claim=$6
IFS= read -r auth || true
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
if [ -n "\${auth:-}" ]; then export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.$scope.extraheader" GIT_CONFIG_VALUE_0="$auth"; fi
auth=
rm -rf "\${dir:?}"
git init -q "$dir" >/dev/null 2>&1 && cd "$dir" && printf '%s\\n' "$claim" > .git/${OWNER_FILE} && git remote add origin "$url" || exit 10
fetch() { git fetch -q --no-tags --no-recurse-submodules origin "$@" "$head" \${base:+"$base"}; }
fetch --depth=${DEPTH} || exit 11
mb=
settled() {
  [ -n "$mb" ] || return 1
  [ -s .git/shallow ] || return 0
  while IFS= read -r edge; do git merge-base --is-ancestor "$edge" "$mb" 2>/dev/null || return 1; done < .git/shallow
}
if [ -n "$base" ]; then
  n=${DEPTH} i=0
  while :; do
    mb=$(git merge-base "$base" "$head" 2>/dev/null) || mb=
    settled && break
    [ "$i" -lt ${DEEPENS} ] || { mb=; break; }
    fetch --deepen=$n || exit 11
    n=$((n * 2)) i=$((i + 1))
  done
fi
git update-ref refs/pr/head "$head" || exit 12
if [ -n "$base" ]; then git update-ref refs/pr/base "$base" || exit 12; fi
if [ -n "$mb" ]; then git update-ref refs/pr/merge-base "$mb" || exit 12; fi
git -c advice.detachedHead=false checkout -q --detach "$head" || exit 12
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
  /** The server's GitHub App mint, when it has an App the runner can open: none, the fetch is anonymous. */
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

  // The token: the App's, for this repository alone, contents read alone. None (no App, not installed, GitHub said no):
  // the fetch is anonymous, and the words say which, in case the repository turns out to be private.
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
    const result = await workspace.exec(["sh", "-c", `[ "$(cat "\${1:?}/.git/${OWNER_FILE}" 2>/dev/null)" = "$2" ] || exit 0; rm -rf -- "\${1:?}"`, "sh", CHECKOUT_DIR, claim], { env: shellEnv(), timeoutMs: CHECKOUT_MS });
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
      { env: shellEnv(), stdin: Buffer.from(`${header}\n`, "utf8"), timeoutMs: options.timeoutMs ?? CHECKOUT_MS, ...(options.signal ? { signal: options.signal } : {}) },
    );
  } catch (error) {
    // Cut short (a stop, a lost claim): the claim's release removes what the fetch made (`held`).
    if (options.signal?.aborted) throw error;
    return failed(`the fetch could not run: ${tail(String((error as Error)?.message ?? error), secrets)}`);
  } finally {
    // The fetch is the token's one use: it goes now, not in an hour.
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
 *  moment the fetch starts, and `signal` (the claim's, a person's stop included) ending the fetch. */
export async function prCheckoutForClaim(
  deps: Pick<AdapterSpecDeps, "store" | "sealKey" | "githubApi" | "githubWeb">,
  workspace: Workspace,
  launch: { readonly input: unknown; readonly inputOrigin?: { readonly kind: string; readonly source?: string } | undefined },
  redact: { hold(values: readonly string[]): void },
  signal?: AbortSignal,
  held?: (part: { end(): Promise<void> }) => void,
): Promise<PrCheckout> {
  const fromGitHub = launch.inputOrigin?.kind === "trigger" && launch.inputOrigin.source === "github";
  const access = await githubAppAccess(deps.store, deps.sealKey, launch.input, { ...(deps.githubApi ? { api: deps.githubApi } : {}), fromGitHub, hold: (values) => redact.hold(values) });
  return prCheckout({ workspace, input: launch.input, fromGitHub, ...(access ? { mint: access.mint } : {}), ...(access?.revoke ? { revoke: access.revoke } : {}), hold: (secrets) => redact.hold(secrets), ...(deps.githubWeb ? { web: deps.githubWeb } : {}), ...(signal ? { signal } : {}), ...(held ? { held } : {}) });
}
