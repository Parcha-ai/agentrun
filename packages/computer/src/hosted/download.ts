// A files.read past one chunk on a host with download (src/host.ts): the daemon answers the first chunk, as it answers
// every read, and the rest comes from one copy of the file, made as the daemon's user (read-stage) and downloaded whole.
// On Daytona the bridge is a session command's log, read at about 0.3 MB/s (the sandbox bench, 11-25); its toolbox's
// files/download is not. The daemon's read is the check: a file it refuses is never copied, and the copy, opened as its
// user, holds what that user can read and nothing more, whatever the path names by the time it is copied.
import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { MachineHost } from "../host.js";
import { type ComputerClient, type DaemonMethod, type DaemonMethods, type FilesReadParams, MAX_CHUNK_BYTES } from "../protocol.js";
import { ok, type Result } from "../result.js";
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

/**
 * client, with every files.read past one chunk read from one downloaded copy after its first chunk. A first chunk (offset
 * 0, a whole chunk) whose file runs past it starts the copy; the reads after it, at the offsets the first's reader asks
 * for, are answered from the copy, as the daemon answers (eof once a read reaches the copy's size), and the copy is let
 * go at its end, at the next first chunk of its path, or at any call of another method, which may change a file. A copy
 * that fails at any step (the daemon's user unread, read-stage refused, the download, a size other than the daemon read)
 * leaves the daemon to answer every read, as on a host with no download. The copy in the machine is removed once it is
 * downloaded, without holding up the read.
 */
export function downloadingClient(host: MachineHost, download: NonNullable<MachineHost["download"]>, id: string, client: ComputerClient, bounds: DownloadBounds): ComputerClient {
	const copies = new Map<string, Promise<Uint8Array | undefined>>();
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

	/** path's copy, downloaded: its bytes when they are size long, else undefined. */
	const copyOf = async (path: string, size: number): Promise<Uint8Array | undefined> => {
		const who = await userOf();
		if (who === undefined) return undefined;
		const copy = `${READ_COPIES}/${randomBytes(16).toString("hex")}`;
		const unstage = () => void runToExit(host, id, readUnstage(copy), { ms: bounds.execMs, what: `removing the copy of ${path}` });
		const staged = await runToExit(host, id, readStage(who[0], who[1], path, copy), { ms: bounds.execMs, what: `copying ${path} as the daemon's user` });
		if (!staged.ok || staged.value.exitCode !== 0) {
			// One that never answered may yet write its copy.
			if (!staged.ok) unstage();
			return undefined;
		}
		const got = await hostCall(host, `downloading the copy of ${path}`, (ctx) => download(id, copy, ctx), bounds.downloadMs);
		unstage();
		return got.ok && got.value.length === size ? got.value : undefined;
	};

	return {
		async call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], options?: { signal?: AbortSignal }): Promise<Result<DaemonMethods[M]["result"]>> {
			if (method !== "files.read") {
				copies.clear();
				return client.call(method, params, options);
			}
			const read = params as FilesReadParams;
			const offset = read.offset ?? 0;
			if (offset === 0) {
				copies.delete(read.path);
				const first = await client.call(method, params, options);
				const answer = first.ok ? (first.value as DaemonMethods["files.read"]["result"]) : undefined;
				if (answer !== undefined && !answer.eof && answer.size > MAX_CHUNK_BYTES && copyable(read)) copies.set(read.path, copyOf(cleaned(read.path), answer.size));
				return first;
			}
			const copying = copies.get(read.path);
			const length = read.length ?? MAX_CHUNK_BYTES;
			if (copying === undefined || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK_BYTES) return client.call(method, params, options);
			const bytes = await untilAborted(copying, [options?.signal]);
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
			copies.clear();
			client.close();
		},
	};
}
