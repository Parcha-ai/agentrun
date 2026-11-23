// Claude Code's login on this machine, as a runner hands it to a run that is a user of its own (run-child-host.ts
// staysInRunner): the runner, the server's user, reads the login's access token from AgentRun's own login folder, and
// the run's process is handed that token alone (held.ts claudeLogin), never the folder or its refresh token.
//
// The runner never renews the login: whoever runs Claude Code on that login renews it, as the CLI always does, and the
// runner reads the login's file again at every ask, so a renewal written there is taken at once. A token with less than
// LOGIN_MARGIN_MS left is refused in words that say so. `renew` is the one place a renewal of the runner's own would go;
// none is given. Each value read joins this process's redaction (secrets.ts holdSecret) and every watcher's.
//
// A runner whose runs on the login stay in its own process (`process` isolation, or none) has its CLI read and renew the
// same folder. Each runner says on the data folder which it is (sayLoginRunner), and a run under a user of its own is
// refused while such a runner is there (loginRunnerInProcess).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeAgentLogin, ClaudeLoginToken } from "@parcha/agentrun-harness-claude";
import { LOGIN_SIGNED_OUT, loginAt } from "./claude-login.js";
import { PRESENCE_STALE_MS } from "./runner/presence.js";
import { holdSecret } from "./secrets.js";
import type { Runners } from "./store/index.js";

/** The pinned CLI's credentials file in its credentials directory (CLAUDE_SECURESTORAGE_CONFIG_DIR). */
export const LOGIN_FILE = ".credentials.json";
/** The least a token handed to a run has left: the pinned CLI's own margin before it calls a token expired. */
export const LOGIN_MARGIN_MS = 5 * 60_000;

/** The words a run gets when the login's token has less than the margin left. */
export const LOGIN_RUNNING_OUT = "Claude Code's login on this machine runs out in less than 5 minutes, and a run under a user of its own never renews it: open Claude Code on this login once to renew it, or sign in again under Settings → Model keys, then start the run again.";
/** The words a run gets when the login is kept in a form this runner does not read (not the pinned CLI's plaintext file). */
export const LOGIN_SEALED = "Claude Code's login on this machine is kept in a form this runner cannot hand to a run of its own user: set AGENTRUN_RUN_USER=same, or give the run a model_key.";

export interface LoginTokensOptions {
  /** The login's directories (claude-login.ts loginAt): its file is LOGIN_FILE in `dir`. */
  readonly login: ClaudeAgentLogin;
  readonly now?: () => number;
  /** Renews the login in its own file, in the CLI's shape, so the read after it finds a fresh token. None today: the
   *  runner refuses a token near its end instead. */
  readonly renew?: (login: ClaudeAgentLogin) => Promise<void>;
}

/** The login's file as read now: its access token and its end, or the words it is refused in. */
type Read = { readonly access: string; readonly expiresAt: number } | { readonly refused: string };

/** The access token in a credentials file's text, in the pinned CLI's shape (`claudeAiOauth.{accessToken, expiresAt}`),
 *  every value in it held for redaction. No `claudeAiOauth`, or one the CLI cleared (an empty token), is signed out;
 *  anything else is a form this runner does not read. */
