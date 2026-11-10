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
// and renamed into place, and reused when one that holds the same is already there. A published tree is NEVER removed
// or written over: Docker may have it mounted in a running computer, which another provider sharing daemonCache could
// pull its daemon out from under. A name that holds a tree that does not hold the same is left as it is, and the new
// tree is published beside it (stageTree). A source is read only when it is a regular file, opened without blocking, so
// a named pipe at its path is refused in words, never waited on. Never throws: every failure is a Result in words.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The published tree in `dir` that holds `entries`: `<name>` itself, else a sibling `<name>-<random>` one was published
 * under when `<name>` held a tree that did not. Undefined when none does.
 */
function heldTree(dir: string, name: string, entries: Entry[]): string | undefined {
	const at = join(dir, name);
	if (holds(at, entries)) return at;
	let siblings: string[];
	try {
		siblings = readdirSync(dir).filter((entry) => entry.startsWith(`${name}-`)).sort();
	} catch {
		return undefined;
	}
	return siblings.map((entry) => join(dir, entry)).find((path) => holds(path, entries));
}

/**
 * The tree `<prefix>-<sha>` in `directory`, made when none holding `entries` is there (see the head). A published tree
 * is never removed or written over, since Docker may have it mounted in a running computer: the whole temporary tree is
 * renamed into place only where nothing is (publish); when another writer published first, its tree is used if it
 * holds; and when the name holds a tree that does not (a crash, a hand edit), the new one goes beside it.
 */
function stageTree(directory: string, prefix: string, entries: Entry[], what: string): Result<string> {
	const dir = privateCacheDirectory(directory);
	if (!dir.ok) return dir;
	const sha = shaOf(entries);
	const name = `${prefix}-${sha}`;
	const at = join(dir.value, name);
	const held = heldTree(dir.value, name, entries);
	if (held !== undefined) return ok(held);
	const temp = join(dir.value, `.${prefix}-${sha}.${randomBytes(8).toString("hex")}.tmp`);
	let published = at;
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
		published = publish(temp, at, entries);
	} catch (error) {
		return fail("invalid", `cannot stage ${what} in ${at}: ${wordsOf(error)}`);
	} finally {
		// Only the temporary tree, which no one else has seen, is ever removed; once renamed it is no longer here.
		rmSync(temp, { recursive: true, force: true });
	}
	return holds(published, entries) ? ok(published) : fail("invalid", `${what} staged in ${published} did not hold its files, 0755 directories and its modes, once written`);
}

/**
 * The whole temporary tree `temp` renamed into place at `at`, where nothing is: its path. When `at` is taken (another
 * writer published first, or a tree that does not hold is there; a rename onto a directory that is not empty fails with
 * EEXIST or ENOTEMPTY and leaves it as it was), the tree at `at` is used when it holds, and otherwise `temp` is published
 * beside it under a fresh name. Nothing already published is ever removed or written over.
 */
function publish(temp: string, at: string, entries: Entry[]): string {
	try {
		renameSync(temp, at);
		return at;
	} catch (error) {
		if (!["EEXIST", "ENOTEMPTY"].includes(codeOf(error) ?? "")) throw error;
	}
	if (holds(at, entries)) return at;
	const beside = `${at}-${randomBytes(8).toString("hex")}`;
	renameSync(temp, beside);
	return beside;
}

/** Where the tree for `entries` is in `directory` (the published one that holds them, as stageTree would use it), or
 *  would be: read only, for a read-back. */
function treeAt(directory: string, prefix: string, entries: Entry[]): string {
	let base: string;
	try {
		base = realpathSync(directory);
	} catch {
		base = resolve(directory);
	}
	const name = `${prefix}-${shaOf(entries)}`;
	return heldTree(base, name, entries) ?? join(base, name);
}

/**
 * The bytes of the regular file at `path`, as daemonCopy reads the daemon: opened with O_NONBLOCK, so a named pipe with
 * no writer is not waited on, and checked to be a regular file before it is read. Anything else is refused in words;
 * `what` names it, and `missing` is the advice when it is not there.
 */
