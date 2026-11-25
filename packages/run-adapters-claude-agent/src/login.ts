// A person's own Claude Code login on this machine, which a claude-agent session may run on in place of a model key.
// Written for AgentRun.
//
// The pinned CLI keeps the login where it always does, in its own files, and calls Anthropic with it itself. A session
// either tells the CLI where its login is (two directories, by environment), and the host asks the CLI whether it is
// signed in (`claude auth status`), reading nothing but that answer; or, where the host keeps the login out of the CLI's
// reach (a run under a user of its own), it is handed the login's access token alone (ClaudeLoginToken), by
// environment, asked of the host again at each start and when Anthropic refuses it. The CLI never gets a refresh token
// then, and never renews the login itself: the host does, if anyone (told which token was refused: `refused`).
// The status check runs the CLI on a private copy of the login's account file (`.claude.json`), which the CLI rewrites on
// start, so the file (the person's own, or AgentRun's) is only ever opened to read. The copy leaves out the fields that
// hold secrets (an API key, exported variables, MCP servers' tokens) and lasts the check.
// The check runs in the person's own home, as does a run on macOS, where the CLI's tokens are in the login keychain.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ModelPort, ModelUsage } from "@parcha/agentrun-kernel";
import { parentWatched, type ParentWatch } from "@parcha/agentrun-kernel/host";
import { loginUser } from "./login-user.js";

/** Where the pinned CLI keeps a login: its credentials file's directory (`CLAUDE_SECURESTORAGE_CONFIG_DIR`) and its
 *  Anthropic profiles (`ANTHROPIC_CONFIG_DIR`). The CLI reads and writes both; nothing else does. */
export interface ClaudeAgentLogin {
  /** The directory of the CLI's credentials file. */
  dir: string;
  /** The directory of the CLI's Anthropic profiles. */
  profiles: string;
  /** Set only for a person's own login on the CLI's default folder (`<home>/.claude`, no `CLAUDE_CONFIG_DIR`): their
   *  home. Their own CLI, run with no folder variable, keeps the account in `<home>/.claude.json` and, on macOS, its
   *  tokens in the Keychain item with no suffix; the variables below reach that same login (signInEnv, loginEnv). */
  home?: string;
  /** Set only for a person's own login whose CLI keeps its credentials apart from `dir`, because the server's env sets
   *  `CLAUDE_SECURESTORAGE_CONFIG_DIR`: the folder it names, absolute (set and empty, `<home>/.claude`, the CLI's rule). */
  secure?: string;
  /** With `secure`: the variable was set and empty, which on macOS names the Keychain item with no suffix, so it goes to
   *  the CLI empty there too. */
  unsuffixed?: boolean;
  /** The home of the person whose CLI keeps the login, read once by whoever makes the login (serve's homeOf: the
   *  server's `HOME` when its user owns it, else that user's own home), so the status check, the sign-in and a run on
   *  macOS all run in that one home (personHome). With `home`, the same folder. */
  userHome?: string;
  /** Set where `userHome` is not the home a terminal with the server's env has (serve's homeOf: that env's `HOME` was
   *  another user's, so the server's user's own home was taken): the line a person runs (loginCommand) then carries
   *  `HOME`, so it signs in where the server reads, never in that terminal's own home. */
  homeApart?: boolean;
  /** Set only for AgentRun's own login folder (serve's place `agentrun`), which no CLI of the person's uses: the one
   *  place whose Keychain item left under the account "unknown" is deleted here (dropUnknownItem). */
  own?: boolean;
}

/** A login handed to the CLI as its access token alone, by a host that holds the login itself. `token()` is asked at
 *  each start of the CLI and when Anthropic refuses the token the CLI holds: it answers the login's access token as
 *  the host reads it now, or throws in words that say what to do. The CLI gets it as CLAUDE_CODE_OAUTH_TOKEN, with no
 *  refresh token and no login directory. */
export interface ClaudeLoginToken {
  token(): Promise<string>;
  /** Told, before `token()` is asked again, that Anthropic refused `sent` (the CLI's 401): a host that renews the login
   *  renews it at that ask unless it already holds another token. */
  refused?(sent: string): Promise<void>;
}

/** Whether `login` is handed as a token (ClaudeLoginToken), not as its directories. */
export const loginByToken = (login: ClaudeAgentLogin | ClaudeLoginToken): login is ClaudeLoginToken => typeof (login as { token?: unknown }).token === "function";

/** The words a turn ends in when Anthropic refused the login's access token mid-turn and the host had no newer one. */
export const LOGIN_TOKEN_REFUSED = "Anthropic refused this machine's Claude login during the run, and no newer token was there: run the claude CLI once on this login to renew it, then start the run again.";

/** `login.secure` as the CLI's variable on `platform` (undefined when it is not set apart): empty on macOS where the
 *  person's own was set and empty. */
const secureVar = (login: ClaudeAgentLogin, platform: NodeJS.Platform): string | undefined => (login.secure === undefined ? undefined : login.unsuffixed && platform === "darwin" ? "" : login.secure);

