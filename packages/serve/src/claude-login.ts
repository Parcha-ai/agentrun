// Claude Code's login on this machine as claude-agent's model source: a person's own Claude plan, used by the pinned
// Claude Code CLI as that CLI always uses it. AgentRun never copies, stores, proxies or relays the login or a browser
// code: the CLI keeps it in its own files and calls Anthropic with it itself (the harness's login.ts). This server tells
// the CLI where its login is, asks it for its status (`claude auth status`), and keeps one setting: that the owner turned
// the mode on, where the login is, and on which machine. Where each run is a user of its own, the runner reads AgentRun's
// own login folder, renews it there in the CLI's place, with the CLI's own request and lock, and a run gets only its
// access token (claude-login-token.ts).
//
// One switch (AGENTRUN_CLAUDE_CODE_LOGIN): unset, the mode is there only on a server that listens on loopback, so a
// server bound past it (0.0.0.0 in a container, a hosted service) has it off with nothing to set; `off` or `on` says so
// outright. Off, the Settings row is gone, every route here answers 404, a saved turn-on is dropped at the start, and
// harness selection reads no setting, so claude-agent runs on the model keys as it does without the mode. The mode is
// for a server one person runs: it is refused where more than one person can start runs, `on` included, and the owner
// confirms they alone run agents here. It runs only in a runner place, on the machine the owner turned it on for.
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { ClaudeAgentLogin, ClaudeLoginStatus, ClaudeLoginToken } from "@parcha/agentrun-harness-claude";
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
/** Whether a run of the login's harness that names `model` goes on the login: one naming none (it gets
 *  LOGIN_DEFAULT_MODEL, Anthropic's) or one of Anthropic's own (`anthropic/<id>`). Any other, Anthropic's through
 *  OpenRouter (`openrouter/anthropic/<id>`) included, goes on its provider's key whatever the login says. providerFor
 *  puts a run on the login by this rule, and loginOnRunnerOnly offers the move to the runner by it. The console reads no
 *  server code: its lib/claudeLogin.ts loginServes copies this, and both tests name the same cases. */
export const loginServes = (model: string | undefined): boolean => !model || model.startsWith("anthropic/");

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
 *  from the folder; a relative one is not taken, as above. `uid`: the server's user, whose home (homeOf) holds the
 *  default folder. For the view alone: the folder is the real path this machine's login has (loginAt) where its user may
 *  use it, else the folder as the env names it (givenFolder). Nothing a CLI is handed comes from here. */
export function machineFolder(env: Readonly<Record<string, string | undefined>> = process.env, uid: number | undefined = process.geteuid?.()): { folder: string; source: "CLAUDE_CONFIG_DIR" | "default"; credentials?: string } {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const credentials = secure === "" || (secure && isAbsolute(secure)) ? { credentials: secure } : {};
  const folder = loginAt("machine", "", env, uid).login?.dir ?? givenFolder("machine", "", env);
  return { folder, source: absolute(env, "CLAUDE_CONFIG_DIR") ? "CLAUDE_CONFIG_DIR" : "default", ...credentials };
}

/** AgentRun's own login directory in the data folder `data`. */
export const agentRunLoginDir = (data: string): string => join(data, "claude-login");

/** The login's folder at `place` as the env names it, for the view to show where the login is refused: AgentRun's own
 *  in `data`, or this machine's `CLAUDE_CONFIG_DIR`, else `~/.claude` in the env's HOME. Never handed to a CLI. */
const givenFolder = (place: LoginPlace, data: string, env: Readonly<Record<string, string | undefined>>): string => (place === "agentrun" ? agentRunLoginDir(data) : (absolute(env, "CLAUDE_CONFIG_DIR") ?? join(absolute(env, "HOME") ?? homedir(), ".claude")));

/** The env's `name` when it is an absolute path, else undefined. */
const absolute = (env: Readonly<Record<string, string | undefined>>, name: string): string | undefined => {
  const value = env[name];
  return value && isAbsolute(value) ? value : undefined;
};

/** The most links one path may pass through, as Linux's own limit (past it, ELOOP). */
const MAX_LINKS = 40;
/** A folder's mode bits that let its group write in it, and anyone, and the sticky bit, which keeps each entry in such a
 *  folder its maker's (/tmp, say). */
const GROUP_WRITE = 0o020;
const OTHER_WRITE = 0o002;
const STICKY = 0o1000;
/** The system's account files: its users (name:password:uid:gid:…) and its groups (name:password:gid:members). */
const PASSWD_FILE = "/etc/passwd";
const GROUP_FILE = "/etc/group";

/** A whole decimal id from an account file's field, else undefined (an empty field is no id). */
const idOf = (field: string | undefined): number | undefined => (field !== undefined && /^\d+$/.test(field) ? Number(field) : undefined);

/** Whether group `gid` is user `uid`'s private group, so a folder only its group and its owner may write in is still the
 *  user's alone (the umask ruling: a umask of 002, under a group of the user's own, makes folders 0775). As the account
 *  files say: `uid` has one entry, and `gid` is its primary group; no other user has `gid` as theirs; and the group file
 *  has `gid`, listing no member but that user. False where it cannot say: a file it cannot read, a `+` or `-` line (the
 *  rest is a directory service's, whose members these files do not show), no entry for `uid`, or `gid` missing from the
 *  group file (a directory service's group). */
