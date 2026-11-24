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
// taken and nothing is posted. It holds that lock as the CLI's lock library does, by the mtime it set: a lock another
// holder took over (this one paused past the stale time) is never touched, removed or posted under. The answer is written back only to the file it came from, atomically (a temp file at mode
// 0600 in the same folder before any byte is in it, synced, then renamed over it), every other field kept as it was. A
// pair whose write fails is held in this process's memory until it is saved: every ask hands its token and tries the
// write again, under the same refresh lock with the file read again under it, so it never lands over a newer pair, and
// one whose token nears its own end still unsaved is refused in LOGIN_NOT_SAVED's words. A refresh
// token Anthropic took (a 200 that rotated it) or refused for good (`invalid_grant`) is never posted again by this
// process. A renewal that fails is refused after one more read of the file (another holder may have renewed meanwhile),
// in LOGIN_REFUSED_NOT_RENEWED's words when Anthropic refused the token, else LOGIN_RUNNING_OUT's, and nothing retries
// it. No token is in a log field, an error or an event: a failure is told by its status and
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

/** The words a run gets when the login's token has less than the margin left and the runner could not renew it. */
export const LOGIN_RUNNING_OUT = "Claude Code's login on this machine runs out in less than 5 minutes, and the runner could not renew it: open Claude Code on this login once to renew it, or sign in again under Settings → Model keys, then start the run again.";
/** The words a run gets when Anthropic refused the login's token (the run's CLI's 401), whatever time it had left, and
 *  the runner could not renew it. */
export const LOGIN_REFUSED_NOT_RENEWED = "Claude refused this login and it could not be renewed; open Claude Code once to sign in again.";
/** The words a run gets when the runner renewed the login but could not write the renewal to the login's file, and the
 *  renewed token it holds in memory has less than the margin left: Anthropic took the file's refresh token, so only that
 *  held pair can be renewed, and the runner renews only from the file. */