/** The variables that point a session's CLI at `login`: never its config dir (`CLAUDE_CONFIG_DIR`), which the Agent SDK
 *  copies a credentials file out of when it resumes a session, so the credentials dir (`CLAUDE_SECURESTORAGE_CONFIG_DIR`)
 *  is always set. On macOS the CLI names its Keychain item from that dir (`-<sha256 of it>` after the name) unless it is
 *  set and empty; unset, it would hash the session's own config dir. So a login on the CLI's default folder (`home`) gets
 *  an empty one on macOS (the item with no suffix, the person's own CLI's), and its folder elsewhere, where the CLI keeps
 *  `.credentials.json` in that dir. A login whose credentials dir is set apart (`secure`) gets that one, as the person's
 *  own CLI with it does. A status check has a config dir of its own too (a copy of the account file), so it takes this
 *  rule (claudeLoginStatus). `platform`: the one the CLI runs on, this host's. */
export function loginEnv(login: ClaudeAgentLogin, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const secure = secureVar(login, platform) ?? (login.home !== undefined && platform === "darwin" ? "" : login.dir);
  return { CLAUDE_SECURESTORAGE_CONFIG_DIR: secure, ANTHROPIC_CONFIG_DIR: login.profiles };
}

/** The variables of the CLI's own sign-in at `login`. The line a person runs (loginCommand) and the sign-in this host
 *  starts (startClaudeLogin) both take these, the sign-in in the person's home (personHome), so they cannot drift apart.
 *  Neither is a session, whose config dir stays its own (loginEnv), and neither is the status check, which runs on a copy
 *  of the account file with a run's variables (claudeLoginStatus).
 *  - On the CLI's default folder (`home`): the person's own CLI as it runs, with no config or credentials dir, in their
 *    home (`HOME`; a terminal of theirs has it already, so the shown line leaves it out, and clears the two folder
 *    variables a terminal may export). It writes the account in `<home>/.claude.json` and the tokens where that person's
 *    CLI keeps them, on every platform.
 *  - Anywhere else: the login's folder as both the config dir and the credentials dir. `auth login` writes the account it
 *    signed in to its config dir's `.claude.json`, where the status check reads it (from a copy). For a folder the person's own
 *    CLI uses through `CLAUDE_CONFIG_DIR`, the credentials dir set to that folder is where that CLI keeps its tokens too
 *    (Linux: the same file; macOS: the same item, hashed from the same folder).
 *  - A credentials dir set apart (`secure`, from the server's `CLAUDE_SECURESTORAGE_CONFIG_DIR`) is the credentials dir
 *    in either case, as for the person's own CLI with that variable (secureVar: empty on macOS when theirs is empty).
 *  `platform`: the one the CLI runs on, this host's. */
export function signInEnv(login: ClaudeAgentLogin, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const secure = secureVar(login, platform);
  if (login.home !== undefined) return { HOME: login.home, ...(secure !== undefined ? { CLAUDE_SECURESTORAGE_CONFIG_DIR: secure } : {}), ANTHROPIC_CONFIG_DIR: login.profiles };
  return { CLAUDE_CONFIG_DIR: login.dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: secure ?? login.dir, ANTHROPIC_CONFIG_DIR: login.profiles };
}

/** The CLI's folder variables: where it keeps its config (the account) and its credentials. */
const FOLDER_VARS = ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] as const;

/** The line a person runs to sign the CLI in at `login` (the CLI opens a browser itself), with signInEnv's variables
 *  but HOME, which is their terminal's own. A folder variable signInEnv leaves unset (the CLI's default folder) is
 *  cleared by `env -u`, since a terminal that exports it would sign in there: env is a program, so sh, bash, zsh, fish
 *  and tcsh all run that line alike (fish has no `( ... )` subshell, tcsh no `NAME=value cmd`). env reads any word
 *  holding '=' as one more variable, so a CLI path holding one (/data/a=b/claude) goes to `sh -c` as its `$0`, single
 *  quoted, which every one of those shells reads alike too. What env skips: a `claude` alias or function of the
 *  person's shell. Elsewhere nothing is cleared, and the line is the variables in front of the CLI, as a shell reads
 *  them (sh, bash, zsh, fish 3.1 and later; not tcsh). A login whose home is not the terminal's (`homeApart`) carries
 *  `HOME` first (personHome), as the sign-in this host starts does. `platform`: as signInEnv's. */
export const loginCommand = (login: ClaudeAgentLogin, cli = "claude", platform: NodeJS.Platform = process.platform): string => {
  const env = login.homeApart ? { HOME: personHome(login), ...signInEnv(login, platform) } : signInEnv(login, platform);
  const cleared = FOLDER_VARS.filter((name) => !(name in env));
  const vars = Object.entries(env).filter(([name]) => name !== "HOME" || login.homeApart).map(([name, value]) => `${name}=${shellWord(value)}`);
  if (!cleared.length) return [...vars, commandWord(cli), "auth", "login"].join(" ");
  const run = cli.includes("=") ? ["sh", "-c", `'exec "$0" auth login'`, quoted(cli)] : [shellWord(cli), "auth", "login"];
  return ["env", ...cleared.flatMap((name) => ["-u", name]), ...vars, ...run].join(" ");
};

const quoted = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;
const shellWord = (word: string): string => (/^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : quoted(word));
/** The CLI as the line's command word: quoted when it holds '=', so a relative `a=b/claude` is never read as a variable;
 *  a bare `claude` stays bare, so the shell's alias or function of that name is the one it runs. */
const commandWord = (word: string): string => (word.includes("=") ? quoted(word) : shellWord(word));

