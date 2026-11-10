// What a provider with the volume option (src/docker/volume.ts) stages below the volume's root, so the Docker daemon can
// mount it as the volume's subpaths: paths of this process's own (the daemon's file, the egress proxy's code in this
// package's build) are not the daemon's when the provider runs in a container. Each is a DIRECTORY, mounted whole: Docker
// mounts a volume's subpath that is a directory on every engine that has volume-subpath, so nothing here leans on a file.
//
//  - The daemon: `daemon-<sha256>/` holding `computerd` (0755) and an empty `egress/`, mounted read-only at /opt/agentrun,
//    so the daemon is at DAEMON_IN_COMPUTER as on every computer, and an allowlist's egress volume has its mount point
//    (EGRESS_MOUNT, /opt/agentrun/egress) in a tree Docker cannot write.
//  - The egress proxy's code: `egress-<sha256>/` holding docker/ with the three modules and package.json beside it, the
//    layout the proxy runs from, mounted read-only at /code.
//
// Each tree is in the provider's daemonCache, checked as daemonCopy checks its own (privateCacheDirectory), named by the
// sha256 of what it holds, its directories 0755 and its files 0644 (the daemon 0755); written in a temporary directory
// and renamed into place, and reused when one that holds the same is already there (one that differs is written again).
// Never throws: every failure is a Result in words naming its path.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { privateCacheDirectory } from "../daemon-copy.js";
import { fail, ok, type Result } from "../result.js";
import { CODE_FILES, type EgressCode } from "./egress.js";
import { type DockerVolume, subpathOf } from "./volume.js";


/** One entry of a tree: a file with its bytes and mode, or a directory (no bytes, mode 0755). */
interface Entry {
	path: string;
	bytes?: Buffer;
	mode: number;
}

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const wordsOf = (error: unknown) => (error as Error).message;

/** The sha256 over a tree's entries, in order: each one's path, mode and bytes. */
function shaOf(entries: Entry[]): string {
	const hash = createHash("sha256");
	for (const { path, bytes, mode } of entries) {
		hash.update(`${path}\0${mode.toString(8)}\0${bytes === undefined ? "dir" : bytes.length}\0`);
		if (bytes !== undefined) hash.update(bytes);
	}
	return hash.digest("hex");
}