function privateGroup(uid: number, gid: number): boolean {
  try {
    const entries = (file: string) => readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "" && !line.startsWith("#"));
    const users = entries(PASSWD_FILE);
    const groups = entries(GROUP_FILE);
    if ([...users, ...groups].some((line) => line.startsWith("+") || line.startsWith("-"))) return false;
    const userFields = users.map((line) => line.split(":"));
    const own = userFields.filter((fields) => idOf(fields[2]) === uid);
    const name = own.length === 1 ? own[0]![0] : undefined;
    if (!name || idOf(own[0]![3]) !== gid) return false;
    if (userFields.some((fields) => fields !== own[0] && idOf(fields[3]) === gid)) return false;
    const its = groups.map((line) => line.split(":")).filter((fields) => idOf(fields[2]) === gid);
    return its.length > 0 && its.every((fields) => (fields[3] ?? "").split(",").map((member) => member.trim()).every((member) => member === "" || member === name));
  } catch {
    return false;
  }
}

/** Whether a folder with `mode` and group `gid` lets someone other than user `uid` write in it: anyone may, or its group
 *  may and that group is not the user's private one (privateGroup, asked once per group by `mine`). */
const openToOthers = (folder: { mode: number; gid: number }, mine: (gid: number) => boolean): boolean =>
  (folder.mode & OTHER_WRITE) !== 0 || ((folder.mode & GROUP_WRITE) !== 0 && !mine(folder.gid));

/** privateGroup for user `uid`, each group asked once: one walk (ownedFolder) reads the account files only where a folder
 *  its group may write in is met, and once per group. */
function privateGroupsOf(uid: number): (gid: number) => boolean {
  const known = new Map<number, boolean>();
  return (gid) => {
    let mine = known.get(gid);
    if (mine === undefined) known.set(gid, (mine = privateGroup(uid, gid)));
    return mine;
  };
}

/** `dir` (absolute) walked one name at a time from the root, as the system walks it: an empty name (a trailing or
 *  doubled slash) and `.` name nothing, `..` goes to the folder above the real one reached so far, and each link is followed where it is met, and must be one user `uid` or root made, as must each
 *  link in the chain it leads through (another user's could be pointed elsewhere once this has looked). Gives the real
 *  folder the walk ends in (`real`: no link on its way) and the names still to make in it (`missing`, none where `dir`
 *  is there), or undefined where a link fails, a name past one still to make is `..` (from a link), or there is no way
 *  to look. */
function followLinks(uid: number, dir: string): { real: string; missing: string[] } | undefined {
  try {
    const names = dir.split("/");
    let real = "/";
    let links = 0;
    for (let name = names.shift(); name !== undefined; name = names.shift()) {
      if (name === "" || name === ".") continue;
      if (name === "..") {
        real = dirname(real);
        continue;
      }
      const next = join(real, name);
      const entry = lstatSync(next, { throwIfNoEntry: false });
      if (entry === undefined) {
        const missing = [name, ...names].filter((left) => left !== "" && left !== ".");
        return missing.includes("..") ? undefined : { real, missing };
      }
      if (!entry.isSymbolicLink()) {
        real = next;
        continue;
      }
      if ((entry.uid !== uid && entry.uid !== 0) || ++links > MAX_LINKS) return undefined;
      const target = readlinkSync(next);
      if (isAbsolute(target)) real = "/";
      names.unshift(...target.split("/"));
    }
    return { real, missing: [] };
  } catch {
    // A file where a folder should be, or no way to look.
    return undefined;
  }
}

/** Why a folder is not the login's (ownedFolder): `owned`, it is not the user's own (another user's, through another
 *  user's link or folder, or no way to look); `open`, `at` (a folder on its way, the folder itself, or the one it is to
 *  be made in) has `mode`, which anyone may write in, or its group, where that group is not the user's private one
 *  (openToOthers), so a chmod of `at` mends it. Only the mode bits are
 *  read: an ACL that grants another user writes and leaves them alone (macOS's `chmod +a`) is not seen, and a FUSE
 *  mount another user may let others into (`allow_other`) says what owner and mode it likes. */
type NotHeld = { not: "owned" } | { not: "open"; at: string; mode: number };

/** Undefined where no user but `uid` and root can change what `real` (a real path, followLinks') leads to: each folder
 *  above it, from the root down, is a folder (no link) of that user's or root's that no one else may write in (anyone,
 *  or its group where that is not the user's private one: openToOthers, with `mine`), unless the sticky bit keeps each
 *  entry there its maker's. Else why not: a folder not theirs first, as a chmod mends no such folder, else the nearest
 *  open one. */
function wayHeld(uid: number, real: string, mine: (gid: number) => boolean): NotHeld | undefined {
  try {
    let open: NotHeld | undefined;
    for (let at = dirname(real), last = real; at !== last; last = at, at = dirname(at)) {
      const folder = lstatSync(at);
      if (!folder.isDirectory() || (folder.uid !== uid && folder.uid !== 0)) return { not: "owned" };
      if ((folder.mode & STICKY) === 0 && openToOthers(folder, mine)) open ??= { not: "open", at, mode: folder.mode };
    }
    return open;
  } catch {
    return { not: "owned" };
  }
}

/** Undefined where `real` is a folder (no link) of user `uid`'s that no one else may write in (openToOthers, with
 *  `mine`), sticky or not: they could put files of theirs in it, or, where the CLI makes a folder in it, make that
 *  folder first. Else why not. */
function heldFolder(uid: number, real: string, mine: (gid: number) => boolean): NotHeld | undefined {
  try {
    const folder = lstatSync(real);
    if (!folder.isDirectory() || folder.uid !== uid) return { not: "owned" };
    return openToOthers(folder, mine) ? { not: "open", at: real, mode: folder.mode } : undefined;
  } catch {
    return { not: "owned" };
  }
}

/** The end of the words a folder open to others' writes (NotHeld's `open`) is refused in: which folder, its mode, and
 *  the chmod that closes it. */