/** What the CLI says of its login: whether it is signed in, how, and the account's own words when it gives them. */
export interface ClaudeLoginStatus {
  signedIn: boolean;
  /** How the CLI signs in (`claude.ai`, `oauth_token`, `api_key`, ...). */
  method?: string;
  email?: string;
  organization?: string;
  /** The account's plan (`max`, `pro`, `team`, ...). */
  plan?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined);

/** `claude auth status --json`'s answer, read for the fields above alone; undefined when it is no such answer. */
export function parseLoginStatus(stdout: string): ClaudeLoginStatus | undefined {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    body = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof body.loggedIn !== "boolean") return undefined;
  const method = text(body.authMethod);
  const email = text(body.email);
  const organization = text(body.orgName) ?? text(body.organization);
  const plan = text(body.subscriptionType) ?? text(body.plan);
  return { signedIn: body.loggedIn && method !== "none", ...(method ? { method } : {}), ...(email ? { email } : {}), ...(organization ? { organization } : {}), ...(plan ? { plan } : {}) };
}

/** The longest a status check may take. */
export const LOGIN_STATUS_MS = 15_000;
/** After a status check's limit asks its CLI to go (SIGTERM), how long before the CLI is killed (SIGKILL). */
const STATUS_KILL_MS = 1_000;
/** Once a status check's CLI has exited, or was killed, how long the check still waits for its output's pipe to close
 *  before it leaves it: a process the CLI started can hold that pipe open with no end. */
const STATUS_DRAIN_MS = 1_000;
/** The longest delay setTimeout keeps (2^31 - 1 ms): past it, the timer fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** A status check the CLI outlasted: ended at its limit (`limitMs`) with no answer, which says nothing of the login (a
 *  loaded host can take that long), apart from a CLI that answered, in time, what reads as no status. `code` is
 *  `timed_out`, so a caller that loads the harness lazily can tell it without the class. */
export class ClaudeLoginTimedOut extends Error {
  readonly code = "timed_out";
  constructor(readonly limitMs: number) {
    super(`the claude CLI gave no login status: the check timed out after ${Number((limitMs / 1000).toFixed(1))} s`);
    this.name = "ClaudeLoginTimedOut";
  }
}

/** A status check the CLI answered in time with nothing that reads as a status: no answer either, apart from a CLI that
 *  never started (the spawn's own error, `ENOENT` and the like). `code` is `no_status`, for a caller that loads the
 *  harness lazily. */
export class ClaudeLoginNoStatus extends Error {
  readonly code = "no_status";
  constructor() {
    super("the claude CLI gave no login status");
    this.name = "ClaudeLoginNoStatus";
  }
}

/** The name of a status check's own folder in the temporary folder, ahead of mkdtemp's six characters. */
const STATUS_FOLDER = "agentrun-claude-status-";
const STATUS_FOLDER_NAME = /^agentrun-claude-status-[A-Za-z0-9]{6}$/;
/** The file in a status check's folder that says when the check ends at the latest, in ms since the epoch: its start
 *  plus its own limit, the kill's grace and the wait for its pipe (claudeLoginStatus). */
const STATUS_ENDS_FILE = "ends";
/** How long past a check's end (STATUS_ENDS_FILE) its folder is left before a sweep takes it. */
const STATUS_SWEEP_MARGIN_MS = LOGIN_STATUS_MS;

/** When the status check that owns `folder` ends at the latest (its STATUS_ENDS_FILE), or undefined when that can't be
 *  read as a time. A check writes its end at its start, so an end before the file's own mtime is none a check wrote:
 *  empty or blank (a check between its create, wx, and its write: Number("") is 0), a partial write, a negative. */
async function checkEnds(folder: string): Promise<number | undefined> {
  try {
    const file = join(folder, STATUS_ENDS_FILE);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 32) return undefined;
    const ends = Number((await readFile(file, "utf8")).trim());
    return Number.isSafeInteger(ends) && ends >= stat.mtimeMs ? ends : undefined;
  } catch {
    return undefined;
  }
}

/** Removes what status checks cut off mid-way left: a server killed outright (SIGKILL) runs no `finally`, so its check's
 *  folder (claudeLoginStatus's `scratch`), with the copy of the account file in it, stays in the temporary folder. Takes
 *  each folder there named as a check's (the prefix and mkdtemp's six characters, nothing longer) that is this user's
 *  (`uid`, `process.getuid()` by default) and whose check has ended: more than STATUS_SWEEP_MARGIN_MS (15 s) before
 *  `now` by the end the check wrote in it (STATUS_ENDS_FILE), whatever limit its caller gave it, so a check another
 *  server on this host is running is never taken. A folder with no such end (its check was killed before writing it,
 *  or what the file holds is no time, or one before the file was written: checkEnds) is taken once it was last changed
 *  more than twice a check's limit (LOGIN_STATUS_MS) before `now`. Exactly at its margin, a folder stays by either
 *  rule. Another user's folder, a link or a file is never taken. `dir`: the temporary folder (`os.tmpdir()` by
 *  default). Nothing on Windows, which has no uid to tell whose a folder is. Never throws: a folder that can't be read or
 *  removed stays. Resolves to the folders it removed. The server runs it as it starts. */
