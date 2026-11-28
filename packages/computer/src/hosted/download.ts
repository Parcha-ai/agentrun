// A files.read past one chunk on a host with download (src/host.ts): the daemon answers the first chunk, as it answers
// every read, and the rest comes from one copy of the file, made as the daemon's user (read-stage) and downloaded whole.
// On Daytona the bridge is a session command's log, read at about 0.3 MB/s (the sandbox bench, 11-25); its toolbox's
// files/download is not. The daemon's read is the check: a file it refuses is never copied, and the copy, opened as its
// user, holds what that user can read and nothing more, whatever the path names by the time it is copied.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { MachineHost } from "../host.js";
import type { ComputerConnection } from "../provider.js";
import { type ComputerClient, type DaemonMethod, type DaemonMethods, type FilesReadParams, MAX_CHUNK_BYTES } from "../protocol.js";
import { ok, type Result } from "../result.js";
import { MAX_READ_BYTES } from "../surface/core.js";
import { hostCall, runToExit, untilAborted } from "./process.js";
import { READ_COPIES, readStage, readUnstage } from "./scripts.js";

export interface DownloadBounds {
	/** Each of read-stage and read-unstage, and the daemon's read of its own /proc/self/status. */
	execMs: number;
	/** The download of one copy. */
	downloadMs: number;
}

/**
 * An absolute path as computerd's files.read opens it: cleaned first (filepath.Clean, files.go cleanPath), so a ".."
 * takes off the name before it, a symlinked directory's or not. read-stage's cat opens the path as given, where a ".."
 * after a link leaves the link's target: it is given this one, the file the daemon read.
 */
const cleaned = (path: string) => posix.resolve(path);

/** A read the daemon may answer from a copy: an absolute path outside /proc (whose self is the reader's), a whole chunk. */
const copyable = ({ path, length }: FilesReadParams) => path.startsWith("/") && !cleaned(path).startsWith("/proc/") && (length === undefined || length === MAX_CHUNK_BYTES);

/** The bytes one connection's copies may hold at once: two files at the read limit. */
const COPIES_BYTES = 2 * MAX_READ_BYTES;

/** A file a first chunk found worth copying: the copy starts at the first read past that chunk, and stop ends it. */
interface Copy {
	path: string;
	size: number;
	stop: AbortController;
	bytes?: Promise<Uint8Array | undefined>;
}

/**
 * connection, with every files.read past one chunk read from one downloaded copy after its first chunk. A first chunk
 * (offset 0, a whole chunk) whose file runs past it, and is at most the surface's read limit (MAX_READ_BYTES, all a copy
 * holds in memory), makes its file one to copy; a larger file is the daemon's, chunk by chunk. The copy starts at the
 * first read past that chunk, so a reader that stops at one chunk copies nothing. The reads after it, at the offsets the
 * first's reader asks for, are answered from the copy, as the daemon answers (eof once a read reaches the copy's size),
 * and the copy is let go at its end, at the next first chunk of its path, at any call of another method, which may change
 * a file, or, the oldest first, once the files to copy pass COPIES_BYTES in all. A copy let go while it is still coming
 * is stopped, and the reads waiting on it are the daemon's. A copy that fails at any step (the daemon's user unread,
 * read-stage refused, the download, a size other than the daemon read) leaves the daemon to answer every read, as on a
 * host with no download. The copy in the machine is removed once it is downloaded, without holding up the read. A close
 * of the connection or of its client lets every copy go: each read after it, or still waiting on a copy, is the closed
 * daemon client's (gone).
 */
