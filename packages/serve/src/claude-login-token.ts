// Claude Code's login on this machine, as a runner hands it to a run that is a user of its own (run-child-host.ts
// staysInRunner): the runner, the server's user, reads the login's access token from AgentRun's own login folder, and
// the run's process is handed that token alone (held.ts claudeLogin), never the folder or its refresh token.
//
// The runner reads the login's file again at every ask, so a renewal written there by anyone is taken at once, and it
// renews the login itself, with the pinned CLI's own request (renewLogin; the Claude adapter's login-refresh.ts says what
// that request is and where in the CLI it was read): at an ask that finds less than LOGIN_MARGIN_MS left, and at the ask
// after Anthropic refused the token it handed (`refused`, the CLI's 401). One ask posts once at most: one renewal is in
// flight per refresh token in this process, and across processes the renewer holds the CLI's own refresh lock on the
// folder and reads the file again once it holds it, so a token another holder (the CLI, another runner) renewed is
// taken and nothing is posted. The answer is written back only to the file it came from, atomically (a temp file at mode
// 0600 in the same folder before any byte is in it, synced, then renamed over it), every other field kept as it was. A
// renewal that fails is refused in LOGIN_RUNNING_OUT's words after one more read of the file (another holder may have
// renewed meanwhile), and nothing retries it; a refresh token Anthropic refused for good (`invalid_grant`) is never
// posted again by this process. No token is in a log field, an error or an event: a failure is told by its status and
// its OAuth error code alone, never a response body or a thrown error's words. Each value read or answered joins this
// process's redaction (secrets.ts holdSecret), and each token handed joins every watcher's.
//
// A runner whose runs on the login stay in its own process (`process` isolation, or none) has its CLI read and renew the
// same folder. Each runner says on the data folder which it is (sayLoginRunner), and a run under a user of its own is
// refused while such a runner is there (loginRunnerInProcess).
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, utimes } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import type { ClaudeAgentLogin, ClaudeLoginToken } from "@parcha/agentrun-harness-claude";
import { loginRefresh } from "@parcha/agentrun-harness-claude/facts";
import { LOGIN_SIGNED_OUT, loginAt } from "./claude-login.js";
import { PRESENCE_STALE_MS } from "./runner/presence.js";
import { holdSecret } from "./secrets.js";
import type { Runners } from "./store/index.js";

/** The pinned CLI's credentials file in its credentials directory (CLAUDE_SECURESTORAGE_CONFIG_DIR). */
export const LOGIN_FILE = ".credentials.json";
/** The least a token handed to a run has left: the pinned CLI's own margin before it calls a token expired (its
 *  `n+300000>=e`), and when the runner renews it. */
export const LOGIN_MARGIN_MS = 5 * 60_000;
/** The longest one renewal request may take: the runner gives it up then (chatgpt-plan.ts's own). */
export const REFRESH_CALL_MS = 15_000;
/** How long an ask waits while another holder (the CLI, another runner) holds the login's refresh lock: the CLI's own
 *  request timeout (30 s) and its write back. Then it refuses, having posted nothing. */
export const LOCK_WAIT_MS = 35_000;
/** How often a waiting ask reads the file and tries the lock again. */
const LOCK_POLL_MS = 200;

/** The words a run gets when the login's token has less than the margin left, or was refused, and the runner could not
 *  renew it. */
export const LOGIN_RUNNING_OUT = "Claude Code's login on this machine runs out in less than 5 minutes, and the runner could not renew it: open Claude Code on this login once to renew it, or sign in again under Settings → Model keys, then start the run again.";
/** The words a run gets when the login is kept in a form this runner does not read (not the pinned CLI's plaintext file). */
export const LOGIN_SEALED = "Claude Code's login on this machine is kept in a form this runner cannot hand to a run of its own user: set AGENTRUN_RUN_USER=same, or give the run a model_key.";

/** What a renewal hands back: the token it got and its end, for the one ask whose re-read still finds the old token (a
 *  write back that did not land); the file's own read wins otherwise. */