const openWords = (open: { at: string; mode: number }): string =>
  `is open to writes by others than its owner: ${open.at} has mode ${(open.mode & 0o7777).toString(8).padStart(4, "0")}, which its group or anyone may write in. Make it writable by its owner alone (chmod g-w,o-w ${open.at}): a umask of 002 makes new folders so.`;

/** The folder `dir` names, as the CLI is to get it, where it is one user `uid` owns; else why not. `dir` is walked as
 *  the system walks it, one name at a time (followLinks: a trailing slash or `.` names nothing, and a `..` goes up from
 *  the real folder reached so far, past any link, never from the text), so no slash hides a link and the folder is the
 *  one the CLI given `dir` would reach. Every link on its way is judged and followed, every folder above the real folder it leads to is held (wayHeld), and that folder
 *  is the user's own (heldFolder). `make`: where `dir` is not there yet, the nearest folder above it that is must be the
 *  user's own (heldFolder), since the CLI, run as that user, makes the rest there. The answer is the real path (no link
 *  left on it, plus the names still to make), which is what the login hands the CLI, so a link changed after this has
 *  looked redirects nothing, and no other user can change a folder on the way. This is the one ownership rule for the
 *  login's folders, the home's (homeOf) and those the env gives it (loginAt). `missing`: some of the folder is still to
 *  make. Else why not (NotHeld). */
function ownedFolder(uid: number, dir: string, make: boolean): { real: string; missing: boolean; not?: undefined } | NotHeld {
  if (!isAbsolute(dir)) return { not: "owned" };
  const walked = followLinks(uid, dir);
  if (walked === undefined || (walked.missing.length > 0 && !make)) return { not: "owned" };
  // A folder that is not the user's first, as a chmod mends no such folder; else the open one.
  const mine = privateGroupsOf(uid);
  const way = wayHeld(uid, walked.real, mine);
  const folder = heldFolder(uid, walked.real, mine);
  const notHeld = way?.not === "owned" ? way : folder?.not === "owned" ? folder : (way ?? folder);
  if (notHeld) return notHeld;
  return walked.missing.length > 0 ? { real: join(walked.real, ...walked.missing), missing: true } : { real: walked.real, missing: false };
}

/** The user `uid` as a refusal names it: its uid, and its name where this process runs as it. */
function userWords(uid: number): string {
  try {
    const user = userInfo();
    if (user.uid === uid && user.username) return `uid ${uid} (${user.username})`;
  } catch {
    // No entry for this user on this system.
  }
  return `uid ${uid}`;
}

/** The person's home: the home of the user this server runs as (`uid`, its effective uid), whose files the login's CLI
 *  writes. The env's `HOME` when it is an absolute path to a folder that user owns (ownedFolder), else that user's own
 *  home as the system has it (`os.userInfo()`), when it owns that; either as its real path (ownedFolder's), which the
 *  CLI is handed. So a server under a sudo that keeps `HOME` (root, with the person's) keeps its login in root's home,
 *  never root-owned files in the person's, and a service account that inherited someone's `HOME` reads its own. `apart`:
 *  the env gave a `HOME` and it was not that user's, so a terminal with that env's `HOME` is not in this home either,
 *  and the line the view shows carries it (the harness's loginCommand). Neither: `refused` says why in words, and there
 *  is no home. Each folder is walked once here (ownedFolder), and the home given is the walk's real path. Where there
 *  is no uid (Windows), the env's `HOME` when absolute, else `os.homedir()`. */
export function homeOf(env: Readonly<Record<string, string | undefined>>, uid: number | undefined = process.geteuid?.()): { home: string; apart?: true; refused?: undefined } | { home?: undefined; refused: string } {
  const given = absolute(env, "HOME");
  if (uid === undefined) return { home: given ?? homedir() };
  const fromEnv = given === undefined ? undefined : ownedFolder(uid, given, false);
  if (fromEnv && fromEnv.not === undefined) return { home: fromEnv.real };
  let own: string | undefined;
  try {
    own = userInfo().homedir || undefined;
  } catch {
    // No entry for this user on this system.
  }
  const fromOwn = own === undefined ? undefined : ownedFolder(uid, own, false);
  if (fromOwn && fromOwn.not === undefined) return { home: fromOwn.real, ...(given ? { apart: true as const } : {}) };
  // A home that is the user's but open to others' writes says so, and how to close it: the env's HOME first.
  const open = fromEnv?.not === "open" ? { which: "its HOME", home: given, ...fromEnv } : fromOwn?.not === "open" ? { which: "that user's own home", home: own, ...fromOwn } : undefined;
  if (open) return { refused: `Claude Code's login on this machine needs a home only this server's user may write in: it runs as ${userWords(uid)}, and ${open.which} (${open.home}) ${openWords(open)}` };
  return {
    refused: `Claude Code's login on this machine needs a home this server's user owns: it runs as ${userWords(uid)}, and neither its HOME (${env.HOME || "unset"}) nor that user's own home (${own ?? "none on this system"}) is a folder it owns. Start the server as the person whose Claude plan it is.`,
  };
}

/** The folders the server's env gives this machine's login (loginAt), each with the variable that gives it: its config
 *  dir (`CLAUDE_CONFIG_DIR`), its credentials dir (`CLAUDE_SECURESTORAGE_CONFIG_DIR`, when absolute) and its profiles
 *  (`ANTHROPIC_CONFIG_DIR`, else `XDG_CONFIG_HOME`'s `anthropic`). Those the CLI takes from the home are not here: the
 *  home is homeOf's. */
