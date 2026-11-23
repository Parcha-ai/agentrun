// A person's own Claude Code login on this machine, which a claude-agent session may run on in place of a model key.
// Written for AgentRun.
//
// The pinned CLI keeps the login where it always does, in its own files, and calls Anthropic with it itself. AgentRun
// never reads, copies, stores or relays its tokens: a session only tells the CLI where its login is (two directories, by
// environment), and the host asks the CLI whether it is signed in (`claude auth status`), reading nothing but that answer.
// On a login the person's own CLI uses too, that check runs the CLI on a private copy of the account file
// (`.claude.json`), which the CLI rewrites on start, so the person's own file is only ever opened to read.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelPort, ModelUsage } from "@parcha/agentrun-kernel";

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
  /** Set for this machine's own login, which the person's own CLI uses too (the default folder or their
   *  `CLAUDE_CONFIG_DIR`): a status check never runs the CLI on its account file, only on a copy (claudeLoginStatus). */
  shared?: boolean;
}

/** The variables that point a session's CLI at `login`: never its config dir (`CLAUDE_CONFIG_DIR`), which the Agent SDK
 *  copies a credentials file out of when it resumes a session, so the credentials dir (`CLAUDE_SECURESTORAGE_CONFIG_DIR`)
 *  is always set. On macOS the CLI names its Keychain item from that dir (`-<sha256 of it>` after the name) unless it is
 *  set and empty; unset, it would hash the session's own config dir. So a login on the CLI's default folder (`home`) gets
 *  an empty one on macOS (the item with no suffix, the person's own CLI's), and its folder elsewhere, where the CLI keeps
 *  `.credentials.json` in that dir. A status check on a login the person's own CLI uses has a config dir of its own too
 *  (a copy of the account file), so it takes this rule (claudeLoginStatus). `platform`: the one the CLI runs on, this
 *  host's. */
export function loginEnv(login: ClaudeAgentLogin, platform: NodeJS.Platform = process.platform): Record<string, string> {
  return { CLAUDE_SECURESTORAGE_CONFIG_DIR: login.home !== undefined && platform === "darwin" ? "" : login.dir, ANTHROPIC_CONFIG_DIR: login.profiles };
}

/** The variables of the CLI's own sign-in at `login`. The line a person runs (loginCommand) and the sign-in this host
 *  starts (startClaudeLogin) both take these, and so does the status check (claudeLoginStatus) on AgentRun's own login,
 *  so they cannot drift apart. Neither is a session, whose config dir stays its own (loginEnv). On a login the person's
 *  own CLI uses too (`home`, `shared`) the status check runs on a copy of the account file instead.
 *  - On the CLI's default folder (`home`): the person's own CLI as it runs, with no config or credentials dir, in their
 *    home (`HOME`; a terminal of theirs has it already, so the shown line leaves it out, and clears the two folder
 *    variables a terminal may export). It writes the account in `<home>/.claude.json` and the tokens where that person's
 *    CLI keeps them, on every platform.
 *  - Anywhere else: the login's folder as both the config dir and the credentials dir. `auth login` writes the account it
 *    signed in to its config dir's `.claude.json`, where the status check reads it (from a copy, on a folder the person's
 *    own CLI uses). For a folder the person's own
 *    CLI uses through `CLAUDE_CONFIG_DIR`, the credentials dir set to that folder is where that CLI keeps its tokens too
 *    (Linux: the same file; macOS: the same item, hashed from the same folder). */
export function signInEnv(login: ClaudeAgentLogin): Record<string, string> {
  if (login.home !== undefined) return { HOME: login.home, ANTHROPIC_CONFIG_DIR: login.profiles };
  return { CLAUDE_CONFIG_DIR: login.dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: login.dir, ANTHROPIC_CONFIG_DIR: login.profiles };
}

/** The CLI's folder variables: where it keeps its config (the account) and its credentials. */
const FOLDER_VARS = ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"] as const;

/** The line a person runs to sign the CLI in at `login` (the CLI opens a browser itself), with signInEnv's variables
 *  but HOME, which is their terminal's own. A folder variable signInEnv leaves unset (the CLI's default folder) is
 *  cleared with `env -u` (GNU's and macOS's env both have it), since a terminal that exports it would sign in there. */
export const loginCommand = (login: ClaudeAgentLogin, cli = "claude"): string => {
  const env = signInEnv(login);
  const cleared = FOLDER_VARS.filter((name) => !(name in env));
  return [
    ...(cleared.length ? ["env", ...cleared.flatMap((name) => ["-u", name])] : []),
    ...Object.entries(env).filter(([name]) => name !== "HOME").map(([name, value]) => `${name}=${shellWord(value)}`),
    shellWord(cli), "auth", "login",
  ].join(" ");
};

