// Claude Code's login on this machine as claude-agent's model source: a person's own Claude plan, used by the pinned
// Claude Code CLI as that CLI always uses it. AgentRun never reads, copies, stores, proxies or relays the login or a
// browser code: the CLI keeps it in its own files and calls Anthropic with it itself (the harness's login.ts). This
// server only tells the CLI where its login is, asks it for its status (`claude auth status`), and keeps one setting: that
// the owner turned the mode on, where the login is, and on which machine.
//
// One switch (AGENTRUN_CLAUDE_CODE_LOGIN): unset, the mode is there only on a server that listens on loopback, so a
// server bound past it (0.0.0.0 in a container, a hosted service) has it off with nothing to set; `off` or `on` says so
// outright. Off, the Settings row is gone, every route here answers 404, a saved turn-on is dropped at the start, and
// harness selection reads no setting, so claude-agent runs on the model keys as it does without the mode. The mode is
// for a server one person runs: it is refused where more than one person can start runs, `on` included, and the owner
// confirms they alone run agents here. It runs only in a runner place, on the machine the owner turned it on for.
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { ClaudeAgentLogin, ClaudeLoginStatus } from "@parcha/agentrun-harness-claude";
import { facts as claudeFacts } from "@parcha/agentrun-harness-claude/facts";
import { registerSecretWrite } from "./secret-writes.js";
import type { ClaudeSignIns, SignInView } from "./claude-sign-in.js";
import type { Settings } from "./store/index.js";

// Every operation here is the owner's session's alone (secret-writes.ts): no answer holds a credential, but turning a
// person's plan on for this server's runs, and starting its sign-in, are the owner's to do.
for (const operation of ["getClaudeLogin", "turnOnClaudeLogin", "turnOffClaudeLogin", "startClaudeLogin"]) registerSecretWrite(operation, () => true);

/** The switch: `off` (or 0, false, no) turns the mode off on this server, `on` (or 1, true, yes) leaves it there past
 *  loopback; unset, the listen address decides (claudeLoginSwitchedOff). */
export const CLAUDE_LOGIN_ENV = "AGENTRUN_CLAUDE_CODE_LOGIN";
export const claudeLoginOff = (env: Readonly<Record<string, string | undefined>>): boolean => /^(off|0|false|no)$/i.test((env[CLAUDE_LOGIN_ENV] ?? "").trim());
const claudeLoginOn = (env: Readonly<Record<string, string | undefined>>): boolean => /^(on|1|true|yes)$/i.test((env[CLAUDE_LOGIN_ENV] ?? "").trim());
export const loopback = (host: string): boolean => host === "localhost" || host === "::1" || /^127\./.test(host); // key-gate: loopback-rule the default follows a loopback listen address

/** Why the mode is off on a server listening on `listen`, or undefined where it is there: the switch's `off`, or, unset,
 *  a listen address past loopback. */
export function claudeLoginSwitchedOff(env: Readonly<Record<string, string | undefined>>, listen: string): string | undefined {
  if (claudeLoginOff(env)) return `${CLAUDE_LOGIN_ENV}=off`;
  if (claudeLoginOn(env) || loopback(listen)) return undefined;
  return `it listens on ${listen}, past loopback; ${CLAUDE_LOGIN_ENV}=on turns it on`;
}

/** The setting row: the mode on, where the login is, and the machine it was turned on for. */
export const CLAUDE_LOGIN_SETTING = "claude_login";
/** The harness that runs on the login: claude-agent, whose pinned CLI holds it. */
export const LOGIN_HARNESS: string = claudeFacts.id;
const LOGIN_HARNESSES: readonly string[] = Object.freeze([LOGIN_HARNESS]);
/** The provider a run on the login is priced under (provider.ts): billed to the person's plan, never priced here. */
export const CLAUDE_LOGIN_PROVIDER = "claude-login";
/** The model a run on the login gets when it names none. */
export const LOGIN_DEFAULT_MODEL = "anthropic/claude-sonnet-5-5";

/** Where the login is: AgentRun's own directory in its data (`agentrun`, the default), or this machine's own Claude Code
 *  login (`machine`, which the owner opts into by name). */