export type Renewed = { readonly access: string; readonly expiresAt: number };
/** Renews `login` in its own file, the one whose access token was read as `seen`, unless the file holds another by then
 *  (another holder renewed it: nothing to do). Throws when it could not. */
export type Renew = (login: ClaudeAgentLogin, seen: string) => Promise<Renewed | undefined>;

export interface LoginTokensOptions {
  /** The login's directories (claude-login.ts loginAt): its file is LOGIN_FILE in `dir`. */
  readonly login: ClaudeAgentLogin;
  readonly now?: () => number;
  /** The renewal. Default: the pinned CLI's own (renewLogin), with `fetch`, `now` and `log` below. */
  readonly renew?: Renew;
  /** What the default renewal posts with (a test's fake endpoint). Default: the global fetch, as it is at the post. */
  readonly fetch?: typeof fetch;
  /** Told each renewal's outcome, in fields that hold no token. */
  readonly log?: (fields: Record<string, string>) => void;
}

/** The login's file as read now: its access token and its end, or the words it is refused in. */
type Read = { readonly access: string; readonly expiresAt: number } | { readonly refused: string };

const strings = (values: unknown[]): string[] => values.filter((value): value is string => typeof value === "string");

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
  holdSecret(...strings([accessToken, refreshToken]));
  if (accessToken === "") return { refused: LOGIN_SIGNED_OUT };
  if (typeof accessToken !== "string" || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return { refused: LOGIN_SEALED };
  return { access: accessToken, expiresAt };
}

/** The runner's reader of one login's access token, and its renewer. */
export class LoginTokens {
  readonly #file: string;
  readonly #login: ClaudeAgentLogin;
  readonly #now: () => number;
  readonly #renew: Renew;
  readonly #watchers = new Set<(tokens: string[]) => void>();
  /** An access token Anthropic refused (refused): the next ask renews rather than hand it again. */
  #refusedAccess: string | undefined;

  constructor(options: LoginTokensOptions) {
    this.#login = options.login;
    this.#file = join(options.login.dir, LOGIN_FILE);
    this.#now = options.now ?? Date.now;
    this.#renew = options.renew ?? renewLogin({ ...(options.fetch ? { fetch: options.fetch } : {}), now: this.#now, ...(options.log ? { log: options.log } : {}) });
  }

  /** Tells `listener` each token as it is handed, for a redactor. */
  watch(listener: (tokens: string[]) => void): void {
    this.#watchers.add(listener);
  }

