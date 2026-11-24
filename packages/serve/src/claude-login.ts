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
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
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
type Setting = { v: 1; place: LoginPlace; host: string; only_me: true };

/** This machine's own Claude Code login folder as the CLI finds it for the server's user, by the CLI's own rule: its
 *  config dir is `CLAUDE_CONFIG_DIR` when set, else `~/.claude`, and its credentials are kept there too unless
 *  `CLAUDE_SECURESTORAGE_CONFIG_DIR` says otherwise. Read from the server's env, so a Claude Code started with another
 *  `CLAUDE_CONFIG_DIR` is found only when AgentRun was started with it as well. A relative one is not taken: the CLI would
 *  read it against a working directory this server does not share. `source` says which rule gave the folder. */
export function machineFolder(env: Readonly<Record<string, string | undefined>> = process.env): { folder: string; source: "CLAUDE_CONFIG_DIR" | "default" } {
  if (env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR)) return { folder: env.CLAUDE_CONFIG_DIR, source: "CLAUDE_CONFIG_DIR" };
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  return { folder: join(home, ".claude"), source: "default" };
}

/** The directories of a login at `place`: AgentRun's in `data`, or this machine's (machineFolder, and the Anthropic
 *  profiles where the CLI looks for them: `ANTHROPIC_CONFIG_DIR`, else `$XDG_CONFIG_HOME/anthropic`, else
 *  `~/.config/anthropic`). This machine's on the CLI's default folder carries the person's home too, so the harness
 *  points the CLI at it as their own CLI runs, with no folder variable (the harness's signInEnv and loginEnv). This
 *  machine's is `shared` with the person's own CLI, so a status check runs on a copy of its account file
 *  (the harness's claudeLoginStatus). */
export function loginAt(place: LoginPlace, data: string, env: Readonly<Record<string, string | undefined>> = process.env): ClaudeAgentLogin {
  if (place === "agentrun") return { dir: join(data, "claude-login"), profiles: join(data, "claude-login", "anthropic") };
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  const { folder, source } = machineFolder(env);
  return { dir: folder, profiles: env.ANTHROPIC_CONFIG_DIR && isAbsolute(env.ANTHROPIC_CONFIG_DIR) ? env.ANTHROPIC_CONFIG_DIR : join(config, "anthropic"), ...(source === "default" ? { home } : {}), shared: true };
}

/** The setting as saved, or undefined when the mode is not on (or the row is not one this reads). */
export async function claudeLoginSetting(settings: Pick<Settings, "get">): Promise<Setting | undefined> {
  const row = (await settings.get(CLAUDE_LOGIN_SETTING)) as Partial<Setting> | null | undefined;
  if (!row || row.v !== 1 || !LOGIN_PLACES.includes(row.place as LoginPlace) || typeof row.host !== "string" || row.only_me !== true) return undefined;
  return row as Setting;
}

