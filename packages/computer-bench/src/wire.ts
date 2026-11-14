// The computer protocol as the bench sees it: JSON-RPC methods by name, answered with a value or an error of a kind.
// The bench reads the wire, never a provider: a task's setup, its checks and the agent's steps are all method calls, so a
// task runs on any computer whose hello declares what it needs (spec/computer/kinds.md). The shapes here are the few
// fields the bench reads; the protocol's own types (packages/computer/src/protocol.ts) are the authority.

/** A JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** An error kind from the wire (`data.kind`), or the client's own (`gone`, `refused`, ...). */
export interface WireError {
	code: string;
	message: string;
}

export type WireResult<T = unknown> = { ok: true; value: T } | { ok: false; error: WireError };

/** Anything that answers a computer's methods: a protocol client, a recording tap over one, or the fake world. */
export interface Wire {
	call(method: string, params: JsonObject, options?: { signal?: AbortSignal }): Promise<WireResult>;
}

/** What `hello` answers, as far as the bench reads it. */
export interface Hello {
	protocol: string;
	version: string;
	os: string;
	osVersion?: string;
	kind: string;
	arch: string;
	groups: string[];
	screen?: { width: number; height: number; scale: number };
	features?: Record<string, unknown>;
	display?: string;
	/** The machine: "Apple", "MacBook Pro"; "Google", "Pixel 9". */
	device?: { maker: string; model: string };
}

/** The group a method belongs to, so a task's setup and checks say what they need without a list written by hand. */
export function groupOf(method: string): string | undefined {
	if (method === "hello" || method === "ping" || method === "deadline.extend" || method === "mount.sync") return undefined;
	if (method === "exec.run") return "exec";
	if (method.startsWith("files.") || method.startsWith("tar.")) return "files";
	if (method.startsWith("process.")) return "processes";
	if (method.startsWith("screen.")) return "screen";
	if (method === "apps.install") return "apps.install";
	if (method.startsWith("apps.")) return "apps";
	if (method.startsWith("ui.")) return "ui";
	// input.actions needs one of the input groups, by the actions it carries: the computer refuses an action whose group
	// it does not declare, in words, so the bench does not guess which.
	if (method === "input.actions") return "input";
	return undefined;
}

/** Whether `groups` (a hello's) has `group`, as groupOf names it: "input" is any of the input groups. */
export function hasGroup(groups: readonly string[], group: string): boolean {
	if (group === "input") return groups.some((one) => one.startsWith("input."));
	return groups.includes(group);
}

/** Whether `groups` (a hello's) offers what a method needs. */
export function offers(groups: readonly string[], method: string): boolean {
	const group = groupOf(method);
	return group === undefined || hasGroup(groups, group);
}

/** Base64 to text, for exec.run's stdout and stderr. */
export const fromBase64 = (data: unknown): string => (typeof data === "string" ? Buffer.from(data, "base64").toString("utf8") : "");
