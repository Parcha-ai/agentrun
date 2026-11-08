// Docker for the suite: the provider with the daemon for Docker's architecture, and one whose daemon reports another
// version, built with Go when the drift case first asks for it.
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DockerDesktopOptions, DockerProvider } from "../docker.js";
import type { ComputerProvider } from "../provider.js";

export interface DockerConformance {
	provider: ComputerProvider;
	drifted: () => Promise<ComputerProvider>;
	/** Removes the drifted daemon's build, if one was made. */
	close(): void;
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
	const close = () => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	};
	return { provider, drifted, close };
}