/** Whether the tree at `at` holds every entry, with its mode and bytes; a link anywhere is not. */
function holds(at: string, entries: Entry[]): boolean {
	try {
		const top = lstatSync(at);
		if (!top.isDirectory() || (top.mode & 0o7777) !== 0o755) return false;
		for (const { path, bytes, mode } of entries) {
			const stat = lstatSync(join(at, path));
			if ((stat.mode & 0o7777) !== mode) return false;
			if (bytes === undefined ? !stat.isDirectory() : !stat.isFile() || !readFileSync(join(at, path)).equals(bytes)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** The tree `<prefix>-<sha>` in `directory`, made when one holding `entries` is not there (see the head). */
function stageTree(directory: string, prefix: string, entries: Entry[], what: string): Result<string> {
	const dir = privateCacheDirectory(directory);
	if (!dir.ok) return dir;
	const sha = shaOf(entries);
	const at = join(dir.value, `${prefix}-${sha}`);
	if (holds(at, entries)) return ok(at);
	const temp = join(dir.value, `.${prefix}-${sha}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		mkdirSync(temp, { mode: 0o700 });
		for (const { path, bytes, mode } of entries) {
			const target = join(temp, path);
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			if (bytes === undefined) {
				mkdirSync(target, { recursive: true, mode: 0o700 });
				chmodSync(target, mode);
				continue;
			}
			const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			try {
				writeFileSync(fd, bytes);
				// fchmod is not narrowed by the umask.
				fchmodSync(fd, mode);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}
		// Each directory a file is in is 0755, the top last.
		for (const { path } of entries) for (let up = dirname(path); up !== "."; up = dirname(up)) chmodSync(join(temp, up), 0o755);
		chmodSync(temp, 0o755);
		// One that is there but not whole (a crash, a hand edit) is replaced; one another process just renamed in is kept.
		if (!holds(at, entries)) {
			rmSync(at, { recursive: true, force: true });
			try {
				renameSync(temp, at);
			} catch (error) {
				if (!["EEXIST", "ENOTEMPTY"].includes(codeOf(error) ?? "")) throw error;
			}
		}
	} catch (error) {
		return fail("invalid", `cannot stage ${what} in ${at}: ${wordsOf(error)}`);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
	return holds(at, entries) ? ok(at) : fail("invalid", `${what} staged in ${at} did not hold its files, 0755 directories and its modes, once written`);
}

/** Where the tree `<prefix>-<sha>` for `entries` is, or would be, in `directory`: read only, for a read-back. */
function treeAt(directory: string, prefix: string, entries: Entry[]): string {
	let base: string;
	try {
		base = realpathSync(directory);
	} catch {
		base = resolve(directory);
	}
	return join(base, `${prefix}-${shaOf(entries)}`);
}

/** The daemon's tree's entries: computerd, 0755, read from `source`, and the egress volume's mount point. */
function daemonEntries(source: string): Result<Entry[]> {
	try {
		return ok([
			{ path: "computerd", bytes: readFileSync(source), mode: 0o755 },
			{ path: "egress", mode: 0o755 },
		]);
	} catch (error) {
		const why = codeOf(error) === "ENOENT" ? "run npm run build:daemon -w @parcha/agentrun-computer" : wordsOf(error);
		return fail("not_found", `the daemon at ${source} cannot be read (${why})`);
	}
}

/** The proxy's tree's entries: docker/<module> (0644) and package.json (0644), read from this package's build. */
function egressEntries(code: EgressCode): Result<Entry[]> {
	const entries: Entry[] = [];
	for (const [path, source] of [...CODE_FILES.map((file) => [`docker/${file}`, join(code.dir, file)]), ["package.json", code.packageJson]] as Array<[string, string]>) {
		try {
			entries.push({ path, bytes: readFileSync(source), mode: 0o644 });
		} catch (error) {
			const why = codeOf(error) === "ENOENT" ? "it is not built: run npm run build -w @parcha/agentrun-computer" : wordsOf(error);
			return fail("not_found", `the egress proxy's code ${source} cannot be read (${why})`);
		}
	}
	return ok(entries);
}

/** A staged tree's subpath of the volume, or a refusal: it must be below the root (daemonCache is). */
function below(volume: DockerVolume, at: string, what: string): Result<string> {
	const subpath = subpathOf(volume, at);
	return subpath === undefined ? fail("refused", `${what} staged in ${at} is not below the provider's volume root ${volume.root}`) : ok(subpath);
}

/** The daemon's tree for the daemon at `source`, staged in `directory`: its path and its subpath of the volume. */
export function daemonStage(source: string, directory: string, volume: DockerVolume): Result<{ path: string; subpath: string }> {
	const entries = daemonEntries(source);
	if (!entries.ok) return entries;
	const at = stageTree(directory, "daemon", entries.value, "the daemon");
	if (!at.ok) return at;
	const subpath = below(volume, at.value, "the daemon");
	return subpath.ok ? ok({ path: at.value, subpath: subpath.value }) : subpath;
}

/** The egress proxy's code staged in `directory`, as the proxy mounts it (EgressCode.volume). */
export function egressStage(code: EgressCode, directory: string, volume: DockerVolume): Result<EgressCode> {
	const entries = egressEntries(code);
	if (!entries.ok) return entries;
	const at = stageTree(directory, "egress", entries.value, "the egress proxy's code");
	if (!at.ok) return at;
	return codeAt(volume, at.value);
}

/** Where the egress proxy's code staged in `directory` is, read only: for a read-back. */
export function egressStaged(code: EgressCode, directory: string, volume: DockerVolume): Result<EgressCode> {
	const entries = egressEntries(code);
	return entries.ok ? codeAt(volume, treeAt(directory, "egress", entries.value)) : entries;
}

/** The staged proxy tree at `at` as an EgressCode: its own paths, and its subpath of the volume. */
function codeAt(volume: DockerVolume, at: string): Result<EgressCode> {
	const subpath = below(volume, at, "the egress proxy's code");
	if (!subpath.ok) return subpath;
	return ok({ dir: join(at, "docker"), packageJson: join(at, "package.json"), volume: { name: volume.name, root: subpath.value } });
}
