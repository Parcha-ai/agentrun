// The Orgo workspaces a key's account sees, and the one a provider's computers live in when its settings name none.
// GET /workspaces with the key (docs.orgo.ai, measured 11-13: 200, { workspaces, projects }) lists each workspace with
// its id, name, status, deleted_at and more; `projects` is the same list under Orgo's older name, and is not read. A
// workspace with a deleted_at is gone and never offered. Orgo documents status "active" (a normal workspace) and
// "inactive" without saying what inactive changes, so no status is filtered out: an inactive one is offered, said so.
import type { OrgoRest } from "./orgo-channel.js";
import type { KeyChoice } from "./provider.js";
import { failAs, failFor, ok, type Result } from "./result.js";

const fail = failFor("orgo");

/** One workspace a key's account sees: its id, its name, and its status where Orgo says one other than active. */
export interface OrgoWorkspace {
	readonly id: string;
	readonly name: string;
	readonly status?: string;
}

/** What a person reads for a key whose account has no workspace. */
export const NO_WORKSPACE = "this Orgo key's account has no workspace: make one at orgo.ai";

/** A workspace in words: its name, and its status when it is not active. */
export const workspaceWords = (workspace: OrgoWorkspace): string => (workspace.status === undefined ? workspace.name : `${workspace.name} (${workspace.status})`);

/** Every workspace the key's account sees, deleted ones left out, in Orgo's order. An HTTP failure keeps its code. */
export async function orgoWorkspaces(rest: OrgoRest, { timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<Result<OrgoWorkspace[]>> {
	const read = await rest.request<{ workspaces?: unknown }>("GET", "/workspaces", { timeoutMs, ...(signal ? { signal } : {}) });
	if (!read.ok) return failAs(read.error, `Orgo's workspaces could not be read: ${read.error.message}`);
	const listed = read.value?.workspaces;
	if (!Array.isArray(listed)) return fail("vendor", "Orgo's GET /workspaces answered no workspaces list");
	const workspaces: OrgoWorkspace[] = [];
	for (const one of listed as Record<string, unknown>[]) {
		if (typeof one?.id !== "string" || one.id === "" || (one.deleted_at !== null && one.deleted_at !== undefined)) continue;
		const name = typeof one.name === "string" && one.name.trim() !== "" ? one.name.trim() : one.id;
		const status = typeof one.status === "string" && one.status !== "active" ? one.status : undefined;
		workspaces.push({ id: one.id, name, ...(status === undefined ? {} : { status }) });
	}
	return ok(workspaces);
}

/**
 * The workspace a provider whose settings name none uses: the key's account's one workspace. Several are refused in
 * words naming them and pointing at Settings, where a person picks one; none is refused saying to make one.
 */
export async function soleWorkspace(rest: OrgoRest, context: { timeoutMs: number; signal?: AbortSignal }): Promise<Result<string>> {
	const listed = await orgoWorkspaces(rest, context);
	if (!listed.ok) return listed;
	const [only, ...more] = listed.value;
	if (only === undefined) return fail("not_found", NO_WORKSPACE);
	if (more.length === 0) return ok(only.id);
	return fail(
		"invalid",
		`this Orgo key's account has ${listed.value.length} workspaces (${listed.value.map(workspaceWords).join(", ")}): pick the one its computers live in, in Settings → Computers (ORGO_WORKSPACE_ID)`,
	);
}

/**
 * keyChoices for an Orgo provider: workspaceId's choices, every workspace the key's account sees, each its id and its
 * name; none is refused saying to make one. Orgo's descriptor picks no other option.
 */
export async function workspaceChoices(rest: OrgoRest, option: string, context: { timeoutMs: number; signal?: AbortSignal }): Promise<Result<KeyChoice[]>> {
	if (option !== "workspaceId") return fail("unsupported", `an Orgo provider offers choices for workspaceId alone, not ${JSON.stringify(option)}`);
	const listed = await orgoWorkspaces(rest, context);
	if (!listed.ok) return listed;
	if (listed.value.length === 0) return fail("not_found", NO_WORKSPACE);
	return ok(listed.value.map((workspace) => ({ value: workspace.id, label: workspaceWords(workspace) })));
}

/** A provider's workspace: `read()` the one its computers live in, and `id`, that id once a read found it. */
export interface WorkspaceHolder {
	read(signal?: AbortSignal): Promise<Result<string>>;
	readonly id: string | undefined;
}

/**
 * The workspace a provider's computers live in: `given` when its settings name one; else the key's account's sole one
 * (soleWorkspace), read on the first call that needs it and kept. A read that fails is not kept: the next call reads again.
 * Calls that come while a read is under way share it. The shared read is bounded by timeoutMs alone, never by one
 * caller's signal, so one caller giving up never fails the others: a caller whose signal fires stops waiting, answered
 * "aborted", and the read goes on for the rest.
 */
export function workspaceHolder(given: string | undefined, rest: OrgoRest, timeoutMs: number): WorkspaceHolder {
	let id = given;
	let reading: Promise<Result<string>> | undefined;
	const shared = (): Promise<Result<string>> =>
		(reading ??= soleWorkspace(rest, { timeoutMs }).then((found) => {
			reading = undefined;
			if (found.ok) id = found.value;
			return found;
		}));
	return {
		get id() {
			return id;
		},
		async read(signal) {
			if (id !== undefined) return ok(id);
			if (signal?.aborted) return fail("aborted", "the Orgo workspace read was aborted before it was sent");
			if (!signal) return shared();
			let stop: () => void = () => {};
			const stopped = new Promise<Result<string>>((resolve) => {
				stop = () => resolve(fail("aborted", "the Orgo workspace read was aborted; it goes on for other callers"));
				signal.addEventListener("abort", stop, { once: true });
			});
			try {
				return await Promise.race([shared(), stopped]);
			} finally {
				signal.removeEventListener("abort", stop);
			}
		},
	};
}
