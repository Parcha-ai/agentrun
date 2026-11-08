// The run's folder in a computer: the one path it is mounted at, the spec rule every provider's check() shares, and the
// shape a provider reads it back in. An Archil mount's token is a secret: no refusal, read-back or word here holds it.
import { realpathSync, statSync } from "node:fs";
import { epochProblem } from "./labels.js";
import type { Refusal } from "./provider.js";

/** Where the run's folder is mounted in every computer. HOME is elsewhere (a Docker computer's is /work). */
export const WORKSPACE = "/workspace";

/**
 * The run's folder, mounted at WORKSPACE. bind: a folder on the provider's host, bound in (the local Docker computer).
 * archil: the run's folder inside an Archil disk in its region, mounted in the computer with the disk's token (a remote
 * computer).
 */
export type MountSpec = { kind: "bind"; path: string } | { kind: "archil"; disk: string; region: string; folder: string; token: string };
export type MountKind = MountSpec["kind"];
export const MOUNT_KINDS: readonly MountKind[] = ["bind", "archil"];

/**
 * A computer's mount as read back from the computer itself: its kind and where it comes from, never the token. `other`
 * is a mount at WORKSPACE the provider never makes (read-only, a volume), in words. An Archil mount also reads back
 * whether it holds the folder exclusively (no other client writes it) and the claim epoch it was made under: the
 * computer's agentrun.epoch label (labels.ts), since Archil's hold on a folder carries no epoch of its own.
 */
export type MountReadBack =
	| { kind: "bind"; path: string }
	| { kind: "archil"; disk: string; region: string; folder: string; exclusive: boolean; epoch: number }
	| { other: string };

const SHAPE = 'mount is { kind: "bind", path } or { kind: "archil", disk, region, folder, token }';
const FIELDS: Record<MountKind, readonly string[]> = { bind: ["kind", "path"], archil: ["kind", "disk", "region", "folder", "token"] };
const NUL = "a NUL byte cannot be passed to a mount";
const filled = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * The one mount rule, with no vendor call: no mount is no refusal; a kind the provider does not declare is refused in
 * words; a bind's path is absolute, canonical (its own realpath: what a provider reads back is what is bound), an
 * existing directory on the host, with no NUL; an Archil mount's disk, region, folder and token are non-empty strings with no
 * NUL, the folder relative to the disk's root and never above it. Each refusal names a field, never an Archil value.
 */
export function checkMount(mount: unknown, declared: readonly MountKind[] | undefined): Refusal[] {
	if (mount === undefined) return [];
	const refuse = (message: string): Refusal[] => [{ field: "mount", message }];
	const given = typeof mount === "object" && mount !== null && !Array.isArray(mount) ? (mount as Record<string, unknown>) : undefined;
	const kind = given?.kind;
	if (given === undefined || !MOUNT_KINDS.includes(kind as MountKind)) return refuse(SHAPE);
	const takes = declared ?? [];
	if (!takes.includes(kind as MountKind)) {
		return refuse(
			takes.length === 0
				? `this provider declares no mount kind, so it mounts no run folder (capabilities().mount)`
				: `this provider does not take a mount of kind ${kind as string}; it takes ${takes.join(" or ")}`,
		);
	}
	const extra = Object.keys(given).find((field) => !FIELDS[kind as MountKind].includes(field) && given[field] !== undefined);
	if (extra !== undefined) return refuse(`mount.${extra} is not a field of ${kind === "bind" ? "a bind" : "an archil"} mount`);
	return kind === "bind" ? bindRefusals(given.path).map((message) => ({ field: "mount", message })) : archilRefusals(given).map((message) => ({ field: "mount", message }));
}

function bindRefusals(path: unknown): string[] {
	if (!filled(path)) return ["mount.path is required: the run folder's absolute path on the host"];
	if (path.includes("\0")) return [`mount.path: ${NUL}`];
	if (!path.startsWith("/")) return [`mount.path must be absolute, not ${JSON.stringify(path)}`];
	let directory = false;
	let real: string | undefined;
	try {
		directory = statSync(path).isDirectory();
		real = realpathSync(path);
	} catch {
		directory = false;
	}
	if (!directory) return [`mount.path ${JSON.stringify(path)} is not a directory on the host`];
	if (real !== path) return [`mount.path ${JSON.stringify(path)} is not canonical: it resolves to ${JSON.stringify(real)}; give that path`];
	return [];
}

/** An Archil mount's refusals, by field: no value is ever in them, since the token may be in any field by mistake. */
function archilRefusals({ disk, region, folder, token }: Record<string, unknown>): string[] {
	const found: string[] = [];
	if (!filled(disk)) found.push("mount.disk is required: the Archil disk's name");
	else if (disk.includes("\0")) found.push(`mount.disk: ${NUL}`);
	if (!filled(region)) found.push("mount.region is required: the Archil disk's region");
	else if (region.includes("\0")) found.push(`mount.region: ${NUL}`);
	if (!filled(folder)) found.push("mount.folder is required: the run's folder inside the disk, relative to its root");
	else if (folder.includes("\0")) found.push(`mount.folder: ${NUL}`);
	else if (folder.startsWith("/")) found.push("mount.folder must be relative to the disk's root");
	else if (folder.split("/").includes("..")) found.push('mount.folder must stay inside the disk: no ".." part');
	if (!filled(token)) found.push("mount.token is required: the disk's token, a non-empty string");
	else if (token.includes("\0")) found.push(`mount.token: ${NUL}`);
	return found;
}

/**
 * What a provider reads back of a mount it made as asked: its kind and source, never the token. An Archil mount is
 * always exclusive, and is read back under `epoch`, the computer's claim epoch. With no epoch, or a value that is not
 * one, it is `{ other }` in words: a mount under no claim, which no attach takes, never a guessed epoch. A bind takes none.
 */
export function readBackOf(mount: MountSpec, epoch?: number): MountReadBack {
	if (mount.kind === "bind") return { kind: "bind", path: mount.path };
	const problem = epochProblem(epoch);
	if (problem !== undefined) return { other: `an Archil mount of ${mount.disk}:/${mount.folder} with no epoch to read it back under (${problem})` };
	return { kind: "archil", disk: mount.disk, region: mount.region, folder: mount.folder, exclusive: true, epoch: epoch as number };
}