function envFolders(env: Readonly<Record<string, string | undefined>>): Array<readonly [name: string, folder: string]> {
  const folders: Array<readonly [string, string]> = [];
  const config = absolute(env, "CLAUDE_CONFIG_DIR");
  if (config) folders.push(["CLAUDE_CONFIG_DIR", config]);
  const secure = absolute(env, "CLAUDE_SECURESTORAGE_CONFIG_DIR");
  if (secure) folders.push(["CLAUDE_SECURESTORAGE_CONFIG_DIR", secure]);
  const profiles = absolute(env, "ANTHROPIC_CONFIG_DIR");
  const xdg = absolute(env, "XDG_CONFIG_HOME");
  if (profiles) folders.push(["ANTHROPIC_CONFIG_DIR", profiles]);
  else if (xdg) folders.push(["XDG_CONFIG_HOME", join(xdg, "anthropic")]);
  return folders;
}

/** Why a login at `place` may not be used by this server's user (`uid`, its effective uid), in words; undefined when it
 *  may: loginAt's `refused`. `place` undefined (not known yet) asks the home alone, as AgentRun's own login does. A
 *  decision that hands a CLI a login takes it from loginAt itself, never from this and a second look. */
export function loginRefused(place: LoginPlace | undefined, env: Readonly<Record<string, string | undefined>>, uid: number | undefined = process.geteuid?.()): string | undefined {
  return loginAt(place ?? "agentrun", "", env, uid).refused;
}

/** A login at a place as its check gives it (loginAt): the login, or why its server's user may not use it. `toMake`:
 *  the folders the env gives the login that are still to make, at their real paths, each in a folder that user owns. */
export type LoginAt = { login: ClaudeAgentLogin; toMake: readonly string[]; refused?: undefined } | { login?: undefined; toMake?: undefined; refused: string };

/** The login at `place` and the check of its folders, from one look at each (one walk, ownedFolder), so what a caller
 *  hands a CLI is what was checked: the login, or `refused`, why the server's user (`uid`, its effective uid unless
 *  given) may not use it, in words, and then no login at all, never one on the paths as given. The home first (homeOf).
 *  Then, for this machine's login, each folder the env gives it (envFolders): one the user owns, or would make in a
 *  folder it owns, on a way no other user can change (ownedFolder), else the CLI run as that user (root under a sudo
 *  that keeps the env, say) leaves its files in another user's folder, or in one another user can swap for theirs.
 *  AgentRun's own login keeps its folders in its data. Where there is no uid (Windows), nothing is refused, and the
 *  folders are as given.
 *
 *  The directories: AgentRun's in `data`, or this machine's (machineFolder's rule, and the Anthropic profiles where the
 *  CLI looks for them: `ANTHROPIC_CONFIG_DIR`, else `$XDG_CONFIG_HOME/anthropic`, else `~/.config/anthropic`). This
 *  machine's on the CLI's default folder carries the person's home too, so the harness points the CLI at it as their
 *  own CLI runs, with no folder variable (the harness's signInEnv and loginEnv). This machine's with a credentials dir
 *  in the server's env (machineFolder's `credentials`) carries it as `secure`, absolute (empty: `~/.claude`,
 *  `unsuffixed`), so the CLI keeps the tokens where the person's own CLI with it does. A status check at either place
 *  runs on a copy of the account file (the harness's claudeLoginStatus). Every login carries the person's home as
 *  `userHome`, read here once (homeOf), so the status check, the sign-in and a run on macOS all run in that one home
 *  whatever reads it later (the harness's personHome), and `homeApart` where the env's HOME was not that home (homeOf's
 *  `apart`). The home and the folders the env gives are the real paths the walk ended in. */
export function loginAt(place: LoginPlace, data: string, env: Readonly<Record<string, string | undefined>> = process.env, uid: number | undefined = process.geteuid?.()): LoginAt {
  const checked = homeOf(env, uid);
  if (checked.refused !== undefined) return { refused: checked.refused };
  const { home, apart } = checked;
  const homeAt = { userHome: home, ...(apart ? { homeApart: true } : {}) };
  if (place === "agentrun") return { login: { dir: agentRunLoginDir(data), profiles: join(agentRunLoginDir(data), "anthropic"), ...homeAt }, toMake: [] };
  const real = new Map<string, string>();
  const toMake: string[] = [];
  for (const [name, folder] of envFolders(env)) {
    if (uid === undefined) {
      real.set(name, folder);
      continue;
    }
    const owned = ownedFolder(uid, folder, true);
    const refused = `Claude Code's login on this machine needs its folders to be this server's user's own: it runs as ${userWords(uid)}, and ${folder}, the folder ${name} gives it,`;
    if (owned.not === "open") return { refused: `${refused} ${openWords(owned)}` };
    if (owned.not === "owned") return { refused: `${refused} is not a folder it owns, nor one it would make in a folder it owns. Start the server as the person whose Claude plan it is.` };
    real.set(name, owned.real);
    if (owned.missing) toMake.push(owned.real);
  }
  const config = real.get("CLAUDE_CONFIG_DIR");
  const credentials = env.CLAUDE_SECURESTORAGE_CONFIG_DIR === "" ? join(home, ".claude") : real.get("CLAUDE_SECURESTORAGE_CONFIG_DIR");
  const secure = credentials === undefined ? {} : { secure: credentials, ...(env.CLAUDE_SECURESTORAGE_CONFIG_DIR === "" ? { unsuffixed: true } : {}) };
  const profiles = real.get("ANTHROPIC_CONFIG_DIR") ?? real.get("XDG_CONFIG_HOME") ?? join(home, ".config", "anthropic");
  return { login: { dir: config ?? join(home, ".claude"), profiles, ...(config === undefined ? { home } : {}), ...secure, ...homeAt }, toMake };
}