  /** The login's access token, read from its file now, with at least LOGIN_MARGIN_MS left: renewed first (once) when
   *  it has less, or when Anthropic refused it (refused). Else it throws in words (signed out, a form not read here, or
   *  near its end and not renewed), never with a value of the file in them. */
  async token(): Promise<string> {
    let read = await this.#read();
    if (!("refused" in read) && (read.access === this.#refusedAccess || read.expiresAt - this.#now() < LOGIN_MARGIN_MS)) {
      const seen = read.access;
      let renewed: Renewed | undefined;
      try {
        renewed = await this.#renew(this.#login, seen);
      } catch {
        // Refused below in LOGIN_RUNNING_OUT's words: a renewal's own never reach a run.
      }
      // The one read after it: the renewal's write, or another holder's that renewed meanwhile (a failed post included).
      read = await this.#read();
      if (renewed && !("refused" in read) && read.access === seen) read = renewed;
    }
    if ("refused" in read) throw new Error(read.refused);
    if (read.access === this.#refusedAccess || read.expiresAt - this.#now() < LOGIN_MARGIN_MS) throw new Error(LOGIN_RUNNING_OUT);
    for (const listener of this.#watchers) listener([read.access]);
    return read.access;
  }

  /** Anthropic refused `sent` (the run's CLI's 401): the next ask renews it, unless the file holds another token by
   *  then (another holder renewed it, and that one is handed). */
  async refused(sent: string): Promise<void> {
    const read = await this.#read();
    if (!("refused" in read) && read.access === sent) this.#refusedAccess = sent;
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

export interface RenewLoginOptions {
  /** What it posts with. Default: the global fetch, as it is at the post. */
  readonly fetch?: typeof fetch;
  /** The clock a renewed token's end is counted on (the reader's). A lock's age is the wall clock's, as the CLI's. */
  readonly now?: () => number;
  readonly log?: (fields: Record<string, string>) => void;
  /** Default REFRESH_CALL_MS. */
  readonly callMs?: number;
  /** Default LOCK_WAIT_MS. */
  readonly lockWaitMs?: number;
}

/** Refresh tokens Anthropic refused for good in this process (`invalid_grant`): never posted again. */
const dead = new Set<string>();
/** The renewals in flight in this process, by the refresh token they spend: two asks on one login share one. */
const flights = new Map<string, Promise<Renewed | undefined>>();

/** The login's credentials file as it is now, in the pinned CLI's shape: its parsed object and its `claudeAiOauth`,
 *  every token in it held for redaction; none when it is not there or not that shape. */
async function credentialsNow(file: string): Promise<{ json: Record<string, unknown>; oauth: Record<string, unknown> } | undefined> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return undefined;
  const oauth = (json as { claudeAiOauth?: unknown }).claudeAiOauth;
  if (oauth === null || typeof oauth !== "object" || Array.isArray(oauth)) return undefined;
  const fields = oauth as Record<string, unknown>;
  holdSecret(...strings([fields.accessToken, fields.refreshToken]));
  return { json: json as Record<string, unknown>, oauth: fields };
}

/** The pinned CLI's renewal of a login (the adapter's login-refresh.ts), as the runner does it in the CLI's place. */
export function renewLogin(options: RenewLoginOptions = {}): Renew {
  return async (login, seen) => {
    const file = join(login.dir, LOGIN_FILE);
    const read = await credentialsNow(file);
    // Another holder renewed it since it was read, or it changed: the caller reads it again.
    if (read?.oauth.accessToken !== seen) return undefined;
    const refresh = read.oauth.refreshToken;
    if (typeof refresh !== "string" || refresh === "") throw new Error("the login holds no refresh token");
    if (dead.has(refresh)) throw new Error("the login's refresh token was refused for good");
    let flight = flights.get(refresh);
    if (!flight) {
      flight = renewUnderLock(login.dir, file, seen, refresh, options).finally(() => flights.delete(refresh));
      flights.set(refresh, flight);
    }
    return flight;
  };
}

/** A lock in proper-lockfile's form, as the pinned CLI takes it (login-refresh.ts): a directory made with mkdir, its
 *  mtime touched while it is held; one older than lockStaleMs is a dead holder's and is taken over. Its release when
 *  taken; none while another holds it. */
async function lockDirectory(path: string): Promise<(() => Promise<void>) | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let touched: number;
      try {
        touched = (await stat(path)).mtimeMs;
      } catch {
        // Released since: try again.
        continue;
      }
      if (Date.now() - touched <= loginRefresh.lockStaleMs) return undefined;
      await rm(path, { recursive: true, force: true });
      continue;
    }
    const timer = setInterval(() => {
      const at = new Date();
      void utimes(path, at, at).catch(() => undefined);
    }, loginRefresh.lockUpdateMs);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await rm(path, { recursive: true, force: true });
    };
  }
  return undefined;
}

/** The CLI's two refresh locks on credentials directory `dir`, in its order (the lock in the folder, then the older one
 *  beside the folder's real path; that one taken where it can be, as the CLI does): their release, or none while
 *  another holder has either. */
async function takeRefreshLocks(dir: string): Promise<(() => Promise<void>) | undefined> {
  const current = await lockDirectory(join(dir, loginRefresh.lockName));
  if (!current) return undefined;
  // null: the older lock could not be made, and the CLI goes on without it then (only another holder of it stops it).
  let legacy: (() => Promise<void>) | undefined | null;
  try {
    legacy = await lockDirectory(`${await realpath(dir).catch(() => dir)}${loginRefresh.legacyLockSuffix}`);
  } catch {
    legacy = null;
  }
  if (legacy === undefined) {
    await current();
    return undefined;
  }
  return async () => {
    await legacy?.().catch(() => undefined);
    await current();
  };
}

