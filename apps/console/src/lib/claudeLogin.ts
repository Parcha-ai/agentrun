import type { ClaudeLoginView } from "@/lib/v2";

/** The row's name, and the mode's, in the words AgentRun uses for it: Claude Code is Anthropic's CLI, never ours. */
export const LOGIN_ROW = "Use Claude Code's login on this machine";
/** What the mode does, under the row's name. */
export const LOGIN_RUNS = "Claude Agent runs on your Claude plan through the Claude Code CLI on this server's machine. The CLI keeps the login and calls Anthropic itself; AgentRun only asks it whether it is signed in.";
/** The owner's word, asked before it turns on. */
export const ONLY_ME = "Only I run agents on this server";
export const ONLY_ME_WHY = "Runs here would use your Claude plan, which is yours alone.";
/** Where the login is: AgentRun's own (the default), or this machine's own Claude Code login, by name. */
export const PLACES: Record<ClaudeLoginView["place"], string> = {
  agentrun: "A login of AgentRun's own (sign in once for it)",
  machine: "This machine's Claude Code login (~/.claude)",
};
export const SIGNED_OUT = "Not signed in. Run this in a terminal on the server's machine; the CLI opens a browser there:";
export const NO_CLI = "No Claude Code CLI here yet: the first Claude Agent run installs it. Or run this with a claude CLI of your own:";
export const UNKNOWN = "The Claude Code CLI didn't say whether it is signed in. Sign in again with:";
export const OTHER_MACHINE = "Turned on for another machine: Claude Agent runs here use the model keys.";
/** A plan's requests in dollars: none. A run on the login says it on hover, as a ChatGPT plan run does. */
export const LOGIN_NO_DOLLARS = "Requests on your Claude plan through Claude Code's login cost no dollars here; your plan's own limits apply.";

const STATES: ReadonlySet<string> = new Set(["off", "other_machine", "signed_in", "signed_out", "no_cli", "unknown"]);
/** GET /settings/claude-login's answer when it is one (a server with the mode switched off answers 404), else null. */
export const claudeLoginView = (body: unknown): ClaudeLoginView | null =>
  body && typeof body === "object" && STATES.has(String((body as { state?: unknown }).state)) ? (body as ClaudeLoginView) : null;

/** "Signed in as a@b.c (Max)", with what the CLI said. */
export function loginSignedInAs(v: ClaudeLoginView): string {
  const plan = v.account?.plan ? ` (${v.account.plan.charAt(0).toUpperCase()}${v.account.plan.slice(1)})` : "";
  return `Signed in as ${v.account?.email ?? "your Claude account"}${plan}`;
}

/** Said next to the Anthropic key: which Claude plans include API credits a key runs Claude Agent on. */
export const ANTHROPIC_KEY_CREDITS = "Claude Max, Ultra and Team plans include monthly API credits: a key from the Claude Console organization linked to the plan runs Claude Agent on them, AgentRun Cloud included. Pro, Free and Enterprise plans don't.";