export const LOGIN_NOT_SAVED = "Claude Code's login on this machine was renewed, but the runner could not save the renewal to the login's file, and the renewed token runs out in less than 5 minutes: make room on the disk (or fix the login folder's permissions) and start the run again; if the runner restarted meanwhile, sign in again under Settings → Model keys.";
/** A renewal that holds a pair it could not save, whose token nears its end (LOGIN_NOT_SAVED). */
class LoginNotSaved extends Error {
  constructor() {
    super(LOGIN_NOT_SAVED);
  }
}
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
    // A pair a renewal could not save yet (heldPairs) is the renewal's to hand, and to save, at every ask.
    if (!("refused" in read) && (read.access === this.#refusedAccess || read.expiresAt - this.#now() < LOGIN_MARGIN_MS || heldPairs.has(this.#file))) {
      const seen = read.access;
      let renewed: Renewed | undefined;
      let notSaved = false;
      try {
        renewed = await this.#renew(this.#login, seen);
      } catch (error) {
        // Refused below in LOGIN_NOT_SAVED's, LOGIN_REFUSED_NOT_RENEWED's or LOGIN_RUNNING_OUT's words: a renewal's
        // own never reach a run.
        notSaved = error instanceof LoginNotSaved;
      }
      // The one read after it: the renewal's write, or another holder's that renewed meanwhile (a failed post included).
      read = await this.#read();
      if (!("refused" in read) && read.access === seen) {
        if (notSaved) throw new Error(LOGIN_NOT_SAVED);
        if (renewed) read = renewed;
      }
    }
    if ("refused" in read) throw new Error(read.refused);
    // A token Anthropic refused is said so, whatever time it had left: "runs out in less than 5 minutes" would not be true.
    if (read.access === this.#refusedAccess) throw new Error(LOGIN_REFUSED_NOT_RENEWED);
    if (read.expiresAt - this.#now() < LOGIN_MARGIN_MS) throw new Error(LOGIN_RUNNING_OUT);
    for (const listener of this.#watchers) listener([read.access]);
    return read.access;
  }

  /** Anthropic refused `sent` (the run's CLI's 401): the next ask renews it, unless the file holds another token by
   *  then (another holder renewed it, and that one is handed). */
  async refused(sent: string): Promise<void> {
    const read = await this.#read();
    // The token of a pair held unsaved is the one handed while the file still holds the old one.
    if (!("refused" in read) && (read.access === sent || heldPairs.get(this.#file)?.renewed.access === sent)) this.#refusedAccess = sent;
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
  /** The refresh locks' file operations. Default: fs/promises' own. */
  readonly lockFs?: LockFs;
  /** How often a held lock is read and touched (its heartbeat). Default: the pinned CLI's (`update:5000`). */
  readonly lockUpdateMs?: number;
}

/** Refresh tokens this process never posts again: one Anthropic refused for good (`invalid_grant`), and one it took (a
 *  200 that answered another refresh token: the one posted is spent). */
const dead = new Set<string>();
/** The renewals in flight in this process, by the refresh token they spend: two asks on one login share one. */
const flights = new Map<string, Promise<Renewed | undefined>>();

/** A renewal's answer not yet written to its login's file: the refresh token it spent (`posted`), the fields it writes
 *  into the file's `claudeAiOauth`, and the token it hands. */
type HeldPair = { readonly posted: string; readonly fields: Record<string, unknown>; readonly renewed: Renewed };
/** The pairs this process renewed and could not save yet, by the file they belong in: every ask on that login hands the
 *  held token and tries the write again (saveHeld), until it lands, another holder writes the file, or the process ends. */
const heldPairs = new Map<string, HeldPair>();

/** `held` written into `file` as the pinned CLI writes a renewal back (login-refresh.ts): only while the file still holds
 *  the refresh token it spent (or one the CLI cleared), the fields it gives over the file's, the rest kept as they are.
 *  "saved" once written, "held" while the write fails (kept in heldPairs), and "dropped" when the file holds another
 *  holder's pair (or no longer holds a login the runner reads): the file wins, as the CLI's own check lets it. */
async function saveHeld(file: string, held: HeldPair, options: RenewLoginOptions, owned?: () => Promise<boolean>): Promise<"saved" | "held" | "dropped"> {
  const say = options.log ?? (() => undefined);
  const forget = () => {
    if (heldPairs.get(file) === held) heldPairs.delete(file);
  };
  const current = await credentialsNow(file);
  if (!current || (current.oauth.refreshToken !== held.posted && current.oauth.refreshToken !== "")) {
    forget();
    say({ claude_login: "renewed", saved: "no", reason: "newer" });
    return "dropped";
  }
  // `owned`: the refresh lock this save holds, asked after the read and before the write. One lost since (taken over)
  // means another holder may write now: the pair stays held, and a later ask tries again.
  if (owned && !(await owned())) {
    heldPairs.set(file, held);
    say({ claude_login: "renewed", saved: "no", reason: "lock_lost" });
    return "held";
  }
  try {
    await replaceFile(file, JSON.stringify({ ...current.json, claudeAiOauth: { ...current.oauth, ...held.fields } }));
  } catch {
    heldPairs.set(file, held);
    say({ claude_login: "renewed", saved: "no", reason: "held" });
    return "held";
  }
  forget();
  say({ claude_login: "renewed", saved: "yes" });
  return "saved";
}

/** A held pair's save as renewLogin makes it at an ask: under the CLI's refresh locks on the login's folder, as a
 *  renewal is, so it takes its turn with every renewal of that file (the CLI's, another runner's, this process's own),
 *  and saveHeld's read and check are made while it holds them. A save that read the file before a renewal wrote a newer
 *  pair, and writes after, would put the held pair back over it, its refresh token spent. While another holder has the
 *  locks it waits, as a renewal does, then the pair stays held for a later ask; so it does when the locks cannot be
 *  made at all (a full disk refuses a mkdir too). */
async function saveHeldUnderLock(dir: string, file: string, held: HeldPair, options: RenewLoginOptions): Promise<"saved" | "held" | "dropped"> {
  const say = options.log ?? (() => undefined);
  const fs = options.lockFs ?? LOCK_FS;
  const updateMs = options.lockUpdateMs ?? loginRefresh.lockUpdateMs;
  const giveUp = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS);
  for (;;) {
    let locks: HeldLock | undefined;
    try {
      locks = await takeRefreshLocks(dir, fs, updateMs);
    } catch {
      say({ claude_login: "renewed", saved: "no", reason: "held" });
      return "held";
    }
    if (locks) {
      try {
        return await saveHeld(file, held, options, locks.owned);
      } finally {
        await locks.release().catch(() => undefined);
      }
    }
    // Another holder renews now: its write lands first, and the check under the locks then drops the held pair.
    if (Date.now() > giveUp) {
      say({ claude_login: "renewed", saved: "no", reason: "locked" });
      return "held";
    }
    await sleep(LOCK_POLL_MS);
  }
}

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
  const now = options.now ?? Date.now;
  return async (login, seen) => {
    const file = join(login.dir, LOGIN_FILE);
    // A pair renewed here and not saved yet: its token is handed and its write tried again (under the refresh locks, read
    // again there: saveHeldUnderLock), and nothing is posted, for the file's refresh token is spent. Once saved, a token
    // near its own end is renewed from the file as any other.
    const held = heldPairs.get(file);
    if (held) {
      const kept = await saveHeldUnderLock(login.dir, file, held, options);
      if (kept === "dropped") return undefined;
      if (held.renewed.expiresAt - now() >= LOGIN_MARGIN_MS) return held.renewed;
      if (kept === "held") throw new LoginNotSaved();
      seen = held.renewed.access;
    }
    const read = await credentialsNow(file);
    // Another holder renewed it since it was read, or it changed: the caller reads it again.
    if (read?.oauth.accessToken !== seen) return undefined;
    const refresh = read.oauth.refreshToken;
    if (typeof refresh !== "string" || refresh === "") throw new Error("the login holds no refresh token");
    if (dead.has(refresh)) throw new Error("the login's refresh token is spent or was refused for good");
    let flight = flights.get(refresh);
    if (!flight) {
      flight = renewUnderLock(login.dir, file, seen, refresh, options).finally(() => flights.delete(refresh));
      flights.set(refresh, flight);
    }
    return flight;
  };
}

/** The file operations a refresh lock is taken, touched and released with: fs/promises' own, or a test's that watches
 *  or pauses them (RenewLoginOptions.lockFs). */
export interface LockFs {
  mkdir(path: string): Promise<unknown>;
  stat(path: string): Promise<{ readonly mtimeMs: number }>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  rm(path: string, options: { readonly recursive: boolean; readonly force: boolean }): Promise<void>;
}
const LOCK_FS: LockFs = { mkdir: (path) => mkdir(path), stat: (path) => stat(path), utimes: (path, atime, mtime) => utimes(path, atime, mtime), rm: (path, options) => rm(path, options) };

/** Whether a lock's mtime as read (`read`) is the one its holder set (`set`): within the same second, which holds on a
 *  filesystem that keeps seconds alone and through utimes' rounding. Another holder's is a second apart at least: it
 *  takes a lock over only once it is lockStaleMs (60 s) older than its own clock, and sets its own then. */
const sameMtime = (read: number, set: number): boolean => Math.abs(read - set) < 1_000;

/** A refresh lock this process took: whether it is still its own, and its release. */
interface HeldLock {
  /** Whether the lock is still this holder's: its mtime the one this holder last set. Once not, never again: a holder
   *  paused past the stale time may have lost it to another, which took it over and set its own. */
  owned(): Promise<boolean>;
  /** Stops its heartbeat and removes it, only while it is still this holder's: never another holder's lock. */
  release(): Promise<void>;
}

/** A lock in proper-lockfile's form, as the pinned CLI takes it (login-refresh.ts): a directory made with mkdir, its
 *  mtime touched while it is held; one older than lockStaleMs is a dead holder's and is taken over. Held as
 *  proper-lockfile holds its own: the mtime this holder set is kept, and a heartbeat (every `updateMs`) that reads another
 *  (or none: the lock is gone) marks the lock lost, the CLI's "compromised" (its `n.mtime.getTime()!==u.mtime.getTime()`
 *  check before each touch), and stops: it never touches it again, and the release never removes it. None while another
 *  holds it. */
async function lockDirectory(path: string, fs: LockFs, updateMs: number): Promise<HeldLock | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      let touched: number;
      try {
        touched = (await fs.stat(path)).mtimeMs;
      } catch {
        // Released since: try again.
        continue;
      }
      if (Date.now() - touched <= loginRefresh.lockStaleMs) return undefined;
      await fs.rm(path, { recursive: true, force: true });
      continue;
    }
    // Made here: this holder's mtime is the one it sets now, and the lock is its own while the lock holds that one.
    let mine = Date.now();
    try {
      await fs.utimes(path, new Date(mine), new Date(mine));
    } catch (error) {
      await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    let lost = false;
    let timer: NodeJS.Timeout | undefined;
    /** The heartbeat's touch in flight: a release waits for it, so it never reads the mtime a touch just set as another's. */
    let beat: Promise<void> | undefined;
    const owned = async (): Promise<boolean> => {
      if (lost) return false;
      try {
        if (sameMtime((await fs.stat(path)).mtimeMs, mine)) return true;
      } catch {
        // Gone, or unreadable: not this holder's to touch or remove.
      }
      lost = true;
      clearInterval(timer);
      return false;
    };
    timer = setInterval(() => {
      if (lost || beat) return;
      beat = (async () => {
        if (!(await owned())) return;
        const at = Date.now();
        try {
          await fs.utimes(path, new Date(at), new Date(at));
          mine = at;
        } catch (error) {
          // Gone since it was read: lost. Another failure is tried again at the next beat, as proper-lockfile does.
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            lost = true;
            clearInterval(timer);
          }
        }
      })().finally(() => {
        beat = undefined;
      });
    }, updateMs);
    timer.unref();
    return {
      owned,
      release: async () => {
        clearInterval(timer);
        await beat;
        if (await owned()) await fs.rm(path, { recursive: true, force: true });
        lost = true;
      },
    };
  }
  return undefined;
}

/** The CLI's two refresh locks on credentials directory `dir`, in its order (the lock in the folder, then the older one
 *  beside the folder's real path; that one taken where it can be, as the CLI does): whether both are still this
 *  holder's, and their release; or none while another holder has either. */
async function takeRefreshLocks(dir: string, fs: LockFs, updateMs: number): Promise<HeldLock | undefined> {
  const current = await lockDirectory(join(dir, loginRefresh.lockName), fs, updateMs);
  if (!current) return undefined;
  // null: the older lock could not be made, and the CLI goes on without it then (only another holder of it stops it).
  let legacy: HeldLock | undefined | null;
  try {
    legacy = await lockDirectory(`${await realpath(dir).catch(() => dir)}${loginRefresh.legacyLockSuffix}`, fs, updateMs);
  } catch {
    legacy = null;
  }
  if (legacy === undefined) {
    await current.release();
    return undefined;
  }
  const older = legacy;
  return {
    // Both asked each time: each one's own lost mark is set by its own read.
    owned: async () => ((await current.owned()) ? older === null || (await older.owned()) : false),
    release: async () => {
      await older?.release().catch(() => undefined);
      await current.release();
    },
  };
}

/** One renewal of the login in file `file` whose access token was `seen` and refresh token `refresh`: under the CLI's
 *  refresh locks, the file read again, one post, and the answer written back. A lock lost before the post (taken over
 *  while this holder was paused) is never posted under: the holder waits for the new one's write as for any other's,
 *  the pinned CLI's own check before its post (`tengu_oauth_token_refresh_lock_compromised_pre_post`). One lost after
 *  the post keeps the answer: the refresh token posted is spent, so the pair is written back by the same check the CLI
 *  makes (the file still holds the refresh token posted, or a cleared one), without the lock, as the CLI writes it then
 *  (`tengu_oauth_refresh_compromised_cas_saved`), and held in memory if that write fails (saveHeld). */
async function renewUnderLock(dir: string, file: string, seen: string, refresh: string, options: RenewLoginOptions): Promise<Renewed | undefined> {
  const say = options.log ?? (() => undefined);
  const fs = options.lockFs ?? LOCK_FS;
  const updateMs = options.lockUpdateMs ?? loginRefresh.lockUpdateMs;
  const giveUp = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS);
  for (;;) {
    const locks = await takeRefreshLocks(dir, fs, updateMs);
    if (locks) {
      try {
        // Read again under the lock: a holder that renewed before it was taken has written its pair, which is taken.
        const held = await credentialsNow(file);
        if (!held || held.oauth.accessToken !== seen || held.oauth.refreshToken !== refresh) return undefined;
        if (await locks.owned()) {
          const answer = await postRefresh(held.oauth, refresh, options);
          if (!(await locks.owned())) say({ claude_login: "lock_lost", at: "after_post" });
          return await writeBack(file, refresh, answer, options);
        }
        say({ claude_login: "lock_lost", at: "before_post" });
      } finally {
        await locks.release().catch(() => undefined);
      }
    }
    // Another holder renews it now: its write is taken when it lands, never a second post of the same refresh token.
    if ((await credentialsNow(file))?.oauth.accessToken !== seen) return undefined;
    if (Date.now() > giveUp) {
      say({ claude_login: "renew_failed", reason: "locked" });
      throw new Error("another holder kept the login's refresh lock");
    }
    await sleep(LOCK_POLL_MS);
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
  // Anthropic took the refresh token and answered another: the one posted is spent, and never posted again, whatever
  // becomes of the answer's write. One answered with no new refresh token is the CLI's `refresh_token:K=e`: still the
  // login's, kept.
  if (typeof next === "string" && next !== "" && next !== refresh) dead.add(refresh);
  return {
    access,
    refresh: typeof next === "string" && next !== "" ? next : undefined,
    expiresIn,
    refreshExpiresIn: typeof refreshExpiresIn === "number" && Number.isFinite(refreshExpiresIn) ? refreshExpiresIn : undefined,
    scope: typeof scope === "string" ? scope : undefined,
  };
}

/** The renewal's answer written into `file`, the one it came from (saveHeld): the token it got, whether the write landed
 *  or not. One that did not land is held in this process's memory (heldPairs) and written at a later ask; one the file
 *  holds another holder's pair in place of is dropped, its token handed to this ask alone. */
async function writeBack(file: string, posted: string, answer: Answer, options: RenewLoginOptions): Promise<Renewed> {
  const now = (options.now ?? Date.now)();
  const renewed: Renewed = { access: answer.access, expiresAt: now + answer.expiresIn * 1000 };
  const fields = {
    accessToken: answer.access,
    refreshToken: answer.refresh ?? posted,
    expiresAt: renewed.expiresAt,
    ...(answer.refreshExpiresIn === undefined ? {} : { refreshTokenExpiresAt: now + answer.refreshExpiresIn * 1000 }),
    ...(answer.scope === undefined ? {} : { scopes: answer.scope.split(" ").filter(Boolean) }),
  };
  await saveHeld(file, { posted, fields, renewed }, options);
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