/** One renewal of the login in file `file` whose access token was `seen` and refresh token `refresh`: under the CLI's
 *  refresh locks, the file read again, one post, and the answer written back. */
async function renewUnderLock(dir: string, file: string, seen: string, refresh: string, options: RenewLoginOptions): Promise<Renewed | undefined> {
  const say = options.log ?? (() => undefined);
  const giveUp = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS);
  let release: (() => Promise<void>) | undefined;
  for (;;) {
    release = await takeRefreshLocks(dir);
    if (release) break;
    // Another holder renews it now: its write is taken when it lands, never a second post of the same refresh token.
    if ((await credentialsNow(file))?.oauth.accessToken !== seen) return undefined;
    if (Date.now() > giveUp) {
      say({ claude_login: "renew_failed", reason: "locked" });
      throw new Error("another holder kept the login's refresh lock");
    }
    await sleep(LOCK_POLL_MS);
  }
  try {
    // Read again under the lock: a holder that renewed before it was taken has written its pair, which is taken.
    const held = await credentialsNow(file);
    if (!held || held.oauth.accessToken !== seen || held.oauth.refreshToken !== refresh) return undefined;
    const answer = await postRefresh(held.oauth, refresh, options);
    return await writeBack(file, refresh, answer, options);
  } finally {
    await release().catch(() => undefined);
  }
}

type Answer = { access: string; refresh: string | undefined; expiresIn: number; refreshExpiresIn: number | undefined; scope: string | undefined };

/** The pinned CLI's refresh request for the login whose fields are `oauth` (login-refresh.ts), posted once. Every token
 *  in its answer is held for redaction before anything else reads it. A failure throws words with no value of the
 *  request or the answer in them, and is told to the log by its status and OAuth error code alone. */
