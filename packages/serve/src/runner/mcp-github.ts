// A github_app MCP server's credential for one run (the runner's MCP claim step, runner/mcp-claim.ts): an installation
// token the server's GitHub App mints (github.ts mintInstallationToken, given here as `mint`, its App id and key bound by
// the runner), narrowed to the run's repository. It is minted at every launch (each claim), held in the step's memory
// only (never sealed into mcp_servers, the journal or run_live: it lasts an hour and is minted again at will), is held by
// the run's one redactor as the claim step hands it over (each mint), and is minted again with REFRESH_BEFORE_MS left, mid-run, so a long run's calls never carry an expired
// token. A token that could not be renewed answers its calls in words once it expires, never a crash. One claim per run
// mints for itself: there is no stored token to share, so no refresh lease.

/** The App's answer for one repository: a token and when it expires (ms), or why not. */
export type GithubAppMint = (target: { installation?: number; repo: string }) => Promise<
  { ok: true; token: string; expires_at: number } | { ok: false; reason: "not_installed" | "no_repo" | "github_failed"; message: string }
>;

/** What the runner gives the step for a run's github_app servers: the bound mint, and the run's repository (from its
 *  GitHub firing, or the first github.com repository URL in its input); none when the run names no repository. */
export interface GithubAppAccess {
  readonly mint: GithubAppMint;
  readonly target: { readonly installation?: number; readonly repo: string } | undefined;
}

/** A timer the step arms: the refresh before expiry, the expiry itself. */
export type GithubTimer = (fire: () => void, ms: number) => { clear(): void };

/** How long before its expiry a token is minted again: GitHub's tokens last an hour, so at 55 minutes. */
export const REFRESH_BEFORE_MS = 5 * 60_000;

/** Why a github_app server's calls are refused unsent, in the words the gateway gives the model. */
export const GITHUB_UNUSABLE = {
  noAccess: "this server has no GitHub App set up for its runs (Settings → GitHub)",
  noRepo: "this run names no GitHub repository, so the GitHub App has no repository to make a token for",
  notInstalled: (repo: string) => `the GitHub App is not installed on ${repo}: install it from Settings → GitHub`,
  failed: (message: string) => `GitHub did not make a token for this run (${message})`,
  expired: (message: string) => `its GitHub App token expired and a new one could not be made (${message})`,
};

type Entry = { headers?: Record<string, string>; unopened?: string };

const REAL_TIMER: GithubTimer = (fire, ms) => {
  const timer = setTimeout(fire, Math.min(Math.max(0, ms), 2 ** 31 - 1));
  timer.unref();
  return { clear: () => clearTimeout(timer) };
};

/** One run's github_app tokens, by server: `open` mints one (or keeps a token with more than REFRESH_BEFORE_MS left) and
 *  hands its entry to `put`, then keeps it fresh until `release`. */
export function githubTokens(access: GithubAppAccess | undefined, { now = Date.now, arm = REAL_TIMER }: { now?: () => number; arm?: GithubTimer } = {}) {
  const held = new Map<string, { token: string; expiresAt: number; timers: { clear(): void }[]; put: (entry: Entry) => void }>();
  let released = false;

  const clear = (name: string) => {
    for (const timer of held.get(name)?.timers ?? []) timer.clear();
    held.delete(name);
  };

  /** A token minted for `name` and put; its refresh and its expiry armed. On a refresh that fails, the token held keeps
   *  working until it expires, then the server's calls are refused in words. */
  const mint = async (name: string, put: (entry: Entry) => void, refreshing: boolean): Promise<void> => {
    if (!access) return put({ unopened: GITHUB_UNUSABLE.noAccess });
    if (!access.target) return put({ unopened: GITHUB_UNUSABLE.noRepo });
    let got: Awaited<ReturnType<GithubAppMint>>;
    try {
      got = await access.mint(access.target);
    } catch (error) {
      got = { ok: false, reason: "github_failed", message: String((error as Error)?.message ?? error) };
    }
    if (released) return;
    if (!got.ok) {
      const why = got.reason === "not_installed" ? GITHUB_UNUSABLE.notInstalled(access.target.repo) : got.reason === "no_repo" ? GITHUB_UNUSABLE.noRepo : GITHUB_UNUSABLE.failed(got.message);
      const kept = held.get(name);
      // A refresh that failed: the token held is used until it expires, then refused in words.
      if (refreshing && kept && kept.expiresAt > now()) {
        for (const timer of kept.timers) timer.clear();
        kept.timers = [arm(() => {
          if (released) return;
          clear(name);
          put({ unopened: GITHUB_UNUSABLE.expired(got.ok ? "" : got.message) });
        }, kept.expiresAt - now())];
        return;
      }
      clear(name);
      return put({ unopened: why });
    }
    clear(name);
    const entry = { token: got.token, expiresAt: got.expires_at, timers: [] as { clear(): void }[], put };
    held.set(name, entry);
    put({ headers: { authorization: `Bearer ${got.token}` } });
    entry.timers.push(arm(() => void (!released && mint(name, put, true)), got.expires_at - REFRESH_BEFORE_MS - now()));
  };

  return {
    /** `name`'s token: the one held while it has more than REFRESH_BEFORE_MS left (a claim's fresh() again mints
     *  nothing), else a new one. */
    async open(name: string, put: (entry: Entry) => void): Promise<void> {
      const kept = held.get(name);
      if (kept && kept.expiresAt - now() > REFRESH_BEFORE_MS) {
        kept.put = put;
        return put({ headers: { authorization: `Bearer ${kept.token}` } });
      }
      await mint(name, put, false);
    },
    /** Every token dropped and every timer stopped: the loop ended, or the claim is lost. */
    release(): void {
      released = true;
      for (const name of [...held.keys()]) clear(name);
    },
  };
}
