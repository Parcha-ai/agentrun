import type { ClaudeLoginView } from "@/lib/v2";

/** The row's name, and the mode's, in the words AgentRun uses for it: Claude Code is Anthropic's CLI, never ours. */
export const LOGIN_ROW = "Use Claude Code's login on this machine";
/** What the mode does, under the row's name. */
export const LOGIN_RUNS = "Claude Agent runs on your Claude plan through the Claude Code CLI on this server's machine. The CLI keeps the login and calls Anthropic itself; AgentRun only asks it whether it is signed in.";
/** The owner's word, asked before it turns on. */
export const ONLY_ME = "Only I run agents on this server";
export const ONLY_ME_WHY = "Runs here would use your Claude plan, which is yours alone.";
/** Beside Turn on while it waits for the owner's word. */
export const ONLY_ME_FIRST = `Tick "${ONLY_ME}" to turn it on.`;
/** The view as the row reads it: a server from before the view named its folders answers with no `folder` or `machine`
 *  (and no `sign_in`), and the row then shows what it showed before them. */
export type LoginView = Omit<ClaudeLoginView, "folder" | "machine"> & Partial<Pick<ClaudeLoginView, "folder" | "machine">>;

/** Where the login is: AgentRun's own (the default), or this machine's own Claude Code login, by name and by the folder
 *  the server finds it in (`~/.claude` from a server that names none). */
export function placeWords(place: ClaudeLoginView["place"], v: LoginView): string {
  return place === "agentrun" ? "A login of AgentRun's own (sign in once for it)" : `This machine's Claude Code login (${v.machine?.folder ?? "~/.claude"})`;
}
/** Which folder the status is read from. */
export const checksFolder = (folder: string): string => `AgentRun asks the CLI about the login in ${folder}.`;
/** Said of this machine's login where the server's environment names no CLAUDE_CONFIG_DIR. */
export const MACHINE_DEFAULT_FOLDER = "That is Claude Code's default folder. If your Claude Code keeps its login in another one (it runs with CLAUDE_CONFIG_DIR set), start AgentRun with CLAUDE_CONFIG_DIR set to that folder as well.";
/** Said of this machine's login where the server's environment sets CLAUDE_SECURESTORAGE_CONFIG_DIR (`credentials`, the
 *  view's `machine.credentials`): the CLI keeps the tokens there, apart from the folder. */
export const machineCredentials = (credentials: string): string =>
  credentials
    ? `Its credentials are read from ${credentials}, as CLAUDE_SECURESTORAGE_CONFIG_DIR in the server's environment says.`
    : "Its credentials are read where CLAUDE_SECURESTORAGE_CONFIG_DIR set empty in the server's environment puts them: ~/.claude, and on macOS the Keychain item with no suffix.";

/** "10 minutes", "30 seconds": a sign-in's limit in words. */
export function limitWords(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.max(1, Math.round(ms / 1_000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** What the server says of the CLI's sign-in it started, in words, or null when there is nothing to say: none started,
 *  or the login reads signed in. */
export function signInWords(v: LoginView): string | null {
  const s = v.sign_in;
  if (!s || v.state === "signed_in") return null;
  switch (s.state) {
    case "waiting":
      return `Waiting for the browser: finish signing in on the page the CLI opened. The sign-in stops after ${limitWords(s.limit_ms)}.`;
    case "timed_out":
      return `The sign-in stopped after ${limitWords(s.limit_ms)} with no answer from the browser, so a sign-in page still open can't finish. Open the CLI's sign-in here starts it again.`;
    case "failed": {
      const how = s.exit_code !== undefined ? `exit code ${s.exit_code}` : s.signal ? `ended by ${s.signal}` : "no exit code";
      return `The CLI's sign-in ended without signing in (${how}). Open the CLI's sign-in here starts it again, or run the line above in a terminal.`;
    }
    case "not_started":
      return `The CLI's sign-in could not start${s.error ? `: ${s.error}` : ""}. Run the line above in a terminal.`;
    case "signed_in":
      return `The CLI's sign-in ended signed in, but the CLI says the login${v.folder ? ` in ${v.folder}` : ""} is not signed in. Run the line above in a terminal on the server's machine.`;
  }
}
export const SIGNED_OUT = "Not signed in. Run this in a terminal on the server's machine; the CLI opens a browser there:";
export const NO_CLI = "No Claude Code CLI here yet: the first Claude Agent run installs it. Or run this with a claude CLI of your own:";
export const UNKNOWN = "The Claude Code CLI didn't say whether it is signed in. Sign in again with:";
export const OTHER_MACHINE = "Turned on for another machine: Claude Agent runs here use the model keys.";
/** A plan's requests in dollars: none. A run on the login says it on hover, as a ChatGPT plan run does. */
export const LOGIN_NO_DOLLARS = "Requests on your Claude plan through Claude Code's login cost no dollars here; your plan's own limits apply.";

const STATES: ReadonlySet<string> = new Set(["off", "other_machine", "signed_in", "signed_out", "no_cli", "unknown"]);
/** GET /settings/claude-login's answer (and a write's) when it is one (a server with the mode switched off answers 404),
 *  else null. A `folder` or `machine` that is not the shape this console knows is left out, as an older server's is. */
export function claudeLoginView(body: unknown): LoginView | null {
  if (!body || typeof body !== "object" || !STATES.has(String((body as { state?: unknown }).state))) return null;
  const { folder, machine, ...rest } = body as ClaudeLoginView;
  const known = machine && typeof machine === "object" && typeof machine.folder === "string" && typeof machine.source === "string";
  return { ...rest, ...(typeof folder === "string" ? { folder } : {}), ...(known ? { machine } : {}) };
}

/** "Signed in as a@b.c (Max)", with what the CLI said. */
export function loginSignedInAs(v: LoginView): string {
  const plan = v.account?.plan ? ` (${v.account.plan.charAt(0).toUpperCase()}${v.account.plan.slice(1)})` : "";
  return `Signed in as ${v.account?.email ?? "your Claude account"}${plan}`;
}

/** Said next to the Anthropic key: which Claude plans include API credits a key runs Claude Agent on. */
export const ANTHROPIC_KEY_CREDITS = "Claude Max, Ultra and Team plans include monthly API credits: a key from the Claude Console organization linked to the plan runs Claude Agent on them, AgentRun Cloud included. Pro, Free and Enterprise plans don't.";
