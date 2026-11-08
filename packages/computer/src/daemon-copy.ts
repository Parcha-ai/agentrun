// The daemon file a Docker computer binds: this process's own copy of the provider's daemon, mode 0755, named by the
// sha256 of its bytes, in a directory only this process's user may enter. npm installs the package's daemons at 0755
// minus the installer's umask (0700 under umask 077), and a bind shows the computer the host file's own mode, so a
// computer's user, which has no capabilities, could not run the installed file itself. The daemon is every computer's
// init, so the directory is checked, never trusted: not a link, this user's, mode 0700, and no directory above it
// writable by another user, who could otherwise swap it out between the check and docker run.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fail, ok, type Result } from "./result.js";

/** The default directory for the copies: agentrun-computer under XDG_CACHE_HOME when it is absolute, else ~/.cache. */
export function defaultDaemonCache(env: Record<string, string | undefined> = process.env): string {
	const xdg = env.XDG_CACHE_HOME;
	return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "agentrun-computer");
}

const octal = (mode: number) => mode.toString(8).padStart(4, "0");
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
const wordsOf = (error: unknown) => (error as Error).message;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const ELSEWHERE = "or give the provider another daemonCache";

/**
 * The path of a 0755 copy of the daemon at `source` in `directory`, named computerd-<sha256>, made if it is not there
 * yet and hashed again before it is returned; or a refusal in words. A copy is written to a temporary file in the
 * directory and renamed into place, so processes copying the same daemon at once each leave a whole file, and only the
 * same bytes ever take that name.
 */
export function daemonCopy(source: string, directory: string): Result<string> {
	const uid = process.getuid?.();
	if (uid === undefined) return fail("unsupported", "this platform has no user ids, so the provider cannot keep the daemon's copy where only this user may change it");
	let bytes: Buffer;
	try {
		// O_NONBLOCK: a FIFO at the path fails the isFile check below instead of holding the open.
		const fd = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			if (!fstatSync(fd).isFile()) return fail("not_found", `no daemon binary at ${source}: run npm run build:daemon -w @parcha/agentrun-computer`);
			bytes = readFileSync(fd);
		} finally {
			closeSync(fd);
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
	const dir = privateDirectory(resolve(directory), uid);
	if (!dir.ok) return dir;
	const path = join(dir.value, `computerd-${sha}`);
	const found = copyState(path, sha, uid);
	if (found !== "replace" && found !== "absent") return found;
	const temp = join(dir.value, `.computerd-${sha}.${randomBytes(8).toString("hex")}.tmp`);
	try {
		const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
		try {
			writeFileSync(fd, bytes);
			// fchmod is not narrowed by the umask: the copy is 0755 whatever it is.
			fchmodSync(fd, 0o755);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// Never made, or already renamed.
		}
		return fail("invalid", `cannot copy the daemon at ${source} to ${path}: ${wordsOf(error)}`);
	}
	const made = copyState(path, sha, uid);
	if (made === "replace" || made === "absent") return fail("invalid", `the daemon's copy at ${path} did not hold the daemon's bytes, mode 0755 and this user's ownership once written`);
	return made;
}

/** The copy at `path` as found: whole (its path), to be written, or a refusal. It is opened without following a link. */
function copyState(path: string, sha: string, uid: number): Result<string> | "absent" | "replace" {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = codeOf(error);
		if (code === "ENOENT") return "absent";
		// O_NOFOLLOW on a link fails with ELOOP on Linux and macOS, EMLINK on FreeBSD.
		if (code === "ELOOP" || code === "EMLINK") return fail("refused", `the daemon's copy at ${path} is a symbolic link; the provider binds only a file it wrote itself and never follows a link there: remove it, ${ELSEWHERE}`);
		return fail("invalid", `cannot read the daemon's copy at ${path}: ${wordsOf(error)}`);
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return fail("refused", `the daemon's copy at ${path} is not a regular file; the provider binds only a file it wrote itself: remove it, ${ELSEWHERE}`);
		if (stat.uid !== uid || (stat.mode & 0o7777) !== 0o755) return "replace";
		return sha256(readFileSync(fd)) === sha ? ok(path) : "replace";
	} finally {
		closeSync(fd);
	}
}

/**
 * `directory` made if missing (mode 0700, and its missing parents too), as a path with no link in it, once it and every
 * directory above it pass: it is a directory, not a link, this user's, mode 0700; each one above is root's or this
 * user's, and no other user may write it unless it is sticky (as /tmp is), where no other user may move this one's
 * entries. Nothing is ever chmodded or chowned: a directory that fails is refused in words.
 */
function privateDirectory(directory: string, uid: number): Result<string> {
	const parent = dirname(directory);
	let real: string;
	try {
		mkdirSync(parent, { recursive: true, mode: 0o700 });
		real = realpathSync(parent);
	} catch (error) {
		return fail("invalid", `cannot make ${parent}, the directory the daemon copy directory goes in: ${wordsOf(error)}; make it, ${ELSEWHERE}`);
	}
	for (let at = real; ; at = dirname(at)) {
		const stat = lstatSync(at);
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
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if (codeOf(error) !== "EEXIST") return fail("invalid", `cannot make the daemon copy directory ${path}: ${wordsOf(error)}; ${ELSEWHERE}`);
	}
	const stat = lstatSync(path);
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