async function postRefresh(oauth: Record<string, unknown>, refresh: string, options: RenewLoginOptions): Promise<Answer> {
  const say = options.log ?? (() => undefined);
  const scopes = Array.isArray(oauth.scopes) && oauth.scopes.length > 0 && oauth.scopes.every((scope) => typeof scope === "string") ? (oauth.scopes as string[]) : loginRefresh.scopes;
  const body = {
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: typeof oauth.clientId === "string" && oauth.clientId !== "" ? oauth.clientId : loginRefresh.clientId,
    scope: scopes.join(" "),
  };
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(loginRefresh.tokenUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(options.callMs ?? REFRESH_CALL_MS) });
  } catch (error) {
    say({ claude_login: "renew_failed", reason: (error as Error)?.name === "TimeoutError" ? "timeout" : "network" });
    throw new Error("the login's renewal request got no answer");
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  const answer = (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  holdSecret(...strings([answer.access_token, answer.refresh_token]));
  if (response.status !== 200) {
    const code = typeof answer.error === "string" && /^[a-z_]{1,40}$/.test(answer.error) ? answer.error : undefined;
    // The CLI's own: a refresh token refused as invalid_grant is dead, and never sent again.
    if (code === "invalid_grant") dead.add(refresh);
    say({ claude_login: "renew_refused", status: String(response.status), ...(code ? { error: code } : {}) });
    throw new Error(`the login's renewal was answered ${response.status}${code ? ` (${code})` : ""}`);
  }
  const { access_token: access, refresh_token: next, expires_in: expiresIn, refresh_token_expires_in: refreshExpiresIn, scope } = answer;
  if (typeof access !== "string" || access === "" || typeof expiresIn !== "number" || !(expiresIn > 0)) {
    say({ claude_login: "renew_failed", reason: "answer" });
    throw new Error("the login's renewal answer held no token");
  }
  return {
    access,
    refresh: typeof next === "string" && next !== "" ? next : undefined,
    expiresIn,
    refreshExpiresIn: typeof refreshExpiresIn === "number" && Number.isFinite(refreshExpiresIn) ? refreshExpiresIn : undefined,
    scope: typeof scope === "string" ? scope : undefined,
  };
}

/** The renewal's answer written into `file`, the one it came from, as the pinned CLI writes it back (login-refresh.ts):
 *  only while the file still holds the refresh token posted (or one the CLI cleared), and only the fields the answer
 *  gives, the rest kept as they are. The token it got, whether the write landed or not. */
async function writeBack(file: string, posted: string, answer: Answer, options: RenewLoginOptions): Promise<Renewed> {
  const say = options.log ?? (() => undefined);
  const now = (options.now ?? Date.now)();
  const renewed: Renewed = { access: answer.access, expiresAt: now + answer.expiresIn * 1000 };
  const current = await credentialsNow(file);
  if (!current || (current.oauth.refreshToken !== posted && current.oauth.refreshToken !== "")) {
    // Written meanwhile by a holder that took no lock: its write wins, as the CLI's check lets it.
    say({ claude_login: "renewed", saved: "no" });
    return renewed;
  }
  const oauth = {
    ...current.oauth,
    accessToken: answer.access,
    refreshToken: answer.refresh ?? posted,
    expiresAt: renewed.expiresAt,
    ...(answer.refreshExpiresIn === undefined ? {} : { refreshTokenExpiresAt: now + answer.refreshExpiresIn * 1000 }),
    ...(answer.scope === undefined ? {} : { scopes: answer.scope.split(" ").filter(Boolean) }),
  };
  try {
    await replaceFile(file, JSON.stringify({ ...current.json, claudeAiOauth: oauth }));
  } catch {
    say({ claude_login: "renewed", saved: "no" });
    return renewed;
  }
  say({ claude_login: "renewed" });
  return renewed;
}

/** `file` replaced by `text` atomically: a new file beside it, at mode 0600 before any byte is written to it, synced,
 *  then renamed over it, and its folder synced. A `file` that is no plain file (a link, say) is never written. */
async function replaceFile(file: string, text: string): Promise<void> {
  if (!(await lstat(file)).isFile()) throw new Error("the login's file is not a plain file");
  const dir = dirname(file);
  const temp = join(dir, `${LOGIN_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  // O_CREAT | O_EXCL: a new file of this process's alone, never one that was there.
  const handle = await open(temp, "wx", 0o600);
  try {
    // Exactly 0600 (a umask only narrows the mode open was given), before a byte of a token is in it.
    await handle.chmod(0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  const folder = await open(dir, "r");
  try {
    await folder.sync();
  } catch {
    // A folder some filesystems cannot sync still holds the rename.
  } finally {
    await folder.close();
  }
}

/** Whether `login` is AgentRun's own login folder in `data` (claude-login.ts loginAt "agentrun"), the one login a run
 *  under a user of its own is handed a token of; this machine's own Claude Code login is not. */
export const agentRunLogin = (login: ClaudeAgentLogin, data: string): boolean => login.dir === loginAt("agentrun", data).dir;

/** One reader per login folder in this process, so every claim on it holds the same watchers' tokens and the same
 *  refused token; each renews with the pinned CLI's own request (renewLogin). */
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
 *  and this process's own (secrets.ts holdSecret) before the run's CLI is handed it, and a token Anthropic refused told
 *  to the runner, which renews it at the next ask. No reader: refused in words, never a silent switch to a model key. */
export function heldTokenLogin(reader: { token(): Promise<string>; refused?(sent: string): Promise<void> } | undefined, hold: (values: string[]) => void): ClaudeLoginToken {
  if (!reader) throw new Error(LOGIN_NOT_HANDED);
  return {
    token: async () => {
      const token = await reader.token();
      holdSecret(token);
      hold([token]);
      return token;
    },
    refused: async (sent: string) => {
      await reader.refused?.(sent);
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
