// The daemon file a Docker computer binds: this process's own copy of the provider's daemon, mode 0755, named by the
// sha256 of its bytes, in a directory only this process's user may enter. npm installs the package's daemons at 0755
// minus the installer's umask (0700 under umask 077), and a bind shows the computer the host file's own mode, so a
// computer's user, which has no capabilities, could not run the installed file itself. The daemon is every computer's
// init, so the directory is checked, never trusted: not a link, this user's, mode 0700, and no directory above it
// writable by another user, who could otherwise swap it out between the check and docker run.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fail, ok, type Result } from "./result.js";

/** The default directory for the copies: agentrun-computer under XDG_CACHE_HOME when it is absolute, else ~/.cache. */
export function defaultDaemonCache(env: Record<string, string | undefined> = process.env): string {
	const xdg = env.XDG_CACHE_HOME;
	return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "agentrun-computer");
}

/** The file operations daemonCopy uses: node:fs's own, or, in a test, a wrapper of them that fails one call. */
export interface CopyFs {
	closeSync: typeof closeSync;
	fchmodSync: typeof fchmodSync;
	fstatSync: (fd: number) => Stats;
	fsyncSync: typeof fsyncSync;
	lstatSync: (path: string) => Stats;
	mkdirSync: (path: string, options: { recursive?: boolean; mode: number }) => unknown;
	openSync: (path: string, flags: number, mode?: number) => number;
	readFileSync: (fd: number) => Buffer;
	realpathSync: (path: string) => string;
	renameSync: typeof renameSync;
	unlinkSync: typeof unlinkSync;
	writeFileSync: (fd: number, data: Buffer) => void;
}

const NODE_FS: CopyFs = {
	closeSync,
	fchmodSync,
	fstatSync: (fd) => fstatSync(fd),
	fsyncSync,
	lstatSync: (path) => lstatSync(path),
	mkdirSync: (path, options) => mkdirSync(path, options),
	openSync: (path, flags, mode) => openSync(path, flags, mode),
	readFileSync: (fd) => readFileSync(fd),
	realpathSync: (path) => realpathSync(path),
	renameSync,
	unlinkSync,
	writeFileSync: (fd, data) => writeFileSync(fd, data),
};

const octal = (mode: number) => mode.toString(8).padStart(4, "0");
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const wordsOf = (error: unknown) => (error as Error).message;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ELSEWHERE = "or give the provider another daemonCache";

/**
 * The path of a 0755 copy of the daemon at `source` in `directory`, named computerd-<sha256>, made if it is not there
 * yet and hashed again before it is returned; or a refusal in words. A copy is written to a temporary file in the
 * directory and renamed into place, so processes copying the same daemon at once each leave a whole file, and only the
 * same bytes ever take that name. A directory that is gone partway (a cache cleaner) is made again and checked again,
 * once. Never throws: every failure is a Result in words naming its path. `fs` is node:fs's own but in tests.
 */
