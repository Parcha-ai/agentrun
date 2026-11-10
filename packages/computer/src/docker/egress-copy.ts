// The egress proxy's code for a provider with the volume option (src/docker/volume.ts): the proxy container binds this
// package's dist/docker and package.json, paths the Docker daemon does not have when the provider runs in a container.
// So the four files are staged below the volume's root, as daemonCopy stages the daemon: in the provider's daemonCache
// (checked as daemonCopy checks it), in `egress-<sha256 of the files>` with docker/ (0755) holding the three modules
// (0644) and package.json (0644) beside it (the directory 0755), written in a temporary directory and renamed into place,
// and reused when one with the same bytes is already there. The proxy then mounts that directory's subpaths of the
// volume. Never throws: every failure is a Result in words naming its path.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { privateCacheDirectory } from "../daemon-copy.js";
import { fail, ok, type Result } from "../result.js";
import { CODE_FILES, type EgressCode } from "./egress.js";
import { type DockerVolume, subpathOf } from "./volume.js";

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const wordsOf = (error: unknown) => (error as Error).message;

/** The four files, by their place in the staged directory: docker/<module> and package.json. */
function sourcesOf(code: EgressCode): Array<[string, string]> {
	return [...CODE_FILES.map((file): [string, string] => [join("docker", file), join(code.dir, file)]), ["package.json", code.packageJson]];
}

/** The files' bytes, and the sha256 over their names and bytes, or why they cannot be read. */
function readSources(code: EgressCode): Result<{ files: Array<[string, Buffer]>; sha: string }> {
	const hash = createHash("sha256");
	const files: Array<[string, Buffer]> = [];
	for (const [name, path] of sourcesOf(code)) {
		let bytes: Buffer;
		try {
			bytes = readFileSync(path);
		} catch (error) {
			const why = codeOf(error) === "ENOENT" ? "it is not built: run npm run build -w @parcha/agentrun-computer" : wordsOf(error);
			return fail("not_found", `the egress proxy's code ${path} cannot be read (${why})`);
		}
		hash.update(`${name}\0${bytes.length}\0`).update(bytes);
		files.push([name, bytes]);
	}
	return ok({ files, sha: hash.digest("hex") });
}

/** The staged code as the proxy mounts it: its paths, and their subpaths of the volume. */
function stagedAt(volume: DockerVolume, at: string): Result<EgressCode> {
	const dir = join(at, "docker");
	const packageJson = join(at, "package.json");
	const dirSubpath = subpathOf(volume, dir);
	const packageSubpath = subpathOf(volume, packageJson);
	if (dirSubpath === undefined || packageSubpath === undefined) return fail("refused", `the egress proxy's staged code ${at} is not below the provider's volume root ${volume.root}`);
	return ok({ dir, packageJson, volume: { name: volume.name, dir: dirSubpath, packageJson: packageSubpath } });
}

/** Whether the directory at `at` holds exactly the staged files, with their modes; a link anywhere is not. */
function holds(at: string, files: Array<[string, Buffer]>): boolean {
	try {
		for (const [path, mode] of [[at, 0o755], [join(at, "docker"), 0o755]] as const) {
			const stat = lstatSync(path);
			if (!stat.isDirectory() || (stat.mode & 0o7777) !== mode) return false;
		}
		for (const [name, bytes] of files) {
			const path = join(at, name);
			const stat = lstatSync(path);
			if (!stat.isFile() || (stat.mode & 0o7777) !== 0o644 || !readFileSync(path).equals(bytes)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Where the staged copy of `code` is (or would be) in `directory`, below the volume, read only: for a read-back, which
 * holds a proxy to the copy's subpaths. A directory that is not there yet is read as written.
 */
export function egressStaged(code: EgressCode, directory: string, volume: DockerVolume): Result<EgressCode> {
	const read = readSources(code);
	if (!read.ok) return read;
	let base: string;
	try {
		base = realpathSync(directory);
	} catch {
		base = resolve(directory);
	}
	return stagedAt(volume, join(base, `egress-${read.value.sha}`));
}

/** The staged copy of `code` in `directory`, made when it is not there with the same bytes and modes (see the head). */
export function egressStage(code: EgressCode, directory: string, volume: DockerVolume): Result<EgressCode> {
	const read = readSources(code);
	if (!read.ok) return read;
	const { files, sha } = read.value;
	const dir = privateCacheDirectory(directory);
	if (!dir.ok) return dir;
	const at = join(dir.value, `egress-${sha}`);
	if (holds(at, files)) return stagedAt(volume, at);
	const temp = join(dir.value, `.egress-${sha}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		mkdirSync(join(temp, "docker"), { recursive: true, mode: 0o700 });
		for (const [name, bytes] of files) {
			const fd = openSync(join(temp, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try {
				writeFileSync(fd, bytes);
				// fchmod is not narrowed by the umask: each file is 0644 whatever it is.
				fchmodSync(fd, 0o644);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}
		chmodSync(join(temp, "docker"), 0o755);
		chmodSync(temp, 0o755);
		// One that is there but not whole (a crash, a hand edit) is replaced; one another process just renamed in, kept.
		if (!holds(at, files)) {
			rmSync(at, { recursive: true, force: true });
			try {
				renameSync(temp, at);
			} catch (error) {
				if (!["EEXIST", "ENOTEMPTY"].includes(codeOf(error) ?? "")) throw error;
			}
		}
	} catch (error) {
		return fail("invalid", `cannot stage the egress proxy's code in ${at}: ${wordsOf(error)}`);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	if (!holds(at, files)) return fail("invalid", `the egress proxy's staged code in ${at} did not hold its files, 0755 directories and 0644 files, once written`);
	return stagedAt(volume, at);
}