function readRegular(path: string, what: string, missing: string): Result<Buffer> {
	const notFile = () => fail("not_found", `${what} at ${path} is not a regular file: ${missing}`);
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		const code = codeOf(error);
		return code === "ENOENT" || code === "ENOTDIR" ? fail("not_found", `${what} at ${path} is not there: ${missing}`) : fail("invalid", `${what} at ${path} cannot be read (${code ?? wordsOf(error)})`);
	}
	try {
		if (!fstatSync(fd).isFile()) return notFile();
		return ok(readFileSync(fd));
	} catch (error) {
		return fail("invalid", `${what} at ${path} cannot be read (${codeOf(error) ?? wordsOf(error)})`);
	} finally {
		closeSync(fd);
	}
}

/** The daemon's tree's entries: computerd, 0755, read from `source`, and the egress volume's mount point. */
function daemonEntries(source: string): Result<Entry[]> {
	const bytes = readRegular(source, "the daemon", "run npm run build:daemon -w @parcha/agentrun-computer");
	if (!bytes.ok) return bytes;
	return ok([
		{ path: "computerd", bytes: bytes.value, mode: 0o755 },
		{ path: "egress", mode: 0o755 },
	]);
}

/** The proxy's tree's entries: docker/<module> (0644) and package.json (0644), read from this package's build. */
function egressEntries(code: EgressCode): Result<Entry[]> {
	const entries: Entry[] = [];
	for (const [path, source] of [...CODE_FILES.map((file) => [`docker/${file}`, join(code.dir, file)]), ["package.json", code.packageJson]] as Array<[string, string]>) {
		const bytes = readRegular(source, "the egress proxy's code", "build it: npm run build -w @parcha/agentrun-computer");
		if (!bytes.ok) return bytes;
		entries.push({ path, bytes: bytes.value, mode: 0o644 });
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

/**
 * Where the egress proxy's code staged in `directory` is, read only: for a read-back. Its `accepts` takes a mounted
 * subpath that is any verified copy (verifiedTree), not only the one staging would use now: two providers that
 * published copies beside a tree that no longer held each mounted their own, and both are as create makes one.
 */
export function egressStaged(code: EgressCode, directory: string, volume: DockerVolume): Result<EgressCode> {
	const entries = egressEntries(code);
	if (!entries.ok) return entries;
	const found = codeAt(volume, treeAt(directory, "egress", entries.value));
	if (!found.ok || found.value.volume === undefined) return found;
	const accepts = (subpath: string) => subpath === found.value.volume?.root || verifiedTree(directory, "egress", entries.value, volume, subpath) !== undefined;
	return ok({ ...found.value, volume: { ...found.value.volume, accepts } });
}

/**
 * The daemon's tree a computer mounts at `subpath` of the volume, when it is a verified copy of the daemon at `source`
 * (verifiedTree): its path. For the read-back of a computer mounted on a copy other than the one staging uses now.
 */
export function daemonVerified(source: string, directory: string, volume: DockerVolume, subpath: string): string | undefined {
	const entries = daemonEntries(source);
	return entries.ok ? verifiedTree(directory, "daemon", entries.value, volume, subpath) : undefined;
}

/**
 * The tree at `subpath` of the volume when it is a published copy of `entries` in `directory`: named `<prefix>-<sha>`
 * or `<prefix>-<sha>-<anything>` (a copy published beside one that no longer held), directly in the staging directory,
 * and holding every entry with its bytes and modes, as heldTree checks. Its path; else undefined.
 */
function verifiedTree(directory: string, prefix: string, entries: Entry[], volume: DockerVolume, subpath: string): string | undefined {
	let base: string;
	try {
		base = realpathSync(directory);
	} catch {
		base = resolve(directory);
	}
	const staging = subpathOf(volume, base, { orRoot: true });
	const parts = subpath.split("/");
	const leaf = parts.pop() ?? "";
	if (staging === undefined || parts.join("/") !== staging || parts.includes("..") || parts.includes(".")) return undefined;
	const name = `${prefix}-${shaOf(entries)}`;
	if (leaf !== name && !leaf.startsWith(`${name}-`)) return undefined;
	const path = join(base, leaf);
	return holds(path, entries) ? path : undefined;
}

/** The staged proxy tree at `at` as an EgressCode: its own paths, and its subpath of the volume. */
function codeAt(volume: DockerVolume, at: string): Result<EgressCode> {
	const subpath = below(volume, at, "the egress proxy's code");
	if (!subpath.ok) return subpath;
	return ok({ dir: join(at, "docker"), packageJson: join(at, "package.json"), volume: { name: volume.name, root: subpath.value } });
}
