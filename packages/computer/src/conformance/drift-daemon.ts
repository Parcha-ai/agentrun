// The daemon of another version every conformance module's drifted twin runs, built with Go for the drift case.
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** The version a drifted daemon reports: this package's, which every provider reports, with -drift. */
export const DRIFT_VERSION = `${VERSION}-drift`;

/** Go's own settings and the target, and nothing else of this process's environment: never a key. */
function goEnv(arch: string): Record<string, string> {
	const kept = ["PATH", "HOME", "TMPDIR", "GOPATH", "GOCACHE", "GOMODCACHE", "GOFLAGS", "GOPROXY", "GOTOOLCHAIN"];
	const env: Record<string, string> = { CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch };
	for (const name of kept) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

/**
 * This package's daemon for linux/<arch>, stamped with version, built with Go into a directory of its own that is
 * removed when the process exits; its path. The directory is 0755, so a computer's user, with no capabilities, can
 * reach and run a binary mounted from it.
 */
export async function buildDriftDaemon(arch: string, version: string = DRIFT_VERSION): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "computer-drift-"));
	process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
	chmodSync(dir, 0o755);
	const out = join(dir, "computerd");
	await new Promise<void>((resolve, reject) => {
		execFile(
			"go",
			["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", out, "./cmd/computerd"],
			{ cwd: fileURLToPath(new URL("../../daemon", import.meta.url)), env: goEnv(arch) },
			(error, _stdout, stderr) => {
				if (!error) return resolve();
				const why = (error as NodeJS.ErrnoException).code === "ENOENT" ? "go was not found on PATH" : stderr.trim() || error.message;
				reject(new Error(`building a daemon of another version for the drift case: ${why}`));
			},
		);
	});
	chmodSync(out, 0o755);
	return out;
}
