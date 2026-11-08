// Docker for the suite: the provider with the daemon for Docker's architecture, one whose daemon reports another
// version, built with Go when the drift case first asks for it, and run folders on the Docker host for the mount cases.
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DockerDesktopOptions, DockerProvider } from "../docker.js";
import type { MountKind } from "../mount.js";
import type { ComputerProvider } from "../provider.js";
import type { RunFolder } from "./types.js";

export interface DockerConformance {
	provider: ComputerProvider;
	drifted: () => Promise<ComputerProvider>;
	/** A fresh run folder on this host, owned by the provider's user, for a bind; none for any other kind. */
	mountFor: (kind: MountKind) => RunFolder | undefined;
	/** Removes the drifted daemon's build, if one was made, and any run folder still there. */
	close(): void;
}

/**
 * A run folder for a bind: a new directory under the temp dir, by its canonical path, owned by the computer's user as
 * the provider requires. This process owns it already when it is that user; as root, it gives the folder to that user,
 * as a caller does: the provider never changes the folder.
 */
function hostFolder(user: string, made: Set<string>): RunFolder {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "computer-run-")));
	const [uid = -1, gid = -1] = user.split(":").map(Number);
	if (process.getuid?.() === 0) chownSync(dir, uid, gid);
	made.add(dir);
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
		close: async () => {
			made.delete(dir);
			await rm(dir, { recursive: true, force: true });
		},
	};
}

export interface DockerConformanceOptions {
	/** The docker CLI. */
	docker?: string;
	/** The longest `docker version` may take before it is killed and the run fails; default 30 s. */
	timeoutMs?: number;
	/** Desktop computers (kind desktop) on an image with an X server, such as test/fixtures/desktop/Dockerfile's. */
	desktop?: DockerDesktopOptions;
}

/** Throws in words when Docker cannot be asked its architecture, in bounded time, or the daemon for it is not built. */
export function dockerConformance({ docker = "docker", timeoutMs = 30_000, desktop }: DockerConformanceOptions = {}): DockerConformance {
	let arch: string;
	try {
		arch = execFileSync(docker, ["version", "--format", "{{.Server.Arch}}"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		}).trim();
	} catch (error) {
		const why = (error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? `${docker} version did not answer within ${timeoutMs / 1000} s, so it was killed` : (error as Error).message.split("\n")[0];
		throw new Error(`cannot ask Docker its architecture (${docker} version): ${why}`);
	}
	const daemonPath = fileURLToPath(new URL(`../computerd-linux-${arch}`, import.meta.url));
	if (!existsSync(daemonPath)) throw new Error(`no daemon for Docker's ${arch} at ${daemonPath}: run npm run build:daemon -w @parcha/agentrun-computer`);
	const provider = new DockerProvider({ daemonPath, docker, ...(desktop ? { desktop } : {}) });
	let dir: string | undefined;
	let built: Promise<ComputerProvider> | undefined;
	const drifted = () =>
		(built ??= new Promise<ComputerProvider>((resolve, reject) => {
			dir = mkdtempSync(join(tmpdir(), "computer-drift-"));
			// A computer's user, with no capabilities, must be able to reach and run the mounted binary.
			chmodSync(dir, 0o755);
			const out = join(dir, "computerd");
			const flags = `-s -w -X main.version=${provider.version}-drift`;
			execFile(
				"go",
				["build", "-trimpath", "-ldflags", flags, "-o", out, "./cmd/computerd"],
				{ cwd: fileURLToPath(new URL("../../daemon", import.meta.url)), env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch } },
				(error, _stdout, stderr) => {
					if (error) {
						const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? "go was not found on PATH" : stderr.trim() || error.message;
						return reject(new Error(`building a daemon of another version for the drift case: ${why}`));
					}
					chmodSync(out, 0o755);
					resolve(new DockerProvider({ daemonPath: out, docker, ...(desktop ? { desktop } : {}) }));
				},
			);
		}));
	const folders = new Set<string>();
	const mountFor = (kind: MountKind) => (kind === "bind" ? hostFolder(provider.user, folders) : undefined);
	const close = () => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
		for (const folder of folders) rmSync(folder, { recursive: true, force: true });
		folders.clear();
	};
	return { provider, drifted, mountFor, close };
}