export async function sweepClaudeStatusFolders(options: { dir?: string; uid?: number; now?: number } = {}): Promise<string[]> {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return [];
  const dir = options.dir ?? tmpdir();
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names.filter((entry) => STATUS_FOLDER_NAME.test(entry)).sort()) {
    const path = join(dir, name);
    try {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.uid !== uid) continue;
      const ends = await checkEnds(path);
      // Kept while at most its margin past, by either rule.
      if (ends === undefined ? stat.mtimeMs >= now - 2 * LOGIN_STATUS_MS : now <= ends + STATUS_SWEEP_MARGIN_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // It stays.
    }
  }
  return removed;
}

/** The account file (`.claude.json`) the CLI keeps for `login`: in the person's home on the CLI's default folder
 *  (`home`), else in the login's folder (their `CLAUDE_CONFIG_DIR`, or AgentRun's own, where `auth login` writes it). */
const accountFile = (login: ClaudeAgentLogin): string => join(login.home ?? login.dir, ".claude.json");

/** The account file's fields that hold secrets, which its copy never gets: the API key an older CLI signed in with
 *  (`primaryApiKey`, the CLI's key when no other is set), the variables the CLI exports on start (`env`, which can hold
 *  `ANTHROPIC_API_KEY` or a token), and MCP servers, whose `env` and `headers` hold their tokens (`mcpServers`: the
 *  user's here, each folder's under `projects`). The rest holds none: `customApiKeyResponses` keeps the last 20
 *  characters of a key, `oauthAccount` the account's words; the tokens are in the credentials dir. A run's config dir
 *  has none of these either, so the check answers as a run would. */