function readLogin(text: string): Read {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { refused: LOGIN_SEALED };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { refused: LOGIN_SEALED };
  const oauth = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (oauth === undefined || oauth === null) return { refused: LOGIN_SIGNED_OUT };
  if (typeof oauth !== "object" || Array.isArray(oauth)) return { refused: LOGIN_SEALED };
  const { accessToken, refreshToken, expiresAt } = oauth as { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
  holdSecret(...[accessToken, refreshToken].filter((value): value is string => typeof value === "string"));
  if (accessToken === "") return { refused: LOGIN_SIGNED_OUT };
  if (typeof accessToken !== "string" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return { refused: LOGIN_SEALED };
  return { access: accessToken, expiresAt };
}

/** The runner's reader of one login's access token. */
export class LoginTokens {
  readonly #file: string;
  readonly #login: ClaudeAgentLogin;
  readonly #now: () => number;
  readonly #renew: ((login: ClaudeAgentLogin) => Promise<void>) | undefined;
  readonly #watchers = new Set<(tokens: string[]) => void>();

  constructor(options: LoginTokensOptions) {
    this.#login = options.login;
    this.#file = join(options.login.dir, LOGIN_FILE);
    this.#now = options.now ?? Date.now;
    this.#renew = options.renew;
  }

  /** Tells `listener` each token as it is handed, for a redactor. */
  watch(listener: (tokens: string[]) => void): void {
    this.#watchers.add(listener);
  }

  /** The login's access token, read from its file now, with at least LOGIN_MARGIN_MS left; else it throws in words
   *  (signed out, a form not read here, or near its end), never with a value of the file in them. */
  async token(): Promise<string> {
    let read = await this.#read();
    if (!("refused" in read) && read.expiresAt - this.#now() < LOGIN_MARGIN_MS && this.#renew) {
      await this.#renew(this.#login);
      read = await this.#read();
    }
    if ("refused" in read) throw new Error(read.refused);
    if (read.expiresAt - this.#now() < LOGIN_MARGIN_MS) throw new Error(LOGIN_RUNNING_OUT);
    for (const listener of this.#watchers) listener([read.access]);
    return read.access;
  }

  async #read(): Promise<Read> {
    let text: string;
    try {
      text = await readFile(this.#file, "utf8");
    } catch (error) {
      // No file: signed out. One the runner may not open is not the pinned CLI's file as the runner knows it.
      return { refused: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? LOGIN_SIGNED_OUT : LOGIN_SEALED };
    }
    return readLogin(text);
  }
}

/** Whether `login` is AgentRun's own login folder in `data` (claude-login.ts loginAt "agentrun"), the one login a run
 *  under a user of its own is handed a token of; this machine's own Claude Code login is not. */
export const agentRunLogin = (login: ClaudeAgentLogin, data: string): boolean => login.dir === loginAt("agentrun", data).dir;

/** One reader per login folder in this process, so every claim on it holds the same watchers' tokens. */
const readers = new Map<string, LoginTokens>();
export function loginTokensFor(login: ClaudeAgentLogin): LoginTokens {
  let reader = readers.get(login.dir);
  if (!reader) readers.set(login.dir, (reader = new LoginTokens({ login })));
  return reader;
}

/** The words a run's own process fails in when its runner hands it no reader of the login (a claim this runner does not
 *  put on AgentRun's own login folder). */
export const LOGIN_NOT_HANDED = "This run's runner handed it no Claude Code login: it runs each run as a user of its own and hands such a run only AgentRun's own login folder's token. Switch to that folder under Settings → Model keys, set AGENTRUN_RUN_USER=same, or give the run a model_key.";

/** A run's own process's login (held.ts claudeLogin's reader): each token it reads held by `hold` (the run's redactors)
 *  and this process's own (secrets.ts holdSecret) before the run's CLI is handed it. No reader: refused in words, never a
 *  silent switch to a model key. */
export function heldTokenLogin(reader: { token(): Promise<string> } | undefined, hold: (values: string[]) => void): ClaudeLoginToken {
  if (!reader) throw new Error(LOGIN_NOT_HANDED);
  return {
    token: async () => {
      const token = await reader.token();
      holdSecret(token);
      hold([token]);
      return token;
    },
  };
}

/** Where the runners on a data folder say whether their runs on the login stay in their own process: one file per
 *  runner, by name. */
export const loginRunnersDir = (data: string): string => join(data, "claude-login-runners");
const runnerFile = (data: string, runner: string): string => join(loginRunnersDir(data), runner.replace(/[^A-Za-z0-9._:-]/g, "_"));

/** Runner `runner` says, at its start, how its runs on the login run: `process` (in its own process, its CLI on the
 *  login folder), or `uid` (each a user of its own, on a token), which takes back what an earlier start of that name said. */
export function sayLoginRunner(data: string, runner: string, isolation: "uid" | "process"): void {
  const file = runnerFile(data, runner);
  if (isolation === "uid") return void rmSync(file, { force: true });
  mkdirSync(loginRunnersDir(data), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${runner}\n`, { mode: 0o600 });
}

/** The name of a runner on data folder `data` whose runs on the login stay in its own process, and whose word in the
 *  store is fresh (presence.ts); none when there is no such runner. */
export async function loginRunnerInProcess(data: string, runners: Pick<Runners, "live">): Promise<string | undefined> {
  const dir = loginRunnersDir(data);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return undefined;
  }
  const said = new Set(files.flatMap((file) => {
    try {
      const name = readFileSync(join(dir, file), "utf8").trim();
      return name ? [name] : [];
    } catch {
      // Taken back since the list was read.
      return [];
    }
  }));
  if (said.size === 0) return undefined;
  return (await runners.live(PRESENCE_STALE_MS)).find((row) => said.has(row.runner))?.runner;
}