/** The setting as saved, or undefined when the mode is not on (or the row is not one this reads). */
export async function claudeLoginSetting(settings: Pick<Settings, "get">): Promise<Setting | undefined> {
  const row = (await settings.get(CLAUDE_LOGIN_SETTING)) as Partial<Setting> | null | undefined;
  if (!row || row.v !== 1 || !LOGIN_PLACES.includes(row.place as LoginPlace) || (row.machine !== undefined && typeof row.machine !== "string") || row.only_me !== true) return undefined;
  return row as Setting;
}

/** Whether `setting` was turned on for this machine: the one whose data folder (`data`) holds its id (machineId). */
const thisMachine = (setting: Setting, data: string): boolean => setting.machine === machineId(data);

/** The login a run here goes on: the setting's, when the switch is not off, this is the machine it was turned on for,
 *  and the server's user (`uid`, its effective uid unless given) may use its folders: loginAt's login, from its one look
 *  at them. */
export function loginOf(setting: Setting | undefined, data: string, env: Readonly<Record<string, string | undefined>>, uid: number | undefined = process.geteuid?.()): ClaudeAgentLogin | undefined {
  if (!setting || claudeLoginOff(env) || !thisMachine(setting, data)) return undefined;
  return loginAt(setting.place, data, env, uid).login;
}

const LOGIN = Symbol.for("agentrun.claude-login");

/** A login as a run holds it: its two directories, or, in a run's own process under a user of its own, its runner's
 *  reader of its access token (held.ts claudeLogin). */
export type RunLogin = ClaudeAgentLogin | ClaudeLoginToken;

/** Whether `login` is a reader of its access token, not its directories. */
export const loginByToken = (login: RunLogin): login is ClaudeLoginToken => typeof (login as { token?: unknown }).token === "function";

/** `env` carrying `login` (none: carrying none), as an enumerable symbol property: a spread keeps it, a spawn never sees
 *  it (it is no variable), and it holds two directory names or a token reader, never a token. */
export function withClaudeLogin<T extends object>(env: T, login: RunLogin | undefined): T {
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
export function claudeLoginOf(env: NodeJS.ProcessEnv): RunLogin | undefined {
  if (claudeLoginOff(env)) return undefined;
  return (env as Record<symbol, RunLogin | undefined>)[LOGIN];
}

/** Whether `harness` runs on the login `env` carries. */
export const onClaudeLogin = (env: NodeJS.ProcessEnv, harness: string): boolean => LOGIN_HARNESSES.includes(harness) && claudeLoginOf(env) !== undefined;

/** For a run refused for its model: the words that say why the login `env` carries does not run it, when its harness
 *  runs on that login, the login would run its `model` (loginServes: Anthropic's own, or none), and its place is a box
 *  (the login is a model only on the runner, loginForRun), naming the box and the move that runs it there; else
 *  undefined. A model the login never runs (an OpenRouter one) still needs its key after a move, so none is offered. The
 *  login's state is not asked: a signed-out one fails a run on the runner in its own words. */
export function loginOnRunnerOnly(env: NodeJS.ProcessEnv, harness: string | undefined, model: string | undefined, place: { readonly mode: string; readonly box?: string } | undefined): string | undefined {
  if (harness === undefined || !onClaudeLogin(env, harness) || !loginServes(model) || place === undefined || place.mode === "runner") return undefined;
  return `Claude Code's login on this machine runs agents on the runner only, and this agent runs in the ${place.box ?? place.mode} box: move it to the runner to run it on the login, or add a key.`;
}

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
export function whyNotOneOwner(facts: { apiOnly: boolean; tokens: number; keys?: number; keysDormant?: boolean }): string | undefined {
  if (facts.apiOnly) return "This server has no owner (the API-only profile), so anyone with its token starts runs: a Claude plan is one person's.";
  if (facts.tokens > 1) return `This server takes ${facts.tokens} API tokens, so more than one person can start runs here: a Claude plan is one person's.`;
  // A key made in the console for an app (api-keys.ts) is one more caller that starts runs, as a second token is.
  // `keysDormant`: the keys open nothing on this server (api-keys.ts dormant), and would at a start that takes them.
  const keys = facts.keys ?? 0;
  if (keys > 0) {
    const [what, it] = keys === 1 ? ["an API key", "it"] : [`${keys} API keys`, "them"];
    return facts.keysDormant
      ? `This server keeps ${what} made for apps (Settings → AgentRun API keys). ${keys === 1 ? "It opens" : "They open"} nothing here, and would open the server at a start that takes keys again: a Claude plan is one person's. Revoke ${it} first.`
      : `This server has ${what} made for apps (Settings → AgentRun API keys), so more than one caller can start runs here: a Claude plan is one person's. Revoke ${it} first.`;
  }
  return undefined;
}

/** Why a server with Claude Code's login on makes no API key for an app, in one line: the same rule from the other side. */
export const LOGIN_REFUSES_API_KEYS = "Claude Code's login on this machine is on, and a Claude plan is one person's: an API key would let an app start runs on it. Turn the login off under Settings → Model keys first.";

/** GET /settings/claude-login. `state`: `off` (not turned on), `other_machine` (turned on for another machine),
 *  `refused` (turned on for this machine and kept, but its folders are ones this server's user may not use: `refused`
 *  says why, nothing runs on it, and a turn-off removes it as it does any other), else what the CLI says: `signed_in`,
 *  `signed_out`, or `no_cli` (no CLI here to ask yet: claude-agent's first run installs the pinned one), `unknown` (it
 *  gave no answer). Never a token: an account's email, organization and plan only when the CLI says them. */
export type ClaudeLoginView = {
  state: "off" | "other_machine" | "refused" | "signed_in" | "signed_out" | "no_cli" | "unknown";
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
  if (place === "agentrun") mkdirSync(agentRunLoginDir(data), { recursive: true, mode: 0o700 });
  return { v: 1, place, machine: machineId(data), only_me: true };
}

/** The login a run of `harness` on this runner goes on: the saved setting's, read now, when the switch is not off, the
 *  harness runs on it, the run is in a runner place (`place`), and this is the machine it was turned on for; else none,
 *  and the run goes on the model keys. `uid`: as loginOf's. */
export async function loginForRun(settings: Pick<Settings, "get">, data: string, env: Readonly<Record<string, string | undefined>>, harness: string | undefined, place: { readonly mode: string }, uid: number | undefined = process.geteuid?.()): Promise<ClaudeAgentLogin | undefined> {
  if (harness === undefined || !LOGIN_HARNESSES.includes(harness) || claudeLoginOff(env) || place.mode !== "runner") return undefined;
  return loginOf(await claudeLoginSetting(settings), data, env, uid);
}

/** The routes here (server.ts): every one answers 404, by its name, while the mode is off (`why`). */
export const CLAUDE_LOGIN_ROUTES: ReadonlySet<string> = new Set(["getClaudeLogin", "turnOnClaudeLogin", "turnOffClaudeLogin", "startClaudeLogin"]);
/** Whether the claude-login routes answer here, the one rule the routes and capabilities' `features.claude_login` both
 *  read: none while the mode is switched off (`off`, claudeLoginSwitchedOff's reason), and on an API-only server
 *  (`apiOnlyRoutes`, the routes it serves) only if it serves them all. */
export const claudeLoginServed = (off: string | undefined, apiOnlyRoutes: ReadonlySet<string> | undefined): boolean =>
  !off && (!apiOnlyRoutes || [...CLAUDE_LOGIN_ROUTES].every((name) => apiOnlyRoutes.has(name)));
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
  /** Why this server may not turn the mode on now, asked each time and never held: the server's API keys are made and
   *  revoked while it runs (whyNotOneOwner counts them). */
  refused: () => string | undefined;
  /** Runs `work` once nothing that changes `refused` is under way, and holds such changes off until it settles: the
   *  API keys' turn (api-keys.ts inTurn). The turn-on decides and writes inside it. */
  turn: <T>(work: () => Promise<T>) => Promise<T>;
  sameMachine: boolean;
  claude: () => Promise<ClaudeLoginCli>;
  saved: (login: ClaudeAgentLogin | undefined) => void;
  changed: () => Promise<void>;
  /** The user this server runs as, whose home the login needs (homeOf): its effective uid unless given. */
  uid?: number;
};