export function daemonCopy(source: string, directory: string, fs: CopyFs = NODE_FS): Result<string> {
	const uid = process.getuid?.();
	if (uid === undefined) return fail("unsupported", "this platform has no user ids, so the provider cannot keep the daemon's copy where only this user may change it");
	let bytes: Buffer;
	try {
		// O_NONBLOCK: a FIFO at the path fails the isFile check below instead of holding the open.
		const fd = fs.openSync(source, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			if (!fs.fstatSync(fd).isFile()) return fail("not_found", `no daemon binary at ${source}: run npm run build:daemon -w @parcha/agentrun-computer`);
			bytes = fs.readFileSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		const code = codeOf(error);
		if (code === "ENOENT" || code === "ENOTDIR") return fail("not_found", `no daemon binary at ${source}: run npm run build:daemon -w @parcha/agentrun-computer`);
		return fail(
			"invalid",
			`the daemon at ${source} cannot be read by this process (${code ?? wordsOf(error)}): the provider copies it for each computer, so this process's user must be able to read it`,
		);
	}
	const sha = sha256(bytes);
	// A directory a cleaner removes while it is checked or written in is made again, once.
	const first = copyInto(fs, resolve(directory), sha, bytes, uid, source);
	if (!("vanished" in first)) return first;
	const second = copyInto(fs, resolve(directory), sha, bytes, uid, source);
	if (!("vanished" in second)) return second;
	return fail(
		"invalid",
		`the daemon copy directory ${resolve(directory)} vanished while the provider checked it or copied the daemon into it, twice (${second.vanished} was gone), as a cleaner removing it does; ${ELSEWHERE}`,
	);
}

/** A directory that was there and is gone, at this path: the caller makes it again once. */
interface Vanished {
	vanished: string;
}

/** daemonCopy's work in its directory: the copy's path, a refusal, or the directory gone under it. */
function copyInto(fs: CopyFs, directory: string, sha: string, bytes: Buffer, uid: number, source: string): Result<string> | Vanished {
	const dir = privateDirectory(fs, directory, uid);
	if ("vanished" in dir || !dir.ok) return dir;
	const path = join(dir.value, `computerd-${sha}`);
	const found = copyState(fs, path, sha, uid);
	if (found !== "replace" && found !== "absent") return found;
	const temp = join(dir.value, `.computerd-${sha}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		const fd = fs.openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
		try {
			fs.writeFileSync(fd, bytes);
			// fchmod is not narrowed by the umask: the copy is 0755 whatever it is.
			fs.fchmodSync(fd, 0o755);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temp, path);
	} catch (error) {
		try {
			fs.unlinkSync(temp);
		} catch {
			// Never made, or already renamed.
		}
		// The temporary file cannot be made, or renamed, in a directory that is gone.
		if (codeOf(error) === "ENOENT") return { vanished: dir.value };
		return fail("invalid", `cannot copy the daemon at ${source} to ${path}: ${wordsOf(error)}`);
	}
	const made = copyState(fs, path, sha, uid);
	if (made === "absent") return { vanished: dir.value };
	if (made === "replace") return fail("invalid", `the daemon's copy at ${path} did not hold the daemon's bytes, mode 0755 and this user's ownership once written`);
	return made;
}

const LINK_WORDS = "the provider binds only a file it wrote itself and never follows a link there";

/**
 * The copy at `path` as found: whole (its path), absent, to be written over, or a refusal. Its entry is read with
 * lstat first, so a copy this user cannot open (mode 0000 or 0111) is written over like any other wrong mode, and a
 * link or another user's file is refused before anything opens it; a 0755 copy of this user's is then opened without
 * following a link and hashed. Every failure to read it is a Result naming it.
 */
function copyState(fs: CopyFs, path: string, sha: string, uid: number): Result<string> | "absent" | "replace" {
	const cannot = (error: unknown) => fail("invalid", `cannot read the daemon's copy at ${path}: ${wordsOf(error)}`);
	let entry: Stats;
	try {
		entry = fs.lstatSync(path);
	} catch (error) {
		return codeOf(error) === "ENOENT" ? "absent" : cannot(error);
	}
	if (entry.isSymbolicLink()) return fail("refused", `the daemon's copy at ${path} is a symbolic link; ${LINK_WORDS}: remove it, ${ELSEWHERE}`);
	if (!entry.isFile()) return fail("refused", `the daemon's copy at ${path} is not a regular file; the provider binds only a file it wrote itself: remove it, ${ELSEWHERE}`);
	if (entry.uid !== uid) {
		return fail("refused", `the daemon's copy at ${path} is owned by uid ${entry.uid}, not this process's uid ${uid}; the provider binds only a file it wrote itself: remove it, ${ELSEWHERE}`);
	}
	if ((entry.mode & 0o7777) !== 0o755) return "replace";
	let fd: number;
	try {
		fd = fs.openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = codeOf(error);
		if (code === "ENOENT") return "absent";
		// Made a link since the lstat: O_NOFOLLOW fails with ELOOP on Linux and macOS, EMLINK on FreeBSD.
		if (code === "ELOOP" || code === "EMLINK") return fail("refused", `the daemon's copy at ${path} is a symbolic link; ${LINK_WORDS}: remove it, ${ELSEWHERE}`);
		return cannot(error);
	}
	try {
		const stat = fs.fstatSync(fd);
		// The file opened is checked itself: another process of this user's may have renamed its identical copy over the
		// one lstat read, which is as good. One that is not a 0755 file of this user's is written over, then checked again.
		if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o755) return "replace";
		return sha256(fs.readFileSync(fd)) === sha ? ok(path) : "replace";
	} catch (error) {
		return cannot(error);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * `directory` made if missing (mode 0700, and its missing parents too), as a path with no link in it, once it and every
 * directory above it pass: it is a directory, not a link, this user's, mode 0700; each one above is root's or this
 * user's, and no other user may write it unless it is sticky (as /tmp is), where no other user may move this one's
 * entries. Nothing is ever chmodded or chowned: a directory that fails is refused in words, one that cannot be checked
 * is a Result naming it, and one that is gone when it is checked (a cleaner removed it) is Vanished.
 */
function privateDirectory(fs: CopyFs, directory: string, uid: number): Result<string> | Vanished {
	const parent = dirname(directory);
	let real: string;
	try {
		fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
		real = fs.realpathSync(parent);
	} catch (error) {
		return fail("invalid", `cannot make ${parent}, the directory the daemon copy directory goes in: ${wordsOf(error)}; make it, ${ELSEWHERE}`);
	}
	for (let at = real; ; at = dirname(at)) {
		let stat: Stats;
		try {
			stat = fs.lstatSync(at);
		} catch (error) {
			if (codeOf(error) === "ENOENT") return { vanished: at };
			return fail("invalid", `cannot check ${at}, above the daemon copy directory ${directory}: ${wordsOf(error)}; ${ELSEWHERE}`);
		}
		if (stat.uid !== 0 && stat.uid !== uid) {
			return fail("refused", `${at}, above the daemon copy directory ${directory}, is owned by uid ${stat.uid}: only root or this process's uid ${uid} may own the directories above it, since their owner could swap it out; ${ELSEWHERE}`);
		}
		if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
			return fail("refused", `${at} has mode ${octal(stat.mode & 0o7777)}: a user other than its owner may write it, and so swap out the daemon copy directory ${directory} under it; ${ELSEWHERE}`);
		}
		if (dirname(at) === at) break;
	}
	const path = join(real, basename(directory));
	try {
		fs.mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		const code = codeOf(error);
		if (code === "ENOENT") return { vanished: real };
		if (code !== "EEXIST") return fail("invalid", `cannot make the daemon copy directory ${path}: ${wordsOf(error)}; ${ELSEWHERE}`);
	}
	let stat: Stats;
	try {
		stat = fs.lstatSync(path);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return { vanished: path };
		return fail("invalid", `cannot check the daemon copy directory ${path}: ${wordsOf(error)}; ${ELSEWHERE}`);
	}
	if (stat.isSymbolicLink()) {
		return fail("refused", `the daemon copy directory ${path} is a symbolic link; the provider binds the daemon only from a directory this user owns, and never follows a link there: remove it, ${ELSEWHERE}`);
	}
	if (!stat.isDirectory()) return fail("refused", `the daemon copy directory ${path} is not a directory: remove it, ${ELSEWHERE}`);
	if (stat.uid !== uid) {
		return fail("refused", `the daemon copy directory ${path} is owned by uid ${stat.uid}, not this process's uid ${uid}; only this user may own the directory every computer's init is bound from: ${ELSEWHERE}`);
	}
	if ((stat.mode & 0o777) !== 0o700) {
		return fail(
			"refused",
			`the daemon copy directory ${path} has mode ${octal(stat.mode & 0o777)}; it must be 0700, so that only this user may enter it, and the provider never changes it: chmod 700 it, ${ELSEWHERE}`,
		);
	}
	return ok(path);
}