export const LOGIN_PLACES = ["agentrun", "machine"] as const;
export type LoginPlace = (typeof LOGIN_PLACES)[number];
/** `machine`: the id of the machine it was turned on for (machineId). A row saved before the id has none, and reads as
 *  turned on for another machine until turned on again. */
type Setting = { v: 1; place: LoginPlace; machine?: string; only_me: true };

/** The file in the data folder that holds this machine's id (machineId). */
export const MACHINE_ID_FILE = "machine-id";
const MACHINE_ID = /^[0-9a-f]{32}$/;

/** This machine's id, which names the machine the login was turned on for: a random one, made once in
 *  `<data>/machine-id` (0600) and read back by every later start. Never the hostname, which moves with the network (a
 *  laptop's at home is not its name at the office), while the data folder stays. A missing file, or one that holds no
 *  id or can't be read, gets a fresh id, so a setting saved under the old one reads as another machine's until turned on
 *  again. The file appears whole: written aside, then linked in place, so a start beside this one that made an id first
 *  keeps its own, and both read that one. */
export function machineId(data: string): string {
  const file = join(data, MACHINE_ID_FILE);
  const read = (): string | undefined => {
    try {
      const id = readFileSync(file, "utf8").trim();
      return MACHINE_ID.test(id) ? id : undefined;
    } catch {
      return undefined;
    }
  };
  const known = read();
  if (known) return known;
  const id = randomBytes(16).toString("hex");
  const aside = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(aside, `${id}\n`, { mode: 0o600, flag: "wx" });
  try {
    // The umask may take more than 0600 leaves; never less.
    chmodSync(aside, 0o600);
    try {
      linkSync(aside, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another start made one first: that one. Else what is there holds no id, and this one takes its place.
      const theirs = read();
      if (theirs) return theirs;
      renameSync(aside, file);
    }
  } finally {
    rmSync(aside, { force: true });
  }
  return id;
}

/** This machine's own Claude Code login folder as the CLI finds it for the server's user, by the CLI's own rule: its
 *  config dir is `CLAUDE_CONFIG_DIR` when set, else `~/.claude`, and its credentials are kept there too unless
 *  `CLAUDE_SECURESTORAGE_CONFIG_DIR` says otherwise. Read from the server's env, so a Claude Code started with another
 *  `CLAUDE_CONFIG_DIR` is found only when AgentRun was started with it as well. A relative one is not taken: the CLI would
 *  read it against a working directory this server does not share. `source` says which rule gave the folder.
 *  `credentials`: the server's `CLAUDE_SECURESTORAGE_CONFIG_DIR` when it sets one the CLI takes as it is (an absolute
 *  path, or empty: `~/.claude`, and on macOS the Keychain item with no suffix), where the CLI keeps the tokens apart
 *  from the folder; a relative one is not taken, as above. */
export function machineFolder(env: Readonly<Record<string, string | undefined>> = process.env): { folder: string; source: "CLAUDE_CONFIG_DIR" | "default"; credentials?: string } {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const credentials = secure === "" || (secure && isAbsolute(secure)) ? { credentials: secure } : {};
  if (env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR)) return { folder: env.CLAUDE_CONFIG_DIR, source: "CLAUDE_CONFIG_DIR", ...credentials };
  return { folder: join(homeOf(env), ".claude"), source: "default", ...credentials };
}

/** The person's home as the server's env says it: its `HOME` when absolute, else `os.homedir()`. The person's own CLI
 *  reads its home as Node does (`os.homedir()`, which is `HOME` when set), so the two agree for the server's own env;
 *  reading the env handed in first keeps it the one source a test or an embedding host can set. */
const homeOf = (env: Readonly<Record<string, string | undefined>>): string => (env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir());

