// What bash and the five background tools share: their names, how the tool gate holds each of them to bash's setting,
// the run's folder a command starts in, and how a command starts in a computer (a fresh bash, else sh, through
// computerd's process.start). The kernel's tool gate reads the mapping as data; nothing here gates a call.
import type { ComputerClient, ProcessStartResult, PtySize } from "../protocol.js";
import type { Result } from "../result.js";

/** The run's folder inside every computer: where a command starts unless its call names another. */
export const WORKSPACE = "/workspace";

/** The background tools, by name. */
export const BACKGROUND_TOOLS = ["bash_background", "bash_output", "bash_input", "bash_signal", "bash_list"] as const;
export type BackgroundTool = (typeof BACKGROUND_TOOLS)[number];
/** The tools that run a command in the computer: bash, and the background tools. The tool gate holds each to bash's setting. */
export const SHELL_TOOLS = ["bash", ...BACKGROUND_TOOLS] as const;
export type ShellTool = (typeof SHELL_TOOLS)[number];

/** A setting of the tool gate. */
export type Permission = "allow" | "ask" | "deny";

/**
 * Each shell tool's permission under bash: ask. bash, bash_background and bash_input park for approval under their own
 * names; bash_output, bash_list and bash_signal only watch or end a process this run already started (an id reaches
 * only a background process of the run's own computer), so they run unasked. bash: deny refuses all six; bash: allow
 * runs all six.
 */
export const SHELL_UNDER_ASK: Readonly<Record<ShellTool, "ask" | "allow">> = Object.freeze({
	bash: "ask",
	bash_background: "ask",
	bash_output: "allow",
	bash_input: "ask",
	bash_signal: "allow",
	bash_list: "allow",
});

/** Shell tool `tool`'s permission, given bash's. */
export const shellPermission = (tool: ShellTool, bash: Permission): Permission => (bash === "ask" ? SHELL_UNDER_ASK[tool] : bash);

/** A tool as a model is shown it: its name, its description, its parameters' JSON Schema, and whether a call may run again after a crash. */
export interface ShellToolDefinition {
	name: ShellTool;
	description: string;
	parameters: { type: "object"; additionalProperties?: false; properties: Record<string, Record<string, unknown>>; required: string[] };
	replay?: "safe";
}

/** A background tool's answer: the text a model reads, and the details a timeline shows. */
export interface ToolAnswer {
	text: string;
	details: Record<string, unknown>;
}

/** How a shell starts: the script its `-c` runs, with $0 the marker that names what started it and $1 the command. */
export interface ShellStart {
	script: string;
	marker: string;
	command: string;
	cwd: string;
	pty?: PtySize;
	stdin?: boolean;
}

/** The argv of a shell started by `start`: [shell, "-c", script, marker, command]. */
export const shellArgv = (shell: string, start: Pick<ShellStart, "script" | "marker" | "command">): string[] => [shell, "-c", start.script, start.marker, start.command];

/**
 * Starts a fresh shell: bash, else sh where the computer has none (computerd answers not_found). Every other refusal is
 * bash's; a folder that does not exist is refused for both, as sh's.
 */
export async function startShell(client: ComputerClient, start: ShellStart): Promise<Result<ProcessStartResult>> {
	const params = (shell: string) => ({ argv: shellArgv(shell, start), cwd: start.cwd, ...(start.pty ? { pty: start.pty } : {}), ...(start.stdin ? { stdin: true } : {}) });
	const bash = await client.call("process.start", params("bash"));
	if (bash.ok || bash.error.code !== "not_found") return bash;
	return client.call("process.start", params("sh"));
}

/** Each signal's number, for an exit code past 128. */
export const SIGNAL_NUMBERS: Readonly<Record<string, number>> = Object.freeze({ HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8, KILL: 9, USR1: 10, SEGV: 11, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15 });
/** Each signal's name, by its number. */
export const SIGNAL_NAMES: Readonly<Record<number, string>> = Object.freeze(Object.fromEntries(Object.entries(SIGNAL_NUMBERS).map(([name, n]) => [n, name])));