export function downloadingConnection(
	host: MachineHost,
	download: NonNullable<MachineHost["download"]>,
	id: string,
	connection: ComputerConnection,
	bounds: DownloadBounds,
): ComputerConnection {
	const { client } = connection;
	const copies = new Map<string, Copy>();
	let closed = false;
	let user: Promise<[string, string] | undefined> | undefined;

	/** The daemon's uid and gid, from its own /proc/self/status: each of its four ids the same, else none. */
	const userOf = () =>
		(user ??= (async () => {
			const status = await client.call("files.read", { path: "/proc/self/status" }, { signal: AbortSignal.timeout(bounds.execMs) });
			const text = status.ok ? Buffer.from(status.value.data, "base64").toString("utf8") : "";
			const ids = (name: string) => new RegExp(`^${name}:\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*$`, "m").exec(text)?.slice(1) ?? [];
			const [uids, gids] = [ids("Uid"), ids("Gid")];
			const one = (found: string[]) => (found.length === 4 && found.every((each) => each === found[0]) ? found[0] : undefined);
			const [uid, gid] = [one(uids), one(gids)];
			if (uid !== undefined && gid !== undefined) return [uid, gid] as [string, string];
			user = undefined;
			return undefined;
		})());

	/** path's copy, downloaded until signal aborts: its bytes when they are size long, else undefined. */
	const copyOf = async (path: string, size: number, signal: AbortSignal): Promise<Uint8Array | undefined> => {
		const who = await userOf();
		if (who === undefined) return undefined;
		const copy = `${READ_COPIES}/${randomBytes(16).toString("hex")}`;
		const unstage = () => void runToExit(host, id, readUnstage(copy), { ms: bounds.execMs, what: `removing the copy of ${path}` });
		const staged = await runToExit(host, id, readStage(who[0], who[1], path, copy), { ms: bounds.execMs, signal, what: `copying ${path} as the daemon's user` });
		if (!staged.ok || staged.value.exitCode !== 0) {
			// One that never answered may yet write its copy.
			if (!staged.ok) unstage();
			return undefined;
		}
		const got = await hostCall(host, `downloading the copy of ${path}`, (ctx) => download(id, copy, ctx), bounds.downloadMs, signal);
		unstage();
		return got.ok && got.value.length === size ? got.value : undefined;
	};

	/** key's copy let go, and stopped if it is still coming. */
	const letGo = (key: string) => {
		copies.get(key)?.stop.abort();
		copies.delete(key);
	};
	const letAllGo = () => {
		for (const key of copies.keys()) letGo(key);
	};
	const drop = () => {
		closed = true;
		letAllGo();
	};

	const reading: ComputerClient = {
		async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options?: { signal?: AbortSignal }): Promise<Result<DaemonMethods[M]["result"]>> {
			if (method !== "files.read" || closed) {
				letAllGo();
				return client.call(method, params, options);
			}
			const read = params as FilesReadParams;
			const offset = read.offset ?? 0;
			if (offset === 0) {
				letGo(read.path);
				const first = await client.call(method, params, options);
				const answer = first.ok ? (first.value as DaemonMethods["files.read"]["result"]) : undefined;
				if (answer !== undefined && !answer.eof && answer.size > MAX_CHUNK_BYTES && answer.size <= MAX_READ_BYTES && copyable(read)) {
					// Room for it within COPIES_BYTES: the oldest let go first.
					let held = answer.size;
					for (const each of copies.values()) held += each.size;
					for (const [key, each] of copies) {
						if (held <= COPIES_BYTES) break;
						held -= each.size;
						letGo(key);
					}
					copies.set(read.path, { path: cleaned(read.path), size: answer.size, stop: new AbortController() });
				}
				return first;
			}
			const copy = copies.get(read.path);
			const length = read.length ?? MAX_CHUNK_BYTES;
			if (copy === undefined || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK_BYTES) return client.call(method, params, options);
			copy.bytes ??= copyOf(copy.path, copy.size, copy.stop.signal);
			const bytes = await untilAborted(copy.bytes, [options?.signal, copy.stop.signal]);
			if (bytes === undefined) {
				if (!options?.signal?.aborted) copies.delete(read.path);
				return client.call(method, params, options);
			}
			const data = bytes.subarray(offset, offset + length);
			const eof = data.length < length || offset + data.length >= bytes.length;
			if (eof) copies.delete(read.path);
			const answer: DaemonMethods["files.read"]["result"] = { data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"), eof, size: bytes.length };
			return ok(answer) as Result<DaemonMethods[M]["result"]>;
		},
		close() {
			drop();
			client.close();
		},
	};
	return {
		...connection,
		client: reading,
		close() {
			drop();
			return connection.close();
		},
	};
}