const shellWord = (word: string): string => (/^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

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

/** The account file (`.claude.json`) the person's own CLI keeps for `login`, when they use it too: in their home on the
 *  CLI's default folder, in the folder itself for their `CLAUDE_CONFIG_DIR`. Undefined for AgentRun's own login. */
const sharedAccount = (login: ClaudeAgentLogin): string | undefined => (login.home !== undefined ? join(login.home, ".claude.json") : login.shared ? join(login.dir, ".claude.json") : undefined);

/** A new folder `to` holding a copy of the account file `from`, or nothing when there is none. `from` is only read. */
function accountCopy(from: string, to: string): string {
  mkdirSync(to, { mode: 0o700 });
  let account: Buffer | undefined;
  try {
    account = readFileSync(from);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (account) writeFileSync(join(to, ".claude.json"), account, { mode: 0o600, flag: "wx" });
  return to;
}

/** Ask the CLI at `cli` whether it is signed in at `login`: `auth status --json`, with only PATH and the login's
 *  variables beside it, in a folder of its own (`scratch`, one per check, removed after it answers or throws). The CLI
 *  rewrites its account file (`.claude.json`, in its config dir) whenever that file's migration number is not its own,
 *  and adds a settings file, a backup and a lock beside it the first time, so the check never runs it on a file the
 *  person's own CLI keeps:
 *  - AgentRun's own login: the sign-in's variables (signInEnv), so it reads the account `auth login` left in the login's
 *    folder, in an empty home inside `scratch`.
 *  - A login the person's own CLI uses too (the default folder, `home`; their `CLAUDE_CONFIG_DIR`, `shared`): the config
 *    dir is a copy of their account file inside `scratch`, and the credentials dir is a run's (loginEnv), which reaches
 *    the tokens they keep without the folder as config dir. On the default folder it runs in their home, elsewhere in an
 *    empty one inside `scratch`.
 *  A status check is no session: nothing resumes in its config dir. `platform`: the one the CLI runs on, this host's.
 *  Throws when the CLI gives no answer that reads as one. */
export async function claudeLoginStatus(cli: string, login: ClaudeAgentLogin, options: { timeoutMs?: number; path?: string; platform?: NodeJS.Platform } = {}): Promise<ClaudeLoginStatus> {
  const scratch = mkdtempSync(join(tmpdir(), "agentrun-claude-status-"));
  try {
    const account = sharedAccount(login);
    const ownHome = { HOME: scratch, XDG_CONFIG_HOME: join(scratch, ".config") };
    const where = account === undefined
      ? { ...ownHome, ...signInEnv(login) }
      : { ...(login.home === undefined ? ownHome : { HOME: login.home }), ...loginEnv(login, options.platform), CLAUDE_CONFIG_DIR: accountCopy(account, join(scratch, "config")) };
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(cli, ["auth", "status", "--json"], {
        env: { PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", ...where, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: options.timeoutMs ?? LOGIN_STATUS_MS,
      });
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (out.length < 64 * 1024) out += chunk;
      });
      child.once("error", reject);
      // The CLI exits 1 when signed out, its answer said all the same.
      child.once("close", () => resolve(out));
    });
    const status = parseLoginStatus(stdout.trim());
    if (!status) throw new Error("the claude CLI gave no login status");
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

/** Start the CLI's own sign-in at `login` (`auth login`), with the line's own variables (signInEnv) in the person's home
 *  (`home`) and desktop (`display`): it opens a browser on this machine and keeps what it gets in the login's folder.
 *  Nothing of it is read here: its output goes nowhere. It is ended after `timeoutMs` (SIGN_IN_MS by default), which
 *  `ended` says apart from any other end. */
export function startClaudeLogin(cli: string, login: ClaudeAgentLogin, options: { timeoutMs?: number; path?: string; home?: string; display?: Readonly<Record<string, string | undefined>> } = {}): ClaudeSignIn {
  // What a browser needs to open on this desktop, when the server has it.
  const display = Object.fromEntries(["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "BROWSER"].flatMap((name) => {
    const value = options.display?.[name];
    return typeof value === "string" ? [[name, value]] : [];
  }));
  let settle!: (end: ClaudeSignInEnd) => void;
  const ended = new Promise<ClaudeSignInEnd>((resolve) => { settle = resolve; });
  const failed = (error: unknown): ClaudeSignInEnd => ({ end: "failed", message: String((error as Error)?.message ?? error).slice(0, 200) });
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cli, ["auth", "login", "--claudeai"], {
      env: { PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", HOME: options.home ?? homedir(), ...display, ...signInEnv(login), DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
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