/** Why the routes may not turn the mode on at `place`, or sign in there, now: the server's own refusal, else folders of
 *  the login its user may not use (loginRefused; `place` undefined, not known yet: the home alone). */
const refusedHere = (deps: ClaudeLoginDeps, place: LoginPlace | undefined): string | undefined => deps.refused() ?? loginRefused(place, deps.env, deps.uid);

/** A server's API keys as the login needs them (api-keys.ts ApiKeys): how many there are now, and their turn. */
export type KeysForLogin = { readonly count: number; inTurn<T>(work: () => Promise<T>): Promise<T> };

/** What the one-owner rule gives the login's routes over a server's keys: `refused`, which counts the keys each time
 *  it is asked, and `turn`, the keys' own. The server's routes take both from here, and so does the test that runs the
 *  turn-on against a held revocation: neither is a value read once, or a turn of its own. */
export const oneOwnerDeps = (facts: { apiOnly: boolean; tokens: number; keysDormant?: boolean }, keys: KeysForLogin): Pick<ClaudeLoginDeps, "refused" | "turn"> => ({
  refused: () => whyNotOneOwner({ ...facts, keys: keys.count }),
  turn: (work) => keys.inTurn(work),
});

/** The login `at` (loginAt's, at `place`, not refused) with its folders still to make made by AgentRun, 0700 whatever
 *  the umask, in the folders its check found the server's user's own (no other user can make them first there), and
 *  then checked again: the CLI is handed that check's login, or the route refuses in its words. Made so, a folder the
 *  CLI would make under a umask of 002 (0775, open to its group) is not refused once the CLI has signed in there, and the
 *  CLI, finding it made, leaves its mode. A folder that can't be made is left to the check again, and to the CLI. */
function madeLogin(at: Extract<LoginAt, { refused?: undefined }>, place: LoginPlace, deps: ClaudeLoginDeps): ClaudeAgentLogin {
  if (at.toMake.length === 0) return at.login;
  for (const folder of at.toMake) {
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
    } catch {
      // Left to the check again.
    }
  }
  const again = loginAt(place, deps.data, deps.env, deps.uid);
  if (again.refused !== undefined) throw new ClaudeLoginRefused("forbidden", again.refused);
  return again.login;
}

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
  // One look at the login's folders decides the line, the folder shown and the status check (loginAt). Where they are
  // refused there is no login: no line (it would sign in on folders the server's user may not use), and the folder is
  // shown as the env names it.
  const { login, refused: unusable } = loginAt(place, deps.data, deps.env, deps.uid);
  const cli = loginCli(await deps.pinned(), deps.env);
  const signIn = deps.signIns.view();
  const refused = deps.refused() ?? unusable;
  const base = { place, command: login ? (await deps.claude()).claudeLoginCommand(login, cli ?? "claude") : "", can_start: deps.sameMachine && cli !== undefined && refused === undefined, ...(refused ? { refused } : {}), folder: login?.dir ?? givenFolder(place, deps.data, deps.env), machine: machineFolder(deps.env, deps.uid), ...(signIn ? { sign_in: signIn } : {}) };
  if (!setting) return { state: "off", ...base };
  if (!thisMachine(setting, deps.data)) return { state: "other_machine", ...base, can_start: false };
  // Folders the server's user may not use: no login here (loginOf), and the CLI is not asked, since its check runs in
  // that home, on those folders. Still turned on (dropRefusedLogin keeps it), so the view says so with why, and the
  // owner can turn it off.
  if (!login) return { state: "refused", ...base };
  if (!cli) return { state: "no_cli", ...base };
  try {
    // Asked once: a person waits on this read. Its answer is a run's too (loginBeforeRun), so one who just saw the
    // login signed in here has a run on a slow host go on.
    const said = await (await deps.claude()).claudeLoginStatus(cli, login, pathOf(deps.env));
    noteAnswer(login, said, Date.now(), deps.data);
    return said.signedIn ? { state: "signed_in", ...base, account: accountOf(said) } : { state: "signed_out", ...base };
  } catch {
    return { state: "unknown", ...base };
  }
}