/** The login a run here goes on: the setting's, when the switch is not off and this is the machine it was turned on for. */
export function loginOf(setting: Setting | undefined, data: string, env: Readonly<Record<string, string | undefined>>): ClaudeAgentLogin | undefined {
  if (!setting || claudeLoginOff(env) || setting.host !== hostname()) return undefined;
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
  /** This machine's own Claude Code login as this server finds it (machineFolder). */
  machine: { folder: string; source: "CLAUDE_CONFIG_DIR" | "default" };
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

/** The setting a turn-on saves, for this machine. AgentRun's own login directory is made (0700) so the CLI can keep its
 *  login there; nothing in it is read. */
export function settingFor(place: LoginPlace, data: string): Setting {
  if (place === "agentrun") mkdirSync(join(data, "claude-login"), { recursive: true, mode: 0o700 });
  return { v: 1, place, host: hostname(), only_me: true };
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
 *  claudeLoginStatus and startClaudeLogin. `changed`: env read again after a turn on or off. `signIns`: the sign-in this
 *  server started, one per server process (claude-sign-in.ts). */
export type ClaudeLoginDeps = {
  signIns: ClaudeSignIns;
  settings: Pick<Settings, "get" | "put" | "remove">;
  data: string;
  env: Readonly<Record<string, string | undefined>>;
  pinned: () => Promise<string | undefined>;
  refused: string | undefined;
  sameMachine: boolean;
  claude: () => Promise<ClaudeLoginCli>;
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
  if (setting.host !== hostname()) return { state: "other_machine", ...base, can_start: false };
  if (!cli) return { state: "no_cli", ...base };
  try {
    const said = await (await deps.claude()).claudeLoginStatus(cli, login, pathOf(deps.env));
    return said.signedIn ? { state: "signed_in", ...base, account: accountOf(said) } : { state: "signed_out", ...base };
  } catch {
    return { state: "unknown", ...base };
  }
}

/** PUT /settings/claude-login: turned on, refused in one line where more than one person can start runs. */
export async function turnOnClaudeLogin(deps: ClaudeLoginDeps, body: unknown): Promise<ClaudeLoginView> {
  if (deps.refused) throw new ClaudeLoginRefused("forbidden", deps.refused);
  const asked = turnOnBody(body);
  if ("problem" in asked) throw new ClaudeLoginRefused("input_invalid", asked.problem);
  await deps.settings.put(CLAUDE_LOGIN_SETTING, settingFor(asked.place, deps.data));
  await deps.changed();
  return claudeLoginView(deps);
}

/** DELETE /settings/claude-login: turned off, and a sign-in this server started that still waits is ended. The login
 *  itself stays as the CLI keeps it; nothing here signs it out. */
export async function turnOffClaudeLogin(deps: ClaudeLoginDeps): Promise<ClaudeLoginView> {
  await deps.signIns.stop();
  await deps.settings.remove(CLAUDE_LOGIN_SETTING);
  await deps.changed();
  return claudeLoginView(deps);
}

/** POST /settings/claude-login/login: the CLI's own sign-in, started on this machine, where it opens a browser, with the
 *  shown line's own variables (the harness's signInEnv), so it signs in where the status reads. A sign-in that
 *  still waits is ended first (deps.signIns). The browser code goes to the CLI, never here; the answer is the view as it
 *  is when the sign-in starts, its `sign_in` waiting. */
export async function startLoginHere(deps: ClaudeLoginDeps): Promise<ClaudeLoginView> {
  if (deps.refused) throw new ClaudeLoginRefused("forbidden", deps.refused);
  const setting = await claudeLoginSetting(deps.settings);
  if (!setting) throw new ClaudeLoginRefused("agent_not_runnable", "Turn on Claude Code's login on this machine first.");
  if (setting.host !== hostname()) throw new ClaudeLoginRefused("agent_not_runnable", "It was turned on for another machine: sign in there.");
  if (!deps.sameMachine) throw new ClaudeLoginRefused("forbidden", "The CLI's sign-in opens a browser on the server's machine: run the command shown in a terminal there.");
  const cli = loginCli(await deps.pinned(), deps.env);
  if (!cli) throw new ClaudeLoginRefused("agent_not_runnable", "No Claude Code CLI here yet: claude-agent's first run installs it, or run the command shown.");
  // The person's home and desktop, so the CLI can open their browser.
  const claude = await deps.claude();
  const login = loginAt(setting.place, deps.data, deps.env);
  await deps.signIns.start((timeoutMs) => claude.startClaudeLogin(cli, login, { ...pathOf(deps.env), ...(deps.env.HOME ? { home: deps.env.HOME } : {}), display: deps.env, timeoutMs }));
  return claudeLoginView(deps);
}

/** At the server's start: a setting saved where the mode is now off or refused (`why`: the switch, a listen address past
 *  loopback, a second token, the API-only profile) goes, so no runner, in this process or another, runs on it; the reason
 *  is logged. */
export async function dropRefusedLogin(settings: Pick<Settings, "get" | "remove">, why: string | undefined, log: (line: string) => void): Promise<void> {
  if (!why || !(await claudeLoginSetting(settings))) return;
  await settings.remove(CLAUDE_LOGIN_SETTING);
  log(`Claude Code's login on this machine turned off: ${why}`);
}

/** What the routes and a run's check use of the harness (its login.ts), loaded only when asked. */
export type ClaudeLoginCli = Pick<typeof import("@parcha/agentrun-harness-claude"), "claudeLoginStatus" | "startClaudeLogin" | "claudeLoginCommand">;
const pathOf = (env: Readonly<Record<string, string | undefined>>): { path?: string } => (env.PATH ? { path: env.PATH } : {});

/** How long a signed-in answer stands for the next run on the same login and CLI, so a burst of runs asks the CLI once. */
export const LOGIN_SIGNED_IN_MS = 60_000;

/** The status checks asked, by CLI and login: one still out is shared by every run that asks meanwhile, and a signed-in
 *  answer is kept for LOGIN_SIGNED_IN_MS after it came. A signed-out answer or a failed check is never kept. */
const asked = new Map<string, { at: number; said: Promise<ClaudeLoginStatus>; signedIn?: true }>();
function statusOnce(cli: string, login: ClaudeAgentLogin, status: (cli: string, login: ClaudeAgentLogin) => Promise<ClaudeLoginStatus>, now: () => number): Promise<ClaudeLoginStatus> {
  const key = JSON.stringify([cli, login.dir, login.profiles]);
  const last = asked.get(key);
  if (last && (!last.signedIn || now() - last.at < LOGIN_SIGNED_IN_MS)) return last.said;
  const entry: { at: number; said: Promise<ClaudeLoginStatus>; signedIn?: true } = { at: now(), said: status(cli, login) };
  asked.set(key, entry);
  const forget = () => { if (asked.get(key) === entry) asked.delete(key); };
  entry.said.then((said) => (said.signedIn ? Object.assign(entry, { at: now(), signedIn: true as const }) : forget()), forget);
  return entry.said;
}

/** The harness's LoginStatusTimeout, read by its name: the harness is loaded only when a run asks. */
const timedOut = (error: unknown): boolean => error instanceof Error && error.name === "LoginStatusTimeout";

/** Before a run on the login: its CLI says it is signed in, or the run is refused in words (never a silent switch to a
 *  key). `cli`: the CLI that answers (loginCli); none, nothing to ask yet. `status`: the CLI's status check (the harness's
 *  claudeLoginStatus). A check the CLI didn't answer in time is asked once more; a second one doesn't refuse the run, as
 *  a slow host isn't a signed-out login: the run goes on with the login alone, and a CLI that isn't signed in says so in
 *  the run. A signed-out answer, or one that reads as none, still refuses it. */
export async function loginBeforeRun(login: ClaudeAgentLogin | undefined, cli: string | undefined, status: (cli: string, login: ClaudeAgentLogin) => Promise<ClaudeLoginStatus>, options: { now?: () => number } = {}): Promise<void> {
  if (!login || !cli) return;
  const now = options.now ?? Date.now;
  let said: ClaudeLoginStatus | undefined;
  for (let attempt = 1; !said; attempt++) {
    try {
      said = await statusOnce(cli, login, status, now);
    } catch (error) {
      if (!timedOut(error)) throw new Error(`${LOGIN_UNKNOWN}: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
      if (attempt === 2) return;
    }
  }
  if (!said.signedIn) throw new Error(LOGIN_SIGNED_OUT);
}
