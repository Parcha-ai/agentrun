// A person's own Claude Code login on this machine, which a claude-agent session may run on in place of a model key.
// Written for AgentRun.
//
// The pinned CLI keeps the login where it always does, in its own files, and calls Anthropic with it itself. AgentRun
// never reads, copies, stores or relays its tokens: a session only tells the CLI where its login is (two directories, by
// environment), and the host asks the CLI whether it is signed in (`claude auth status`), reading nothing but that answer.
// That check runs the CLI on a private copy of the login's account file (`.claude.json`), which the CLI rewrites on
// start, so the file (the person's own, or AgentRun's) is only ever opened to read. The copy leaves out the fields that
// hold secrets (an API key, exported variables, MCP servers' tokens) and lasts the check.
// The check runs in the person's own home, as does a run on macOS, where the CLI's tokens are in the login keychain.
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ModelPort, ModelUsage } from "@parcha/agentrun-kernel";
import { parentWatched, type ParentWatch } from "@parcha/agentrun-kernel/host";

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
  /** The home of the person whose CLI keeps the login, read once by whoever makes the login (serve's loginAt: the
   *  server's `HOME` when absolute, else `os.homedir()`, as the person's own CLI reads it), so the status check, the
   *  sign-in and a run on macOS all run in that one home (personHome). With `home`, the same folder. */
  userHome?: string;
}

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
 *  cleared in a subshell, `(unset ...; ...)`, since a terminal that exports it would sign in there; the terminal keeps
 *  its own. The line stays the shell's own command, never `env`'s: env reads any word holding '=' as a variable (a CLI
 *  under /data/a=b would never start) and skips the shell's aliases and functions, where a `claude` alias is often the
 *  CLI's local install. sh, bash and zsh all read this line the same way. `platform`: as signInEnv's. */
export const loginCommand = (login: ClaudeAgentLogin, cli = "claude", platform: NodeJS.Platform = process.platform): string => {
  const env = signInEnv(login, platform);
  const cleared = FOLDER_VARS.filter((name) => !(name in env));
  const run = [
    ...Object.entries(env).filter(([name]) => name !== "HOME").map(([name, value]) => `${name}=${shellWord(value)}`),
    commandWord(cli), "auth", "login",
  ].join(" ");
  return cleared.length ? `(unset ${cleared.join(" ")}; ${run})` : run;
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

/** The name of a status check's own folder in the temporary folder, ahead of mkdtemp's six characters. */
const STATUS_FOLDER = "agentrun-claude-status-";
const STATUS_FOLDER_NAME = /^agentrun-claude-status-[A-Za-z0-9]{6}$/;

/** Removes what status checks cut off mid-way left: a server killed outright (SIGKILL) runs no `finally`, so its check's
 *  folder (claudeLoginStatus's `scratch`), with the copy of the account file in it, stays in the temporary folder. Takes
 *  each folder there named as a check's (the prefix and mkdtemp's six characters, nothing longer) that is this user's
 *  (`uid`, `process.getuid()` by default) and was last changed more than twice a check's limit (LOGIN_STATUS_MS) before
 *  `now`. A check's folder changes as it starts and lives no longer than that limit, so a check another server on this
 *  host is running is never taken; nor is another user's folder, a link or a file. `dir`: the temporary folder
 *  (`os.tmpdir()` by default). Nothing on Windows, which has no uid to tell whose a folder is. Never throws: a folder
 *  that can't be read or removed stays. Resolves to the folders it removed. The server runs it as it starts. */
export async function sweepClaudeStatusFolders(options: { dir?: string; uid?: number; now?: number } = {}): Promise<string[]> {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) return [];
  const dir = options.dir ?? tmpdir();
  const before = (options.now ?? Date.now()) - 2 * LOGIN_STATUS_MS;
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
      if (!stat.isDirectory() || stat.uid !== uid || stat.mtimeMs > before) continue;
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

/** Ask the CLI at `cli` whether it is signed in at `login`: `auth status --json`, with only PATH and the login's
 *  variables beside it, in the person's home (personHome) on every place and platform.
 *  The CLI rewrites its account file (`.claude.json`, in its config dir) whenever that file's migration number is not its
 *  own, and adds a settings file, a backup and a lock beside it the first time, all in its config dir, so the check never
 *  runs it on the login's own file, whatever the caller says of the login: the config dir is a copy of the account file
 *  (accountFile: the default folder's in the home, else the login folder's) in a folder of its own (`scratch`, one per
 *  check, removed after it answers or throws), less its secrets (accountCopy), and the credentials dir is a run's
 *  (loginEnv): on macOS it names the Keychain item ahead of the config dir (empty: the item with no suffix, the default
 *  folder's; else hashed from the login's folder, as the sign-in there named it), so the copy never renames it.
 *  A status check is no session: nothing resumes in its config dir. `platform`: the one the CLI runs on, this host's.
 *  Asks once. Throws when the CLI gives no answer that reads as one: ClaudeLoginTimedOut when it was still running at
 *  the limit (`timeoutMs`, LOGIN_STATUS_MS by default) and was ended there, else a plain error. */
export async function claudeLoginStatus(cli: string, login: ClaudeAgentLogin, options: { timeoutMs?: number; path?: string; platform?: NodeJS.Platform } = {}): Promise<ClaudeLoginStatus> {
  const scratch = mkdtempSync(join(tmpdir(), STATUS_FOLDER));
  const limitMs = options.timeoutMs ?? LOGIN_STATUS_MS;
  try {
    const HOME = personHome(login);
    const where = { HOME, ...loginEnv(login, options.platform), CLAUDE_CONFIG_DIR: await accountCopy(accountFile(login), join(scratch, "config")) };
    const { stdout, timedOut } = await new Promise<{ stdout: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(cli, ["auth", "status", "--json"], {
        env: { PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", ...where, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        stdio: ["ignore", "pipe", "ignore"],
      });
      // The limit is kept here, not by spawn's `timeout`, so the check knows it ended the CLI.
      let timedOut = false;
      const limit = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, limitMs);
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (out.length < 64 * 1024) out += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(limit);
        reject(error);
      });
      // The CLI exits 1 when signed out, its answer said all the same.
      child.once("close", () => {
        clearTimeout(limit);
        resolve({ stdout: out, timedOut });
      });
    });
    const status = parseLoginStatus(stdout.trim());
    // A whole answer written just before the limit still counts.
    if (!status) throw timedOut ? new ClaudeLoginTimedOut(limitMs) : new Error("the claude CLI gave no login status");
    return status;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** How long the CLI's own sign-in waits for its browser before it is ended. */