/** PUT /settings/claude-login: turned on, refused in one line where more than one person can start runs. A turn-on that
 *  moves the login to another place first ends a sign-in this server started that still waits: its CLI signs in at the
 *  old place, which the login no longer reads. One at the same place leaves it waiting, as it still signs in there. */
export async function turnOnClaudeLogin(deps: ClaudeLoginDeps, body: unknown): Promise<ClaudeLoginView> {
  // `refused` is asked only in the keys' turn (deps.turn), where a key being made or revoked has landed, or been undone.
  // Asked once before the sign-in is touched, so a turn-on refused or malformed then leaves a waiting sign-in as it was;
  // and again with the write, in one turn, so no key is made between the decision and the setting. A key made between
  // the two turns, on a turn-on that moves the place, is the one case that both stops the sign-in and refuses: nothing
  // is written, and the person starts the sign-in again once the key is revoked. The sign-in's stop and
  // what follows the write (the reading again, the CLI's status) are outside the keys' turn, so a key's revocation never
  // waits on the CLI.
  const refusal = (place: LoginPlace | undefined) => {
    const refused = refusedHere(deps, place);
    if (refused) throw new ClaudeLoginRefused("forbidden", refused);
  };
  const asked = await deps.turn(async () => {
    refusal(undefined);
    const asked = turnOnBody(body);
    if ("problem" in asked) throw new ClaudeLoginRefused("input_invalid", asked.problem);
    refusal(asked.place);
    return asked;
  });
  await deps.signIns.serial(async (turn) => {
    if ((await claudeLoginSetting(deps.settings))?.place !== asked.place) await turn.stop();
    await deps.turn(async () => {
      // The refusal and the login the server is handed are one look at the folders (loginAt).
      const refused = deps.refused();
      if (refused) throw new ClaudeLoginRefused("forbidden", refused);
      const at = loginAt(asked.place, deps.data, deps.env, deps.uid);
      if (at.refused !== undefined) throw new ClaudeLoginRefused("forbidden", at.refused);
      // Its folders still to make are made here (madeLogin), so a sign-in from the line shown finds them made 0700.
      const login = madeLogin(at, asked.place, deps);
      const setting = settingFor(asked.place, deps.data);
      await deps.settings.put(CLAUDE_LOGIN_SETTING, setting);
      deps.saved(claudeLoginOff(deps.env) ? undefined : login);
    });
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
  const refused = refusedHere(deps, undefined);
  if (refused) throw new ClaudeLoginRefused("forbidden", refused);
  await deps.signIns.serial(async (signIn) => {
    const setting = await claudeLoginSetting(deps.settings);
    if (!setting) throw new ClaudeLoginRefused("agent_not_runnable", "Turn on Claude Code's login on this machine first.");
    // The refusal and the login the CLI is started on are one look at the folders (loginAt).
    const at = loginAt(setting.place, deps.data, deps.env, deps.uid);
    if (at.refused !== undefined) throw new ClaudeLoginRefused("forbidden", at.refused);
    if (!thisMachine(setting, deps.data)) throw new ClaudeLoginRefused("agent_not_runnable", "It was turned on for another machine: sign in there.");
    if (!deps.sameMachine) throw new ClaudeLoginRefused("forbidden", "The CLI's sign-in opens a browser on the server's machine: run the command shown in a terminal there.");
    const cli = loginCli(await deps.pinned(), deps.env);
    if (!cli) throw new ClaudeLoginRefused("agent_not_runnable", "No Claude Code CLI here yet: claude-agent's first run installs it, or run the command shown.");
    // The person's home (the login's `userHome`) and desktop, so the CLI can open their browser.
    const claude = await deps.claude();
    // Its folders still to make are made first, and checked again (madeLogin): the CLI signs in on that check's login.
    const login = madeLogin(at, setting.place, deps);
    await signIn.start((timeoutMs) => claude.startClaudeLogin(cli, login, { ...pathOf(deps.env), display: deps.env, timeoutMs }));
  });
  return claudeLoginView(deps);
}

/** At the server's start: a setting saved where the mode is now off or refused (`why`: the switch, a listen address past
 *  loopback, a second token, the API-only profile) goes, so no runner, in this process or another, runs on it; the
 *  reason is logged. One whose folders the server's user may not use (loginRefused with `env`, for the setting's place)
 *  stays, and the reason is logged: every read refuses it in words while they are so (no run, no sign-in, the view's
 *  `refused`), and the person mends that with a chmod or by starting the server as the right user, which a deleted
 *  setting would have turned off for good, or turns it off (the view's `refused` state). A turn on `signIns`' queue, as
 *  every change of the setting is. */
export async function dropRefusedLogin(signIns: Pick<ClaudeSignIns, "serial">, settings: Pick<Settings, "get" | "remove">, why: string | undefined, env: Readonly<Record<string, string | undefined>>, log: (line: string) => void): Promise<void> {
  await signIns.serial(async () => {
    const setting = await claudeLoginSetting(settings);
    if (!setting) return;
    if (why) {
      await settings.remove(CLAUDE_LOGIN_SETTING);
      return log(`Claude Code's login on this machine turned off: ${why}`);
    }
    const refused = loginRefused(setting.place, env);
    if (refused) log(`Claude Code's login on this machine is kept, and not used while it is refused: ${refused}`);
  });
}

/** What the routes and a run's check use of the harness (its login.ts), loaded only when asked. */
export type ClaudeLoginCli = Pick<typeof import("@parcha/agentrun-harness-claude"), "claudeLoginStatus" | "startClaudeLogin" | "claudeLoginCommand">;
const pathOf = (env: Readonly<Record<string, string | undefined>>): { path?: string } => (env.PATH ? { path: env.PATH } : {});

/** How long a signed-in answer stands in for a check that gives none (loginBeforeRun). */
export const LOGIN_ANSWER_STANDS_MS = 10 * 60_000;

/** The folder in the data folder that holds, per login, when it last answered signed in (noteAnswer). The server and its
 *  runner may be two processes on one data folder (`--no-runner` beside `agentrun-serve runner`): the Settings view's
 *  answer is the server's, a run's check the runner's, so the answer is kept where both read it. */
export const LOGIN_ANSWERS_DIR = "claude-login-answers";

/** What tells one login from another here: its folder and its credentials dir. */
const loginKey = (login: ClaudeAgentLogin): string => JSON.stringify([login.dir, login.secure ?? null, login.unsuffixed === true]);

/** The file of `login`'s answer in `data`: named by a hash of this machine's id (machineId) and the login, so nothing of
 *  the login's paths is in its name, and an answer is only ever this machine's and this login's. */
const answerFile = (data: string, login: ClaudeAgentLogin): string => join(data, LOGIN_ANSWERS_DIR, createHash("sha256").update(JSON.stringify([machineId(data), loginKey(login)])).digest("hex").slice(0, 32));

/** The most an answer file holds: a time in milliseconds and a newline. A longer file is no note of ours. */
const ANSWER_MAX_BYTES = 32;

/** The answers folder in `data`, made 0700, or tightened to 0700 when it was there wider; false when what is at its name
 *  is not a folder (a link, say), which a note is never written through. */
function answersFolder(data: string): boolean {
  const dir = join(data, LOGIN_ANSWERS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const at = lstatSync(dir);
  if (!at.isDirectory()) return false;
  if ((at.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return true;
}

/** Notes what the CLI said of `login` at `now` in `data`: signed in, the time, alone, in a file of its own (0600, in a
 *  folder of 0700, answersFolder), written aside and renamed in place so a reader never sees half of it, the aside file
 *  removed when the rename fails; signed out, the file goes (the earlier time with it). The answer only spares a later
 *  run a refusal, so a note that can't be written is left out. */
function noteAnswer(login: ClaudeAgentLogin, said: ClaudeLoginStatus, now: number, data: string): void {
  try {
    const file = answerFile(data, login);
    if (!said.signedIn) return void rmSync(file, { force: true });
    if (!answersFolder(data)) return;
    const aside = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
      writeFileSync(aside, `${now}\n`, { mode: 0o600, flag: "wx" });
      renameSync(aside, file);
    } finally {
      rmSync(aside, { force: true });
    }
  } catch {
    // Not noted: a run whose checks give no answer is refused, as with no earlier answer.
  }
}

/** When `login` last answered signed in on this machine (noteAnswer), or undefined. Only a regular file at the answer's
 *  name, of at most ANSWER_MAX_BYTES, is read: a link there is not followed, and a FIFO opens without waiting (it would
 *  hold this read, on a run's start, for ever) and is no file, so neither is an answer. */
function signedInAt(data: string, login: ClaudeAgentLogin): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(answerFile(data, login), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const at = fstatSync(fd);
    if (!at.isFile() || at.size > ANSWER_MAX_BYTES) return undefined;
    const bytes = Buffer.alloc(ANSWER_MAX_BYTES + 1);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    if (read > ANSWER_MAX_BYTES) return undefined;
    const time = Number(bytes.subarray(0, read).toString("utf8").trim());
    return Number.isSafeInteger(time) ? time : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
 *  signed in on this machine within LOGIN_ANSWER_STANDS_MS (a run's check, or the Settings view's, in this process or
 *  another on the same data folder, `data`), as its own CLI still fails in words if the login is gone; else it is
 *  refused with LOGIN_UNKNOWN and why. Any other failure (a CLI that is not at its path, say) is refused with
 *  LOGIN_UNKNOWN and its own words at once, asked once and never waved through by an earlier answer. A signed-out answer
 *  is the answer: never asked again nor overridden, refused at once, and the earlier signed-in time goes. `now`: the
 *  clock (Date.now). */
export async function loginBeforeRun(login: ClaudeAgentLogin | undefined, cli: string | undefined, status: (cli: string, login: ClaudeAgentLogin) => Promise<ClaudeLoginStatus>, options: { data: string; now?: () => number }): Promise<void> {
  if (!login || !cli) return;
  const { data } = options;
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
    // An answer from after now (the clock set back since) stands for nothing.
    const at = signedInAt(data, login);
    const age = at === undefined ? undefined : now() - at;
    if (age !== undefined && age >= 0 && age <= LOGIN_ANSWER_STANDS_MS) return;
    throw unknownLogin(lastError);
  }
  noteAnswer(login, said, now(), data);
  if (!said.signedIn) throw new Error(LOGIN_SIGNED_OUT);
}
