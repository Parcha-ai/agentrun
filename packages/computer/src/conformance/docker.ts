// Docker for the conformance CLI (`--provider docker`): the provider as fromEnv builds it, and its drifted twin, the same
// provider with a daemon of another version, built with Go for Docker's architecture when the drift case first asks.
// With desktop, both are desktops (kind desktop) on an image with an X server, such as test/fixtures/desktop/Dockerfile's.
// For the mount cases, mountFor("bind") makes a run folder on this host, owned by the computer's user.
import { chownSync, mkdtempSync, realpathSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerArch, type DockerFromEnvOptions, type DockerProvider, fromEnv } from "../docker.js";
import type { MountKind } from "../mount.js";
import { buildDriftDaemon } from "./drift-daemon.js";
import type { RunFolder } from "./types.js";

export interface DockerModuleOptions extends Pick<DockerFromEnvOptions, "docker" | "timeoutMs" | "desktop"> {
	/** Where the settings are read; default process.env. */
	env?: Record<string, string | undefined>;
}

/** The provider the CLI runs; throws in words when Docker cannot be asked its architecture, or its daemon is not built. */
export function createProvider({ env = process.env, ...options }: DockerModuleOptions = {}): Promise<DockerProvider> {
	return fromEnv(env, options);
}

/** The same provider with a daemon that reports another version, for the drift.version case. */
export async function createDriftedProvider({ env = process.env, ...options }: DockerModuleOptions = {}): Promise<DockerProvider> {
	const daemonPath = await buildDriftDaemon(await dockerArch(options));
	return fromEnv(env, { ...options, daemonPath });
}

/**
 * A run folder for a bind, and none for any other kind: a new directory under the temp dir, by its canonical path, owned
 * by the computer's user (the provider's, as createProvider builds it) as the provider requires. This process owns it
 * already when it is that user; as root, it gives the folder to that user, as a caller does: the provider never changes
 * the folder. The runner closes it when its case ends.
 */
export async function mountFor(kind: MountKind, { env = process.env, ...options }: DockerModuleOptions = {}): Promise<RunFolder | undefined> {
	if (kind !== "bind") return undefined;
	const { user } = await fromEnv(env, options);
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "computer-run-")));
	const [uid = -1, gid = -1] = user.split(":").map(Number);
	if (process.getuid?.() === 0) chownSync(dir, uid, gid);
	return {
		mount: { kind: "bind", path: dir },
		read: async (path) => {
			try {
				return await readFile(join(dir, path));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		write: (path, data) => writeFile(join(dir, path), data, { mode: 0o644 }),
		close: () => rm(dir, { recursive: true, force: true }),
	};
}