export const SIGN_IN_MS = 10 * 60_000;
/** After asking an ending sign-in to stop, how long before it is killed. */
const SIGN_IN_KILL_MS = 5_000;

/** How a sign-in ended: the CLI exited by itself (`exited`: `code` 0 when it signed in, or the signal that ended it),
 *  it was ended at its limit (`timed_out`) or by the host (`stopped`), or it never started (`failed`, in the spawn's
 *  words). */
export type ClaudeSignInEnd = { end: "exited"; code: number | null; signal: string | null } | { end: "timed_out" } | { end: "stopped" } | { end: "failed"; message: string };

/** A sign-in startClaudeLogin started: `ended` settles once, with how it ended; `stop()` ends it (nothing once ended). */
export interface ClaudeSignIn {
  ended: Promise<ClaudeSignInEnd>;
  stop(): void;
}

/** Throws, in the spawn's words, when `cli` is no program this host can start: the parent watch starts a program of its
 *  own first (setpriv, or node with its shim), which would tell a missing CLI only as its own exit code. A bare name is
 *  looked up on `path` (not on Windows, whose names take an extension; the watch's exit says it there). */
function startable(cli: string, path: string): void {
  if (/[\\/]/.test(cli)) return accessSync(cli, constants.X_OK);
  if (process.platform === "win32") return;
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      return accessSync(join(dir, cli), constants.X_OK);
    } catch {
      // Not here.
    }
  }
  throw Object.assign(new Error(`spawn ${cli} ENOENT`), { code: "ENOENT" });
}

/** Start the CLI's own sign-in at `login` (`auth login`), with the line's own variables (signInEnv) in the person's home
 *  (personHome) and desktop (`display`): it opens a browser on this machine and keeps what it gets in the login's folder.
 *  Nothing of it is read here: its output goes nowhere. It is ended after `timeoutMs` (SIGN_IN_MS by default), which
 *  `ended` says apart from any other end.
 *  It dies with this process, as a session's CLI does: started under the kernel's parent watch (parentWatched; `watch`,
 *  by default what this machine supports), so a server that is SIGKILLed, and runs no stop or limit timer, leaves no CLI
 *  waiting on the browser's port. It is not detached: it stays in this process's group, so a terminal's Ctrl-C ends it
 *  with the server as before, and nothing here kills a group, which would take a browser the CLI started with it. */
export function startClaudeLogin(cli: string, login: ClaudeAgentLogin, options: { timeoutMs?: number; path?: string; display?: Readonly<Record<string, string | undefined>>; watch?: ParentWatch } = {}): ClaudeSignIn {
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
    const run = parentWatched({ command: cli, args: ["auth", "login", "--claudeai"] }, options.watch);
    child = spawn(run.command, run.args, {
      env: { PATH: path, HOME: personHome(login), ...display, ...signInEnv(login), DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
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
  child.once("close", (code, signal) => finish(ending ? { end: ending } : { end: "exited", code, signal }));
  return { ended, stop: () => end("stopped") };
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