/** The directories of a login at `place`: AgentRun's in `data`, or this machine's (machineFolder, and the Anthropic
 *  profiles where the CLI looks for them: `ANTHROPIC_CONFIG_DIR`, else `$XDG_CONFIG_HOME/anthropic`, else
 *  `~/.config/anthropic`). This machine's on the CLI's default folder carries the person's home too, so the harness
 *  points the CLI at it as their own CLI runs, with no folder variable (the harness's signInEnv and loginEnv). This
 *  machine's with a credentials dir in the server's env (machineFolder's `credentials`) carries it as `secure`, absolute
 *  (empty: `~/.claude`, `unsuffixed`), so the CLI keeps the tokens where the person's own CLI with it does. A status
 *  check at either place runs on a copy of the account file (the harness's claudeLoginStatus). Every login carries the
 *  person's home as `userHome`, read here once (homeOf), so the status check, the sign-in and a run on macOS all run in
 *  that one home whatever reads it later (the harness's personHome). */
export function loginAt(place: LoginPlace, data: string, env: Readonly<Record<string, string | undefined>> = process.env): ClaudeAgentLogin {
  const home = homeOf(env);
  if (place === "agentrun") return { dir: join(data, "claude-login"), profiles: join(data, "claude-login", "anthropic"), userHome: home };
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  const { folder, source, credentials } = machineFolder(env);
  const secure = credentials === undefined ? {} : credentials === "" ? { secure: join(home, ".claude"), unsuffixed: true } : { secure: credentials };
  return { dir: folder, profiles: env.ANTHROPIC_CONFIG_DIR && isAbsolute(env.ANTHROPIC_CONFIG_DIR) ? env.ANTHROPIC_CONFIG_DIR : join(config, "anthropic"), ...(source === "default" ? { home } : {}), ...secure, userHome: home };
}

/** The setting as saved, or undefined when the mode is not on (or the row is not one this reads). */
export async function claudeLoginSetting(settings: Pick<Settings, "get">): Promise<Setting | undefined> {
  const row = (await settings.get(CLAUDE_LOGIN_SETTING)) as Partial<Setting> | null | undefined;
  if (!row || row.v !== 1 || !LOGIN_PLACES.includes(row.place as LoginPlace) || (row.machine !== undefined && typeof row.machine !== "string") || row.only_me !== true) return undefined;
  return row as Setting;
}

/** Whether `setting` was turned on for this machine: the one whose data folder (`data`) holds its id (machineId). */
const thisMachine = (setting: Setting, data: string): boolean => setting.machine === machineId(data);

/** The login a run here goes on: the setting's, when the switch is not off and this is the machine it was turned on for. */
export function loginOf(setting: Setting | undefined, data: string, env: Readonly<Record<string, string | undefined>>): ClaudeAgentLogin | undefined {
  if (!setting || claudeLoginOff(env) || !thisMachine(setting, data)) return undefined;
  return loginAt(setting.place, data, env);
}

const LOGIN = Symbol.for("agentrun.claude-login");

/** `env` carrying `login` (none: carrying none), as an enumerable symbol property: a spread keeps it, a spawn never sees
 *  it (it is no variable), and it holds only two directory names. */
export function withClaudeLogin<T extends object>(env: T, login: ClaudeAgentLogin | undefined): T {
  if (login) Object.defineProperty(env, LOGIN, { value: Object.freeze({ ...login }), enumerable: true, configurable: true, writable: false });
  else delete (env as Record<symbol, unknown>)[LOGIN];
  return env;
}

/** `env` as a run at `place` reads it: a runner place keeps the login; any other place (a sandbox) gets a copy without it,
 *  so a revision's checks there ask for a key, as its run will. */
export function envAtPlace<T extends object>(env: T, place: { readonly mode: string } | undefined): T {
  if (place?.mode === "runner" || (env as Record<symbol, unknown>)[LOGIN] === undefined) return env;
  return withClaudeLogin({ ...env }, undefined);
}

/** The login `env` carries, unless the switch is off. */
export function claudeLoginOf(env: NodeJS.ProcessEnv): ClaudeAgentLogin | undefined {
  if (claudeLoginOff(env)) return undefined;
  return (env as Record<symbol, ClaudeAgentLogin | undefined>)[LOGIN];
}

/** Whether `harness` runs on the login `env` carries. */
export const onClaudeLogin = (env: NodeJS.ProcessEnv, harness: string): boolean => LOGIN_HARNESSES.includes(harness) && claudeLoginOf(env) !== undefined;

