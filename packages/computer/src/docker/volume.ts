// A Docker provider whose host paths are not the Docker daemon's: a server in a container of that Docker's own, given its
// socket (compose.yaml), has its files on a named volume the daemon mounted into it at `root`. A path there exists only in
// the server's container, so the daemon cannot bind it; the provider then mounts each path it hands a computer (the
// daemon's copy, the run's folder) as a subpath of that volume:
//
//	--mount type=volume,src=<name>,dst=<in the computer>,volume-subpath=<path below root>,volume-nocopy[,readonly]
//
// never the volume's root, and never a path outside it, which is refused in words. `volume-subpath` takes Docker Engine
// 26 or later; an older engine is refused in words too. `volume-nocopy`: Docker never copies the image's files at the
// mount's destination into the volume. As serve's box stack did (packages/serve/src/box-paths.ts).
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The named volume a provider's paths are on, and where this process has it mounted. */
export interface DockerVolume {
	/** The named volume, as Docker names it (`docker volume ls`). */
	name: string;
	/** Where this process has the volume mounted: an absolute path. Every path the provider mounts must be below it. */
	root: string;
}

/** The first Docker Engine that mounts a volume's subpath (API 1.45). */
export const VOLUME_SUBPATH_ENGINE = 26;
/** Why an older engine is refused. */
export const OLD_ENGINE = `Docker Engine <${VOLUME_SUBPATH_ENGINE} can't mount a named volume's subpath, which the provider's volume option needs: upgrade to Docker ${VOLUME_SUBPATH_ENGINE}+`;

/** Docker's own rule for a volume's name. */
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;
/** What a --mount value cannot hold. */
const UNSAFE = /[,"\r\n]/;

/** The option checked, its root resolved; a throw in words for one the provider cannot use. */
export function volumeOf(given: unknown): DockerVolume {
	const option = given as Partial<DockerVolume> | null;
	if (typeof option !== "object" || option === null) throw new Error("the provider's volume is { name, root }: the named volume its paths are on, and where this process has it mounted");
	const { name, root } = option;
	if (typeof name !== "string" || !VOLUME_NAME.test(name)) throw new Error(`the provider's volume.name ${JSON.stringify(name)} is not a Docker volume's name`);
	if (typeof root !== "string" || !isAbsolute(root)) throw new Error(`the provider's volume.root ${JSON.stringify(root)} must be an absolute path: where this process has the volume ${name} mounted`);
	if (UNSAFE.test(root)) throw new Error(`the provider's volume.root ${JSON.stringify(root)} has a comma, a double quote or a line break, which a Docker mount cannot hold`);
	return { name, root: resolve(root) };
}

/** `path` relative to the root, as a volume's subpath, when it is below it (or at it, with `orRoot`); else undefined.
 *  Read against the root as written and, when it exists, as its real path, since a path the provider made may be real. */
export function subpathOf(volume: DockerVolume, path: string, { orRoot = false }: { orRoot?: boolean } = {}): string | undefined {
	const target = resolve(path);
	const roots = [volume.root];
	try {
		roots.push(realpathSync(volume.root));
	} catch {
		// A root that is not there (yet) is read as written.
	}
	for (const root of roots) {
		const below = relative(root, target);
		if (below === "") return orRoot ? "" : undefined;
		if (!below.startsWith(`..${sep}`) && below !== ".." && !isAbsolute(below)) return below;
	}
	return undefined;
}

/** Why `path` cannot be mounted from the volume, in words, or undefined when it can. `what` names it. */
export function outsideWords(volume: DockerVolume, path: string, what: string): string {
	return `${what} ${path} is not below the provider's volume root ${volume.root} (the volume ${volume.name}): on this Docker host the provider reaches a path only as a subpath of that volume, never its root`;
}

/** The --mount value of `subpath` of the volume at `dst`. */
export function volumeMount(volume: DockerVolume, subpath: string, dst: string, readonly: boolean): string {
	return `type=volume,src=${volume.name},dst=${dst},volume-subpath=${subpath},volume-nocopy${readonly ? ",readonly" : ""}`;
}

/** The engine's major version from docker info's ServerVersion ("26.1.4", "29.0.0-rc.1"), or undefined. */
export function engineOf(serverVersion: unknown): number | undefined {
	const major = typeof serverVersion === "string" ? /^(\d+)\./.exec(serverVersion.trim())?.[1] : undefined;
	return major === undefined ? undefined : Number(major);
}