const ACCOUNT_SECRETS = ["primaryApiKey", "env", "mcpServers"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The account file `raw` without its secrets (ACCOUNT_SECRETS), or undefined when it is no JSON object: nothing of a
 *  file that can't be read field by field is copied, as if it were missing. The CLI reads no account from such a file
 *  either (it calls it corrupted). */
function withoutSecrets(raw: Buffer): string | undefined {
  // A UTF-8 byte order mark ahead of the JSON is skipped.
  const text = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? raw.subarray(3) : raw;
  let account: unknown;
  try {
    account = JSON.parse(text.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(account)) return undefined;
  const copy: Record<string, unknown> = { ...account };
  for (const field of ACCOUNT_SECRETS) delete copy[field];
  if (isRecord(copy.projects)) {
    copy.projects = Object.fromEntries(Object.entries(copy.projects).map(([folder, project]) => {
      if (!isRecord(project)) return [folder, project];
      const rest: Record<string, unknown> = { ...project };
      delete rest.mcpServers;
      return [folder, rest];
    }));
  }
  return `${JSON.stringify(copy, null, 2)}\n`;
}

/** The largest account file a status check copies. The pinned CLI's own files are far smaller; a bigger one is copied
 *  as nothing, so no poll parses it. */
const ACCOUNT_MAX_BYTES = 32 * 1024 * 1024;

/** The bytes of the account file `from`, or undefined when there is none, or when it is no regular file of at most
 *  ACCOUNT_MAX_BYTES (a FIFO, a device, a folder, a bigger file): copied as nothing, as an unparsable one is. Read off
 *  the server's thread, and never past the size it had when opened. Opened with O_NONBLOCK, so a FIFO opens at once with
 *  no writer (rather than holding the open until one comes), and is then refused by its fstat. Links are followed (no
 *  O_NOFOLLOW): `~/.claude.json` is often a link a dotfiles manager keeps, and the fstat is of what the open reached, so a
 *  link to a device or a FIFO is refused as they are. Any other failure to open it (EACCES) throws, as before. */
async function accountBytes(from: string): Promise<Buffer | undefined> {
  let file: FileHandle;
  try {
    file = await open(from, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > ACCOUNT_MAX_BYTES) return undefined;
    // One byte past the size it said: a file that grew since is not read whole, and is copied as nothing.
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > stat.size ? undefined : bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

/** A new folder `to` (0700) holding a copy (0600) of the account file `from` without its secrets (withoutSecrets), or
 *  nothing when there is none, it is no regular file of at most ACCOUNT_MAX_BYTES (accountBytes) or no JSON object.
 *  `from` is only read. */
async function accountCopy(from: string, to: string): Promise<string> {
  await mkdir(to, { mode: 0o700 });
  const raw = await accountBytes(from);
  const account = raw === undefined ? undefined : withoutSecrets(raw);
  if (account !== undefined) await writeFile(join(to, ".claude.json"), account, { mode: 0o600, flag: "wx" });
  return to;
}

/** The home of the person whose CLI keeps `login`, the one every use of the login reads: the login's `userHome`, else
 *  its `home` (the CLI's default folder), else the server's (`os.homedir()`), for a login made with neither. On macOS
 *  the CLI reads its tokens from the login keychain, which is under that home: in any other home (an empty one, a
 *  session's) it finds no keychain and reads signed out, whatever the variables. */
export const personHome = (login: ClaudeAgentLogin): string => login.userHome ?? login.home ?? homedir();

/** How long the delete of an "unknown" item may take before it is left (dropUnknownItem). */
const DROP_MS = 5_000;
/** The items dropUnknownItem has dealt with in this process, by home and service: each is deleted once. */
const dropped = new Set<string>();

/** On macOS, at AgentRun's own folder (`own`) alone, delete the login's Keychain item under the account "unknown", which
 *  a sign-in left there when the CLI was started with no USER (loginUser), and which nothing reads now: `security
 *  delete-generic-password -a unknown -s <the item's service>`, the service the CLI names from the folder (`Claude
 *  Code-credentials-<first 8 hex of the folder's sha256>`), in the person's home (personHome), whose login keychain holds
 *  it. Called once the item under the person's account is there (the sign-in exited 0, a status check read signed in).
 *  Never at the person's own CLI's places, whose "unknown" item may be theirs, never the item with no suffix, never an
 *  item of any other account, and never where the user this server runs as is named "unknown" itself. "Not found" is
 *  done, as is any other end: nothing is thrown, and it is asked once per item in this process. */
export async function dropUnknownItem(login: ClaudeAgentLogin, options: { path: string; platform?: NodeJS.Platform }): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin" || login.own !== true) return;
  const folder = loginEnv(login, "darwin").CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const user = loginUser();
  if (!folder || user.USER === undefined || user.USER === "unknown") return;
  const service = `Claude Code-credentials-${createHash("sha256").update(folder).digest("hex").slice(0, 8)}`;
  const HOME = personHome(login);
  const key = JSON.stringify([HOME, service]);
  if (dropped.has(key)) return;
  dropped.add(key);
  await new Promise<void>((resolve) => {
    try {
      const child = spawn("security", ["delete-generic-password", "-a", "unknown", "-s", service], { env: { PATH: options.path, HOME, ...user }, stdio: "ignore", timeout: DROP_MS });
      child.once("error", () => resolve());
      child.once("close", () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Ask the CLI at `cli` whether it is signed in at `login`: `auth status --json`, with only PATH, the user (loginUser)
 *  and the login's variables beside it, in the person's home (personHome) on every place and platform.
 *  The CLI rewrites its account file (`.claude.json`, in its config dir) whenever that file's migration number is not its
 *  own, and adds a settings file, a backup and a lock beside it the first time, all in its config dir, so the check never
 *  runs it on the login's own file, whatever the caller says of the login: the config dir is a copy of the account file
 *  (accountFile: the default folder's in the home, else the login folder's) in a folder of its own (`scratch`, one per
 *  check, removed after it answers or throws), less its secrets (accountCopy), and the credentials dir is a run's
 *  (loginEnv): on macOS it names the Keychain item ahead of the config dir (empty: the item with no suffix, the default
 *  folder's; else hashed from the login's folder, as the sign-in there named it), so the copy never renames it.
 *  A status check is no session: nothing resumes in its config dir. `platform`: the one the CLI runs on, this host's.
 *  Asks once. Throws when the CLI gives no answer that reads as one: ClaudeLoginTimedOut when it was still running at
 *  the limit (`timeoutMs`, LOGIN_STATUS_MS by default) and was ended there, else ClaudeLoginNoStatus. A CLI that never
 *  started throws the spawn's own error. At the limit the CLI is asked to go (SIGTERM) and killed STATUS_KILL_MS later;
 *  once it has exited or was killed, the check waits STATUS_DRAIN_MS more at most for its output, which a process it
 *  started may hold open, and then one more pass of the event loop's reads. So a check settles within its limit, 2 s and
 *  that pass, whatever the CLI does. A `timeoutMs` that is no whole number of ms from 1 to 2^31 - 1 throws a RangeError
 *  before anything starts. */
export async function claudeLoginStatus(cli: string, login: ClaudeAgentLogin, options: { timeoutMs?: number; path?: string; platform?: NodeJS.Platform } = {}): Promise<ClaudeLoginStatus> {
  const limitMs = options.timeoutMs ?? LOGIN_STATUS_MS;
  // The limit is the check's timer and, with 2 s more, the end it writes for the sweep, which reads only a whole number
  // of ms: a fractional one would leave a live check's folder to the sweep's mtime rule. setTimeout fires at once past
  // 2^31 - 1.
  if (!Number.isSafeInteger(limitMs) || limitMs < 1 || limitMs > MAX_TIMER_MS) throw new RangeError(`timeoutMs must be a whole number of ms from 1 to ${MAX_TIMER_MS}, not ${limitMs}`);
  const scratch = mkdtempSync(join(tmpdir(), STATUS_FOLDER));
  try {
    // When this check ends at the latest, so another server's sweep leaves its folder until then, whatever its limit.
    await writeFile(join(scratch, STATUS_ENDS_FILE), String(Date.now() + limitMs + STATUS_KILL_MS + STATUS_DRAIN_MS), { mode: 0o600, flag: "wx" });
    const HOME = personHome(login);
    const where = { HOME, ...loginEnv(login, options.platform), CLAUDE_CONFIG_DIR: await accountCopy(accountFile(login), join(scratch, "config")) };
    const { stdout, timedOut } = await new Promise<{ stdout: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(cli, ["auth", "status", "--json"], {
        env: { PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", ...loginUser(), ...where, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      let timedOut = false;
      let settled = false;
      let kill: ReturnType<typeof setTimeout> | undefined;
      let drain: ReturnType<typeof setTimeout> | undefined;
      const settle = (then: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(limit);
        clearTimeout(kill);
        clearTimeout(drain);
        then();
      };
      // The CLI exits 1 when signed out, its answer said all the same.
      const done = () => settle(() => {
        child.stdout.destroy();
        resolve({ stdout: out, timedOut });
      });
      // Once the CLI has exited or was killed, its pipe gets a short while to close, and is then left. The timer gives up
      // only after one more pass of the loop's reads (setImmediate runs after them): a loop held up past the drain, as on
      // a busy server, runs its timers before its reads, and what the pipe already held would be dropped unread.
      const drainSoon = () => {
        drain ??= setTimeout(() => setImmediate(done), STATUS_DRAIN_MS);
      };
      // The limit is kept here, not by spawn's `timeout`, so the check knows it ended the CLI, and kills a CLI that
      // outlasts the TERM.
      const limit = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        kill = setTimeout(() => {
          child.kill("SIGKILL");
          drainSoon();
        }, STATUS_KILL_MS);
      }, limitMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (out.length < 64 * 1024) out += chunk;
      });
      child.once("error", (error) => settle(() => reject(error)));
      child.once("exit", drainSoon);
      child.once("close", done);
    });
    const status = parseLoginStatus(stdout.trim());
    // A whole answer written just before the limit still counts.
    if (!status) throw timedOut ? new ClaudeLoginTimedOut(limitMs) : new ClaudeLoginNoStatus();
    // Signed in: the item under the person's account is there, so one a sign-in left under "unknown" goes (AgentRun's
    // own folder alone).
    if (status.signedIn) await dropUnknownItem(login, { path: options.path ?? process.env.PATH ?? "/usr/bin:/bin", ...(options.platform ? { platform: options.platform } : {}) });
    return status;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** How long the CLI's own sign-in waits for its browser before it is ended. */
export const SIGN_IN_MS = 10 * 60_000;
/** After asking an ending sign-in to stop, how long before it is killed. Longer than SIGN_IN_TERM_GRACE_MS, the grace
 *  the sign-in asks of the parent-watch shim: under the shim this kill reaches the shim alone, which has killed a CLI
 *  that outlasted the TERM by then. */
const SIGN_IN_KILL_MS = 5_000;
/** Under the parent-watch shim, how long after passing the stop's TERM on the shim kills the CLI (parentWatched's
 *  `termGraceMs`). Shorter than SIGN_IN_KILL_MS, so the CLI is gone before the server's kill ends the shim. */
const SIGN_IN_TERM_GRACE_MS = 2_000;

/** How a sign-in ended: the CLI exited by itself (`exited`: `code` 0 when it signed in, or the signal that ended it),
 *  it was ended at its limit (`timed_out`) or by the host (`stopped`), or it never started (`failed`, in the spawn's
 *  words). */
export type ClaudeSignInEnd = { end: "exited"; code: number | null; signal: string | null } | { end: "timed_out" } | { end: "stopped" } | { end: "failed"; message: string };

/** A sign-in startClaudeLogin started: `ended` settles once, with how it ended; `stop()` ends it (nothing once ended). */
export interface ClaudeSignIn {
  ended: Promise<ClaudeSignInEnd>;
  stop(): void;
}

/** Whether `file` is a regular file this process may execute. A Buffer is a path's own bytes, as the kernel takes them. */
function executable(file: string | Buffer): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The first program named `name` on `path`, or undefined. */
function onPath(name: string, path: string): string | undefined {
  for (const dir of path.split(delimiter)) if (dir && executable(join(dir, name))) return join(dir, name);
  return undefined;
}

/** Whether a program named by the bytes `name` is on a folder of `path` (the sign-in's PATH, which env searches). */
const onPathBytes = (name: Buffer, path: string): boolean => path.split(delimiter).some((dir) => dir !== "" && executable(Buffer.concat([Buffer.from(join(dir, "/")), name])));

/** The first line of `file` (at most 256 bytes) as its bytes, or undefined when it can't be read. */
function firstLine(file: string): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(256);
    const read = head.subarray(0, readSync(fd, head, 0, head.length, 0));
    const end = read.indexOf(0x0a);
    return end < 0 ? read : read.subarray(0, end);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The words of a `#!` line after the `#!` (the interpreter, then its argument), as bytes: the kernel reads the line as
 *  bytes and splits it at blanks, so a path under a folder whose name is not ASCII is that name's bytes, never a decode
 *  of them. Blanks are ASCII ones only: in UTF-8 the byte 0xA0 is part of a character (`à` is C3 A0), not a space. */
function shebangWords(line: Buffer | undefined): Buffer[] {
  if (!line || line[0] !== 0x23 || line[1] !== 0x21) return [];
  const words: Buffer[] = [];
  let start = -1;
  for (let i = 2; i <= line.length; i++) {
    const blank = i === line.length || [0x20, 0x09, 0x0d, 0x0b, 0x0c, 0x00].includes(line[i]!);
    if (blank && start >= 0) {
      words.push(line.subarray(start, i));
      start = -1;
    } else if (!blank && start < 0) start = i;
  }
  return words;
}

const notStartable = (cli: string, why = ""): Error => Object.assign(new Error(`spawn ${cli} ENOENT${why}`), { code: "ENOENT" });

/** Throws, in the spawn's words, when `cli` is no program this host can start: the parent watch starts a program of its
 *  own first (setpriv, or node with its shim), which would tell a failed start only as its own exit code (127), and the
 *  sign-in's output is read by no one. So a script whose first line names an interpreter that is not there (`#!/path`,
 *  or `#!/usr/bin/env <program>` with the program on no folder of `path`) throws too, naming it. A bare name is looked up
 *  on `path`. Not on Windows, whose names take an extension and which reads no `#!` line: the watch's exit says it there. */
function startable(cli: string, path: string): void {
  if (process.platform === "win32") {
    if (/[\\/]/.test(cli)) accessSync(cli, constants.X_OK);
    return;
  }
  let file = cli;
  if (/[\\/]/.test(cli)) accessSync(cli, constants.X_OK);
  else file = onPath(cli, path) ?? "";
  if (!file) throw notStartable(cli);
  // The interpreter and its argument are checked by their bytes (Buffer paths); the tests on their ASCII characters read
  // them as Latin-1, which maps each byte to one character, so those tests see exactly the bytes. The words decode them.
  const [interpreter, program] = shebangWords(firstLine(file));
  if (!interpreter) return;
  if (!executable(interpreter)) throw notStartable(cli, `: the interpreter its first line names, ${interpreter.toString()}, is not there`);
  // env runs the program it is given, looked up on the sign-in's PATH; an option or a variable is left to env.
  if (/(^|\/)env$/.test(interpreter.toString("latin1")) && program && !/^-|=/.test(program.toString("latin1")) && !(program.includes(0x2f) ? executable(program) : onPathBytes(program, path))) {
    throw notStartable(cli, `: the interpreter its first line names, ${program.toString()}, is on no folder of its PATH`);
  }
}

/** Start the CLI's own sign-in at `login` (`auth login`), with the line's own variables (signInEnv) in the person's home
 *  (personHome), as that person (loginUser: the account the Keychain item is saved under on macOS, the one their own
 *  terminal's `claude` reads), and on their desktop (`display`): it opens a browser on this machine and keeps what it gets in the login's folder.
 *  Nothing of it is read here: its output goes nowhere. It is ended after `timeoutMs` (SIGN_IN_MS by default), which
 *  `ended` says apart from any other end.
 *  It dies with this process, as a session's CLI does: started under the kernel's parent watch (parentWatched; `watch`,
 *  by default what this machine supports), so a server that is SIGKILLed, and runs no stop or limit timer, leaves no CLI
 *  waiting on the browser's port. It is not detached: it stays in this process's group, so a terminal's Ctrl-C ends it
 *  with the server as before, and nothing here kills a group, which would take a browser the CLI started with it.
 *  A sign-in that exits 0 at AgentRun's own folder has the item a sign-in left there under "unknown" deleted before
 *  `ended` settles (dropUnknownItem). `platform`: the one the CLI runs on, this host's. */
export function startClaudeLogin(cli: string, login: ClaudeAgentLogin, options: { timeoutMs?: number; path?: string; display?: Readonly<Record<string, string | undefined>>; watch?: ParentWatch; platform?: NodeJS.Platform } = {}): ClaudeSignIn {
  // What a browser needs to open on this desktop, when the server has it.
  const display = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "BROWSER"].flatMap((name) => {
    const value = options.display?.[name];
    return typeof value === "string" ? [[name, value]] : [];
  }));
  let settle!: (end: ClaudeSignInEnd) => void;
  const ended = new Promise<ClaudeSignInEnd>((resolve) => { settle = resolve; });
  const failed = (error: unknown): ClaudeSignInEnd => ({ end: "failed", message: String((error as Error)?.message ?? error).slice(0, 200) });
  const path = options.path ?? process.env.PATH ?? "/usr/bin:/bin";
  let child: ReturnType<typeof spawn>;
  try {
    startable(cli, path);
    const run = parentWatched({ command: cli, args: ["auth", "login", "--claudeai"] }, options.watch, { termGraceMs: SIGN_IN_TERM_GRACE_MS });
    child = spawn(run.command, run.args, {
      env: { PATH: path, HOME: personHome(login), ...loginUser(), ...display, ...signInEnv(login), DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
      stdio: "ignore",
    });
  } catch (error) {
    settle(failed(error));
    return { ended, stop: () => {} };
  }
  let done = false;
  let ending: "timed_out" | "stopped" | undefined;
  let kill: ReturnType<typeof setTimeout> | undefined;
  const end = (why: "timed_out" | "stopped") => {
    if (done || ending) return;
    ending = why;
    child.kill("SIGTERM");
    kill = setTimeout(() => child.kill("SIGKILL"), SIGN_IN_KILL_MS);
    kill.unref();
  };
  const limit = setTimeout(() => end("timed_out"), options.timeoutMs ?? SIGN_IN_MS);
  limit.unref();
  const finish = (result: ClaudeSignInEnd) => {
    if (done) return;
    done = true;
    clearTimeout(limit);
    if (kill) clearTimeout(kill);
    settle(result);
  };
  child.once("error", (error) => finish(ending ? { end: ending } : failed(error)));
  child.once("close", (code, signal) => {
    const result: ClaudeSignInEnd = ending ? { end: ending } : { end: "exited", code, signal };
    // Signed in: the item under the person's account is there, so one a sign-in left under "unknown" goes first
    // (AgentRun's own folder alone).
    if (result.end === "exited" && code === 0) void dropUnknownItem(login, { path, ...(options.platform ? { platform: options.platform } : {}) }).then(() => finish(result));
    else finish(result);
  });
  return { ended, stop: () => end("stopped") };
}

/** The longest the CLI's own sign-out may take. */
export const LOGOUT_MS = LOGIN_STATUS_MS;

/** The CLI's own sign-out at `login` (`auth logout`), with the sign-in's variables (signInEnv) and user (loginUser) in
 *  the person's home (personHome), so it removes what that sign-in kept where it kept it: the credentials file in the
 *  login's credentials dir or, on macOS, the Keychain item named from it under that user's account, and the account in
 *  the config dir's `.claude.json`. Nothing of it
 *  is read but how it ended: true when it exited 0 within `timeoutMs` (LOGOUT_MS by default), false when it exited
 *  otherwise, never started, or was ended at the limit (SIGTERM, then SIGKILL a second later). Never throws.
 *  `platform`: as signInEnv's. */
export function claudeLogout(cli: string, login: ClaudeAgentLogin, options: { timeoutMs?: number; path?: string; platform?: NodeJS.Platform } = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, ["auth", "logout"], {
        env: { PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", HOME: personHome(login), ...loginUser(), ...signInEnv(login, options.platform), DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
        stdio: "ignore",
      });
    } catch {
      return resolve(false);
    }
    let timedOut = false;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const limit = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), STATUS_KILL_MS);
    }, options.timeoutMs ?? LOGOUT_MS);
    const done = (confirmed: boolean) => {
      clearTimeout(limit);
      clearTimeout(kill);
      resolve(confirmed);
    };
    child.once("error", () => done(false));
    child.once("close", (code) => done(!timedOut && code === 0));
  });
}

/** A model response's usage, as Anthropic's stream says it (`message_start`, then `message_delta`). */
type StreamUsage = { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** How a session on a login books its requests: no proxy sees them, so each response the CLI streams is booked from its
 *  own events, billed to the plan, at no price here. No proxy can hold a request back either, so a request is admitted
 *  before the CLI can send it: when a message goes to the CLI (`sending`), and when a response stops for its tool calls,
 *  whose results the CLI sends straight back. A refusal there (a turn limit, say) halts the drive while the CLI has yet to
 *  send. A response with no admission ahead of it (one the CLI sent on its own) is admitted at its `message_start`. Each
 *  is booked at its `message_stop`; one the turn's end leaves open is booked as it stands, and an admission no request
 *  took is closed as never sent when the drive ends (`settle(true)`). */
export function loginBooking(models: Pick<ModelPort, "beforeRequest" | "afterRequest">, model: string, halt: (error: Error) => void) {
  type Ticket = Parameters<ModelPort["afterRequest"]>[1];
  let open: { ticket: Promise<unknown>; usage: Omit<ModelUsage, "usd">; tools: boolean } | undefined;
  let ahead: Promise<unknown> | undefined;
  let booked: Promise<void> = Promise.resolve();
  const refused = Symbol("refused");
  const stopped = (error: unknown) => halt(error instanceof Error ? error : new Error(String(error)));
  const admit = (): Promise<unknown> => {
    const ticket = (async () => models.beforeRequest({ model }))();
    ticket.catch(stopped);
    return ticket;
  };
  const admitAhead = () => {
    ahead ??= admit();
  };
  const after = (ticket: Promise<unknown>, usage: ModelUsage, ended: Parameters<ModelPort["afterRequest"]>[2]) => {
    booked = booked.then(async () => {
      const taken = await ticket.catch(() => refused);
      // Refused at its admission: nothing to book (the drive is halted already).
      if (taken === refused) return;
      await models.afterRequest(usage, taken as Ticket, ended);
    }).catch(stopped);
  };
  const book = () => {
    const entry = open;
    open = undefined;
    if (!entry) return;
    after(entry.ticket, { ...entry.usage, usd: null, billing: "plan" }, { end: "answered", usd: null });
    if (entry.tools) admitAhead();
  };
  const take = (usage: Omit<ModelUsage, "usd">, given: StreamUsage | undefined) => {
    const input = count(given?.input_tokens);
    const output = count(given?.output_tokens);
    const cacheRead = count(given?.cache_read_input_tokens);
    const cacheWrite = count(given?.cache_creation_input_tokens);
    return { ...usage, ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }), ...(cacheRead === undefined ? {} : { cacheRead }), ...(cacheWrite === undefined ? {} : { cacheWrite }) };
  };
  return {
    /** A message is about to go to the CLI: admit the request it will make, and settle when it is admitted (a refusal
     *  rejects, the drive halted already), so the message goes only once its request may. */
    async sending(): Promise<void> {
      admitAhead();
      await ahead;
    },
    /** One message of the SDK's stream. */
    observe(message: unknown): void {
      const m = message as { type?: string; event?: { type?: string; message?: { usage?: StreamUsage }; usage?: StreamUsage; delta?: { stop_reason?: unknown } } };
      if (m?.type !== "stream_event" || !m.event) return;
      const event = m.event;
      if (event.type === "message_start") {
        book();
        const ticket = ahead ?? admit();
        ahead = undefined;
        open = { ticket, usage: take({ input: 0, output: 0, billing: "plan" }, event.message?.usage), tools: false };
      } else if (event.type === "message_delta" && open) {
        open.usage = take(open.usage, event.usage);
        if (event.delta?.stop_reason === "tool_use") open.tools = true;
      } else if (event.type === "message_stop") {
        book();
      }
    },
    /** Book what is open and wait for every booking to be written. `ended`: the drive is over, so an admission no request
     *  took is closed as never sent. */
    async settle(ended = false): Promise<void> {
      book();
      if (ended && ahead) {
        after(ahead, { input: 0, output: 0, usd: null, billing: "plan" }, { end: "nothing", label: "never_left" });
        ahead = undefined;
      }
      await booked;
    },
  };
}