/** The CLI that answers for a login: the pinned one this server installed for claude-agent (`pinned`), else a `claude` on
 *  PATH, else none. */
export function loginCli(pinned: string | undefined, env: Readonly<Record<string, string | undefined>>): string | undefined {
  if (pinned && existsSync(pinned)) return pinned;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** The words a run gets when the login is signed out, and when its CLI could not say. */
export const LOGIN_SIGNED_OUT = "Claude Code's login on this machine is signed out: sign in under Settings → Model keys, or turn the mode off there to run claude-agent on a model key.";
export const LOGIN_UNKNOWN = "Claude Code could not say whether its login on this machine is signed in";

/** Why this server may not turn the mode on, in one line, or undefined when it may: a Claude plan is one person's. */
export function whyNotOneOwner(facts: { apiOnly: boolean; tokens: number }): string | undefined {
  if (facts.apiOnly) return "This server has no owner (the API-only profile), so anyone with its token starts runs: a Claude plan is one person's.";
  if (facts.tokens > 1) return `This server takes ${facts.tokens} API tokens, so more than one person can start runs here: a Claude plan is one person's.`;
  return undefined;
}

/** GET /settings/claude-login. `state`: `off` (not turned on), `other_machine` (turned on for another machine), else
 *  what the CLI says: `signed_in`, `signed_out`, or `no_cli` (no CLI here to ask yet: claude-agent's first run installs
 *  the pinned one), `unknown` (it gave no answer). Never a token: an account's email, organization and plan only when
 *  the CLI says them. */
export type ClaudeLoginView = {
  state: "off" | "other_machine" | "signed_in" | "signed_out" | "no_cli" | "unknown";
  place: LoginPlace;
  /** The line that signs the CLI in at the login's place, for a terminal on this machine. */
  command: string;
  /** Whether this server may start the CLI's own sign-in itself (a browser on this machine). */
  can_start: boolean;
  /** Why the mode can't be turned on here, in one line. */
  refused?: string;
  account?: { method?: string; email?: string; organization?: string; plan?: string };
  /** The folder whose login the CLI is asked about: the login's directory at `place`. */
  folder: string;
  /** This machine's own Claude Code login as this server finds it (machineFolder), with `credentials` where the server's
   *  env sets `CLAUDE_SECURESTORAGE_CONFIG_DIR` (empty included). */
  machine: { folder: string; source: "CLAUDE_CONFIG_DIR" | "default"; credentials?: string };
  /** The CLI's sign-in this server started, while this server runs (claude-sign-in.ts). */
  sign_in?: SignInView;
};

/** The account's words, as the view shows them. */
export const accountOf = (status: ClaudeLoginStatus): NonNullable<ClaudeLoginView["account"]> => ({ ...(status.method ? { method: status.method } : {}), ...(status.email ? { email: status.email } : {}), ...(status.organization ? { organization: status.organization } : {}), ...(status.plan ? { plan: status.plan } : {}) });

/** The body of a turn-on, checked: where the login is, and the owner's word that they alone run agents here. */
export function turnOnBody(body: unknown): { place: LoginPlace } | { problem: string } {
  const given = (body ?? {}) as { place?: unknown; only_me?: unknown };
  if (given.place !== undefined && !LOGIN_PLACES.includes(given.place as LoginPlace)) return { problem: `place is one of ${LOGIN_PLACES.join(", ")}` };
  if (given.only_me !== true) return { problem: "only_me must be true: confirm you alone run agents on this server, since its runs would use your Claude plan" };
  return { place: (given.place as LoginPlace | undefined) ?? "agentrun" };
}

/** The setting a turn-on saves, for this machine (machineId). AgentRun's own login directory is made (0700) so the CLI
 *  can keep its login there; nothing in it is read. */
export function settingFor(place: LoginPlace, data: string): Setting {
  if (place === "agentrun") mkdirSync(join(data, "claude-login"), { recursive: true, mode: 0o700 });
  return { v: 1, place, machine: machineId(data), only_me: true };
}

/** The login a run of `harness` on this runner goes on: the saved setting's, read now, when the switch is not off, the
 *  harness runs on it, the run is in a runner place (`place`), and this is the machine it was turned on for; else none,
 *  and the run goes on the model keys. */
export async function loginForRun(settings: Pick<Settings, "get">, data: string, env: Readonly<Record<string, string | undefined>>, harness: string | undefined, place: { readonly mode: string }): Promise<ClaudeAgentLogin | undefined> {
  if (harness === undefined || !LOGIN_HARNESSES.includes(harness) || claudeLoginOff(env) || place.mode !== "runner") return undefined;
  return loginOf(await claudeLoginSetting(settings), data, env);
}

/** The routes here (server.ts): every one answers 404, by its name, while the mode is off (`why`). */
export const CLAUDE_LOGIN_ROUTES: ReadonlySet<string> = new Set(["getClaudeLogin", "turnOnClaudeLogin", "turnOffClaudeLogin", "startClaudeLogin"]);
export const claudeLoginRouteOff = (name: string, why: string): string => `${name}: Claude Code's login on this machine is off on this server: ${why}.`;

/** What the routes need of the server. `pinned`: the pinned CLI's path when installed. `refused`: whyNotOneOwner of this
 *  server. `sameMachine`: the request comes from a browser on this machine to a server bound to loopback with no public
 *  address, so a sign-in the CLI opens in a browser here reaches the person. `status`/`start`: the harness's
 *  claudeLoginStatus and startClaudeLogin. `saved`: the login runs here go on after a turn on or off (none once off),
 *  handed over inside the turn that saved it, so two changes never leave the server's copy out of order. `changed`: env
 *  read again after that turn, outside the queue, so a sign-in pressed meanwhile never waits on it. `signIns`: the
 *  sign-in this server started, one per server process (claude-sign-in.ts). */
export type ClaudeLoginDeps = {
  signIns: ClaudeSignIns;
  settings: Pick<Settings, "get" | "put" | "remove">;
  data: string;
  env: Readonly<Record<string, string | undefined>>;
  pinned: () => Promise<string | undefined>;
  refused: string | undefined;
  sameMachine: boolean;
  claude: () => Promise<ClaudeLoginCli>;
  saved: (login: ClaudeAgentLogin | undefined) => void;
  changed: () => Promise<void>;
};

/** A route's refusal in words, answered as its `code` (server.ts makes it an ApiError). */
export class ClaudeLoginRefused extends Error {
  constructor(
    readonly code: "forbidden" | "input_invalid" | "agent_not_runnable",
    message: string,
  ) {
    super(message);
  }
}

/** GET /settings/claude-login: the mode's state and, when on, what the CLI says of its login. */
export async function claudeLoginView(deps: ClaudeLoginDeps): Promise<ClaudeLoginView> {
  const setting = await claudeLoginSetting(deps.settings);
  const place = setting?.place ?? "agentrun";
  const login = loginAt(place, deps.data, deps.env);
  const cli = loginCli(await deps.pinned(), deps.env);
  const signIn = deps.signIns.view();
  const base = { place, command: (await deps.claude()).claudeLoginCommand(login, cli ?? "claude"), can_start: deps.sameMachine && cli !== undefined && deps.refused === undefined, ...(deps.refused ? { refused: deps.refused } : {}), folder: login.dir, machine: machineFolder(deps.env), ...(signIn ? { sign_in: signIn } : {}) };
  if (!setting) return { state: "off", ...base };
  if (!thisMachine(setting, deps.data)) return { state: "other_machine", ...base, can_start: false };
  if (!cli) return { state: "no_cli", ...base };
  try {
    // Asked once: a person waits on this read. Its answer is a run's too (loginBeforeRun), so one who just saw the
    // login signed in here has a run on a slow host go on.
    const said = await (await deps.claude()).claudeLoginStatus(cli, login, pathOf(deps.env));
    noteAnswer(login, said, Date.now());
    return said.signedIn ? { state: "signed_in", ...base, account: accountOf(said) } : { state: "signed_out", ...base };
  } catch {
    return { state: "unknown", ...base };
  }
}

/** PUT /settings/claude-login: turned on, refused in one line where more than one person can start runs. A turn-on that
 *  moves the login to another place first ends a sign-in this server started that still waits: its CLI signs in at the
 *  old place, which the login no longer reads. One at the same place leaves it waiting, as it still signs in there. */
export async function turnOnClaudeLogin(deps: ClaudeLoginDeps, body: unknown): Promise<ClaudeLoginView> {
  if (deps.refused) throw new ClaudeLoginRefused("forbidden", deps.refused);
  const asked = turnOnBody(body);
  if ("problem" in asked) throw new ClaudeLoginRefused("input_invalid", asked.problem);
  await deps.signIns.serial(async (turn) => {
    if ((await claudeLoginSetting(deps.settings))?.place !== asked.place) await turn.stop();
    const setting = settingFor(asked.place, deps.data);
    await deps.settings.put(CLAUDE_LOGIN_SETTING, setting);
    deps.saved(loginOf(setting, deps.data, deps.env));
  });
  await deps.changed();
  return claudeLoginView(deps);
}

/** DELETE /settings/claude-login: turned off, and a sign-in this server started that still waits is ended. The login
 *  itself stays as the CLI keeps it; nothing here signs it out. */
export async function turnOffClaudeLogin(deps: ClaudeLoginDeps): Promise<ClaudeLoginView> {
  await deps.signIns.serial(async (turn) => {
    await turn.stop();
    await deps.settings.remove(CLAUDE_LOGIN_SETTING);
    deps.saved(undefined);
  });
  await deps.changed();
  return claudeLoginView(deps);
}

/** POST /settings/claude-login/login: the CLI's own sign-in, started on this machine, where it opens a browser, with the
 *  shown line's own variables (the harness's signInEnv), so it signs in where the status reads. A sign-in that
 *  still waits is ended first (deps.signIns). The browser code goes to the CLI, never here; the answer is the view as it
 *  is when the sign-in starts, its `sign_in` waiting. The setting is read, and the CLI started on it, in one turn. */
export async function startLoginHere(deps: ClaudeLoginDeps): Promise<ClaudeLoginView> {
  if (deps.refused) throw new ClaudeLoginRefused("forbidden", deps.refused);
  await deps.signIns.serial(async (signIn) => {
    const setting = await claudeLoginSetting(deps.settings);
    if (!setting) throw new ClaudeLoginRefused("agent_not_runnable", "Turn on Claude Code's login on this machine first.");
    if (!thisMachine(setting, deps.data)) throw new ClaudeLoginRefused("agent_not_runnable", "It was turned on for another machine: sign in there.");
    if (!deps.sameMachine) throw new ClaudeLoginRefused("forbidden", "The CLI's sign-in opens a browser on the server's machine: run the command shown in a terminal there.");
    const cli = loginCli(await deps.pinned(), deps.env);
    if (!cli) throw new ClaudeLoginRefused("agent_not_runnable", "No Claude Code CLI here yet: claude-agent's first run installs it, or run the command shown.");
    // The person's home (the login's `userHome`) and desktop, so the CLI can open their browser.
    const claude = await deps.claude();
    const login = loginAt(setting.place, deps.data, deps.env);
    await signIn.start((timeoutMs) => claude.startClaudeLogin(cli, login, { ...pathOf(deps.env), display: deps.env, timeoutMs }));
  });
  return claudeLoginView(deps);
}

/** At the server's start: a setting saved where the mode is now off or refused (`why`: the switch, a listen address past
 *  loopback, a second token, the API-only profile) goes, so no runner, in this process or another, runs on it; the reason
 *  is logged. A turn on `signIns`' queue, as every change of the setting is. */
export async function dropRefusedLogin(signIns: Pick<ClaudeSignIns, "serial">, settings: Pick<Settings, "get" | "remove">, why: string | undefined, log: (line: string) => void): Promise<void> {
  if (!why) return;
  await signIns.serial(async () => {
    if (!(await claudeLoginSetting(settings))) return;
    await settings.remove(CLAUDE_LOGIN_SETTING);
    log(`Claude Code's login on this machine turned off: ${why}`);
  });
}

/** What the routes and a run's check use of the harness (its login.ts), loaded only when asked. */
export type ClaudeLoginCli = Pick<typeof import("@parcha/agentrun-harness-claude"), "claudeLoginStatus" | "startClaudeLogin" | "claudeLoginCommand">;
const pathOf = (env: Readonly<Record<string, string | undefined>>): { path?: string } => (env.PATH ? { path: env.PATH } : {});

/** How long a signed-in answer stands in for a check that gives none (loginBeforeRun). */
export const LOGIN_ANSWER_STANDS_MS = 10 * 60_000;

/** When each login last answered signed in, in this server process: in memory only, never on disk, and nothing but the
 *  time. A signed-out answer removes its entry. */
const signedInAt = new Map<string, number>();

/** What tells one login from another here: its folder and its credentials dir. */
const loginKey = (login: ClaudeAgentLogin): string => JSON.stringify([login.dir, login.secure ?? null, login.unsuffixed === true]);

/** Notes what the CLI said of `login` at `now`: signed in, the time; signed out, nothing (the earlier time goes). */
function noteAnswer(login: ClaudeAgentLogin, said: ClaudeLoginStatus, now: number): void {
  if (said.signedIn) signedInAt.set(loginKey(login), now);
  else signedInAt.delete(loginKey(login));
}

/** The harness's codes for a status check that gave no answer (claudeLoginStatus's ClaudeLoginTimedOut and
 *  ClaudeLoginNoStatus), read by code as the harness loads only when asked. */
const NO_ANSWER: ReadonlySet<unknown> = new Set(["timed_out", "no_status"]);
const gaveNoAnswer = (error: unknown): boolean => NO_ANSWER.has((error as { code?: unknown } | null | undefined)?.code);

/** The run's refusal when its login's CLI could not say, with the check's own words. */
const unknownLogin = (error: unknown): Error => new Error(`${LOGIN_UNKNOWN}: ${String((error as Error | null | undefined)?.message ?? error).slice(0, 200)}`);

/** Before a run on the login: its CLI says it is signed in, or the run is refused in words (never a silent switch to a
 *  key). `cli`: the CLI that answers (loginCli); none, nothing to ask yet. `status`: the CLI's status check (the harness's
 *  claudeLoginStatus, which asks once and, when the CLI gives no answer, throws with `code` "timed_out" or "no_status").
 *  A check that gives no answer (it timed out, or the CLI said nothing that reads as a status) is asked once more, since
 *  a loaded host can take past the limit with the login fine. Still none: the run goes on when this login answered
 *  signed in within LOGIN_ANSWER_STANDS_MS in this server process (a run's check here, or the Settings view's), as its
 *  own CLI still fails in words if the login is gone; else it is refused with LOGIN_UNKNOWN and why. Any other failure (a
 *  CLI that is not at its path, say) is refused with LOGIN_UNKNOWN and its own words at once, asked once and never
 *  waved through by an earlier answer. A signed-out answer is the answer: never asked again nor overridden, refused at
 *  once, and the earlier signed-in time goes. `now`: the clock (Date.now). */
export async function loginBeforeRun(login: ClaudeAgentLogin | undefined, cli: string | undefined, status: (cli: string, login: ClaudeAgentLogin) => Promise<ClaudeLoginStatus>, options: { now?: () => number } = {}): Promise<void> {
  if (!login || !cli) return;
  const now = options.now ?? Date.now;
  let said: ClaudeLoginStatus | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2 && said === undefined; attempt++) {
    try {
      said = await status(cli, login);
    } catch (error) {
      if (!gaveNoAnswer(error)) throw unknownLogin(error);
      lastError = error;
    }
  }
  if (said === undefined) {
    const at = signedInAt.get(loginKey(login));
    if (at !== undefined && now() - at <= LOGIN_ANSWER_STANDS_MS) return;
    throw unknownLogin(lastError);
  }
  noteAnswer(login, said, now());
  if (!said.signedIn) throw new Error(LOGIN_SIGNED_OUT);
}
