// The synced folder's delta: what changed in a computer's /workspace since the last sync, written to the runner's copy
// of the run's folder (a SyncSink) before the call that changed it answers. It needs no protocol of its own: one
// files.list of the folder (paged, pipelined) against the manifest of the last, then files.read or tar.pull for the
// bytes that changed. Directories, modes and links come from the listing alone, with no bytes.
//
// Known miss: a write that leaves a file's size and mtime both as they were (`touch -d`, `cp -p` onto a file of the same
// size) is not seen. A same-size rewrite within the same millisecond is, by the racy rule (git's): a file whose mtime is
// within 1 s of the newest in its listing is pulled again at the first sync at least 1 s later. Bytes read that are the
// ones last put there (that re-read, a touch) are not put again. While a directory the computer's user can't read hides
// what the sink holds under it (files.list lists one without what it holds), a sync writes nothing and fails in words.
import { createHash } from "node:crypto";
import { pullTarStream } from "./files.js";
import { WORKSPACE } from "./mount.js";
import { type ComputerClient, type FileEntry, MAX_CHUNK_BYTES, MAX_LIST_DEPTH, MAX_LIST_ENTRIES } from "./protocol.js";
import { type ComputerErrorCode, fail, ok, type Result } from "./result.js";
import { untarStream } from "./tar.js";

/** The most entries (files, directories and links) a synced folder holds: over it, a sync fails, kind limit. */
export const SYNC_MAX_ENTRIES = 20_000;
/** The most bytes a synced folder's files hold together: over it, a sync fails, kind limit. */
export const SYNC_MAX_BYTES = 2 * 1024 ** 3;
/** How many pulls (files.read or tar.pull) are in flight at once, and how many puts: computerd's MaxPulls is 8. */
const IN_FLIGHT = 8;
/** A file whose mtime is within this of the newest in its listing may be rewritten unseen in the same millisecond. */
const RACY_MS = 1000;
const TOO_MANY = `the run's folder holds more than ${SYNC_MAX_ENTRIES} entries, the most a synced folder holds`;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

/**
 * The folder's modes and links: what an object store keeps no record of. A mode is listed where it is not the default
 * (0644 for a file, 0755 for a directory); a link by its target, as written, never followed.
 */
export interface FolderMeta {
	modes: Record<string, number>;
	links: Record<string, string>;
}

/**
 * Where the delta lands: the runner's copy of the run's folder. Every path is relative to the folder and passed the
 * relative-path rule (no absolute path, no "." or ".." or empty segment, no backslash, no NUL). Each answers once what
 * it wrote is durable; a failure is retried at the next sync, so each must be idempotent.
 */
export interface SyncSink {
	/** A file's bytes at path, replacing what was there. */
	put(path: string, body: Uint8Array): Promise<Result<void>>;
	/** An empty directory at path, which no file under it records. */
	mkdir(path: string): Promise<Result<void>>;
	/** What path held: a file, or a directory's own record. What is under a directory comes first, each on its own. */
	remove(path: string, type: "file" | "dir"): Promise<Result<void>>;
	/** The folder's modes and links, whole, written only when they changed. */
	meta(meta: FolderMeta): Promise<Result<void>>;
}

/** What one sync wrote. */
export interface SyncCounts {
	put: number;
	mkdir: number;
	removed: number;
	meta: boolean;
}

/**
 * An entry of the folder as the manifest knows it; settled: its bytes were read at least RACY_MS after any listing that
 * found it racy; sha256: a file's bytes as last put (none for what baseline() read).
 */
interface Known {
	type: "file" | "dir" | "symlink";
	size: number;
	mtimeMs: number;
	mode: number;
	target?: string;
	settled: boolean;
	sha256?: string;
}

/** Why a path in the folder is no relative path a sink takes, in words, or undefined when it is one. */
export function folderPathProblem(path: string): string | undefined {
	if (path === "") return "is empty";
	if (path.includes("\0")) return "holds a NUL";
	if (path.includes("\\")) return "holds a backslash";
	if (path.startsWith("/")) return "is absolute";
	for (const segment of path.split("/")) {
		if (segment === "") return "has an empty segment";
		if (segment === "." || segment === "..") return `has a "${segment}" segment`;
	}
	return undefined;
}

const depthOf = (path: string) => path.split("/").length;
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const under = (path: string, dir: string) => path.startsWith(`${dir}/`);
const deepestFirst = (a: string, b: string) => depthOf(b) - depthOf(a) || (a < b ? -1 : 1);

/** At most n at once: acquire() answers once a slot is free, with its release. */
class Slots {
	#free: number;
	#waiting: Array<() => void> = [];
	constructor(n: number) {
		this.#free = n;
	}
	async acquire(): Promise<() => void> {
		if (this.#free > 0) this.#free--;
		else await new Promise<void>((resolve) => this.#waiting.push(resolve));
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiting.shift();
			if (next) next();
			else this.#free++;
		};
	}
	async run<T>(work: () => Promise<T>): Promise<T> {
		const release = await this.acquire();
		try {
			return await work();
		} finally {
			release();
		}
	}
}

/** The folder's modes and links, from a listing; built by fromEntries, so a path such as `__proto__` is a key like any. */
function metaOf(listing: ReadonlyMap<string, FileEntry>): FolderMeta {
	const modes: [string, number][] = [];
	const links: [string, string][] = [];
	for (const [path, entry] of [...listing].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (entry.type === "symlink") links.push([path, entry.target ?? ""]);
		else if (entry.mode !== (entry.type === "dir" ? DIR_MODE : FILE_MODE)) modes.push([path, entry.mode]);
	}
	return { modes: Object.fromEntries(modes), links: Object.fromEntries(links) };
}

const knownOf = (entry: FileEntry, settled: boolean): Known => ({
	type: entry.type as Known["type"],
	size: entry.size,
	mtimeMs: entry.mtimeMs,
	mode: entry.mode,
	...(entry.target === undefined ? {} : { target: entry.target }),
	settled,
});

/**
 * One synced folder: the computer's /workspace (root) through its computerd client, and the sink it lands in. baseline()
 * reads what a push left as the manifest; each sync() then writes what changed since. One sync at a time (syncingClient
 * runs one); `now` is the runner's clock, for the racy rule.
 */
export class FolderSync {
	readonly #client: ComputerClient;
	readonly #sink: SyncSink;
	readonly #root: string;
	readonly #now: () => number;
	#manifest = new Map<string, Known>();
	/** Files found racy, by the runner's time of the listing that found them. */
	#racy = new Map<string, number>();
	/** The meta last written, as JSON; undefined before any. */
	#meta: string | undefined;

	constructor(client: ComputerClient, sink: SyncSink, { root = WORKSPACE, now = Date.now }: { root?: string; now?: () => number } = {}) {
		this.#client = client;
		this.#sink = sink;
		this.#root = root;
		this.#now = now;
	}

	/**
	 * The manifest of a folder just pushed from the sink, read, never guessed (extraction sets no mtime): what it lists is
	 * what the sink holds, so nothing is pulled. Over a cap, it fails, kind limit.
	 */
	async baseline(options: { signal?: AbortSignal } = {}): Promise<Result<void>> {
		const listed = await this.#list(options.signal);
		if (!listed.ok) return listed;
		this.#manifest = new Map([...listed.value].map(([path, entry]) => [path, knownOf(entry, true)]));
		this.#racy.clear();
		this.#meta = JSON.stringify(metaOf(listed.value));
		return ok(undefined);
	}

	/**
	 * What changed since the last sync, written to the sink: removes for paths whose type changed (deepest first), then
	 * puts (a new directory's whole tree as one tar.pull, other files by files.read up to MAX_CHUNK_BYTES, a tar.pull of the
	 * file above it), then empty directories, then, once every put has landed, deletes (deepest first), then the meta when
	 * it differs from the last written. An entry of the manifest advances only once its write answered; what failed is
	 * sent again at the next sync, and the sync fails in words naming it.
	 */
	async sync(options: { signal?: AbortSignal } = {}): Promise<Result<SyncCounts>> {
		const { signal } = options;
		const at = this.#now();
		const listed = await this.#list(signal);
		if (!listed.ok) return listed;
		const listing = listed.value;
		const manifest = this.#manifest;
		const counts: SyncCounts = { put: 0, mkdir: 0, removed: 0, meta: false };
		const failures: { code: ComputerErrorCode; words: string }[] = [];
		const failed = (code: ComputerErrorCode, words: string) => failures.push({ code, words });

		// A directory listed with nothing under it where the manifest holds something may be one its user can't read:
		// files.list keeps such a directory but not what it holds. Then nothing is written: what is under it is unknown.
		const parents = (entries: Iterable<[string, { type: string }]>) => new Set([...entries].filter(([, entry]) => entry.type !== "symlink").map(([path]) => parentOf(path)));
		const [holdsNow, heldBefore] = [parents(listing), parents(manifest)];
		const unreadable = await this.#unreadable(
			[...listing].filter(([path, entry]) => entry.type === "dir" && heldBefore.has(path) && !holdsNow.has(path)).map(([path]) => path),
			signal,
		);
		if (unreadable.length > 0) {
			const shown = unreadable.slice(0, 3).map((dir) => `${dir}/`);
			return fail("refused", `the run's folder holds ${shown.join(", ")}${unreadable.length > shown.length ? ", ..." : ""}, which the computer's user can't read, so nothing is synced until it can (chmod u+rx)`);
		}

		// What changed: a type that differs is removed first, with what the manifest holds under it.
		const retyped = [...listing].filter(([path, entry]) => manifest.has(path) && manifest.get(path)?.type !== entry.type).map(([path]) => path);
		const early = new Set([...manifest.keys()].filter((path) => retyped.some((changed) => path === changed || under(path, changed))));
		const removed = [...manifest.keys()].filter((path) => !listing.has(path) && !early.has(path)).sort(deepestFirst);
		for (const path of [...early].sort(deepestFirst)) {
			const known = manifest.get(path) as Known;
			if (known.type === "symlink") manifest.delete(path);
			else await this.#remove(path, known.type, counts, failed);
		}
		// A path whose old entry is still there keeps it in the manifest, and nothing is written there or under it, so the
		// next sync removes it again first.
		const stuck = retyped.filter((path) => manifest.has(path));
		const open = (path: string) => !stuck.some((dir) => path === dir || under(path, dir));

		const newDirs = new Set([...listing].filter(([path, entry]) => entry.type === "dir" && manifest.get(path)?.type !== "dir" && open(path)).map(([path]) => path));
		const due = (path: string) => manifest.get(path)?.settled === false && at - (this.#racy.get(path) ?? Number.POSITIVE_INFINITY) >= RACY_MS;
		const files = [...listing].filter(([path, entry]) => {
			if (entry.type !== "file" || !open(path)) return false;
			const known = manifest.get(path);
			return known?.type !== "file" || known.size !== entry.size || known.mtimeMs !== entry.mtimeMs || due(path);
		});
		// A new directory whose parent is no new one is pulled whole, as one tar, where it holds a file.
		const trees = [...newDirs].filter((dir) => !newDirs.has(parentOf(dir)) && files.some(([path]) => under(path, dir)));
		const inTree = (path: string) => trees.some((dir) => under(path, dir));

		// The bytes this sync may still read: each body takes its size before it is held, so a file grown since the listing
		// never makes a sync hold more than SYNC_MAX_BYTES.
		let left = SYNC_MAX_BYTES;
		const take = (bytes: number): boolean => {
			if (bytes > left) return false;
			left -= bytes;
			return true;
		};
		// The puts, IN_FLIGHT pulls at once and IN_FLIGHT puts at once; each advances its entry once it answered.
		const pulls = new Slots(IN_FLIGHT);
		const puts = new Slots(IN_FLIGHT);
		// Settled: read again at least RACY_MS after the listing that found it racy, as it was then. Bytes that are the ones
		// last put there are not put again.
		const landed = (path: string, entry: FileEntry, sha256: string) => {
			const known = manifest.get(path);
			const same = known?.type === "file" && known.size === entry.size && known.mtimeMs === entry.mtimeMs;
			manifest.set(path, { ...knownOf(entry, same && due(path)), sha256 });
			this.#racy.delete(path);
		};
		const put = async (path: string, body: Uint8Array, entry: FileEntry) => {
			const sha256 = createHash("sha256").update(body).digest("hex");
			if (manifest.get(path)?.sha256 === sha256) return landed(path, entry, sha256);
			const wrote = await this.#sink.put(path, body).catch((error: unknown) => fail("refused", error instanceof Error ? error.message : String(error)));
			if (!wrote.ok) return void failed(wrote.error.code, `${path}: ${wrote.error.message}`);
			counts.put++;
			landed(path, entry, sha256);
		};
		const tasks: Promise<void>[] = [];
		for (const dir of trees) {
			const wanted = new Map(files.filter(([path]) => under(path, dir)));
			tasks.push(pulls.run(() => this.#pullTree(dir, wanted, puts, put, failed, take, signal)));
		}
		for (const [path, entry] of files) {
			if (inTree(path)) continue;
			tasks.push(pulls.run(() => this.#pullFile(path, entry, put, failed, take, signal)));
		}
		await Promise.all(tasks);

		// Directories and links carry no bytes. An empty directory is recorded (new, or emptied since: a file or directory
		// under it in the manifest and none in the listing). A new one advances once something records it: its own mkdir,
		// or a file or directory under it that advanced (deepest first, so a directory's are known before it). A file of a
		// new tree that did not land is read on its own at the next sync, and its directory is new again until then.
		const ancestors = (path: string) => {
			const all: string[] = [];
			for (let dir = parentOf(path); dir !== ""; dir = parentOf(dir)) all.push(dir);
			return all;
		};
		const recorded = new Set([...manifest].filter(([, known]) => known.type !== "symlink").flatMap(([path]) => ancestors(path)));
		for (const [path, entry] of listing) if (entry.type === "symlink" && open(path)) manifest.set(path, knownOf(entry, true));
		const dirs = [...listing].filter(([path, entry]) => entry.type === "dir" && open(path)).sort(([a], [b]) => deepestFirst(a, b));
		for (const [path, entry] of dirs) {
			const isNew = newDirs.has(path);
			let made = false;
			if (!holdsNow.has(path) && (isNew || heldBefore.has(path))) {
				const wrote = await this.#sink.mkdir(path).catch((error: unknown) => fail("refused", error instanceof Error ? error.message : String(error)));
				if (!wrote.ok) {
					failed(wrote.error.code, `${path}/: ${wrote.error.message}`);
					continue;
				}
				counts.mkdir++;
				made = true;
			}
			if (isNew && (made || recorded.has(path))) {
				manifest.set(path, knownOf(entry, true));
				for (const dir of [path, ...ancestors(path)]) recorded.add(dir);
			}
		}

		// Deletes, once every put landed: a moved file is never missing from both places.
		if (failures.length === 0) {
			for (const path of removed) {
				const known = manifest.get(path) as Known;
				if (known.type === "symlink") manifest.delete(path);
				else await this.#remove(path, known.type, counts, failed);
			}
		}

		// The modes and links last, once everything else landed, where they differ from the last written.
		const meta = metaOf(listing);
		const json = JSON.stringify(meta);
		if (failures.length === 0 && json !== this.#meta) {
			const wrote = await this.#sink.meta(meta).catch((error: unknown) => fail("refused", error instanceof Error ? error.message : String(error)));
			if (wrote.ok) {
				this.#meta = json;
				counts.meta = true;
			} else failed(wrote.error.code, `the folder's modes and links: ${wrote.error.message}`);
		}

		// The racy rule: a file within RACY_MS of the newest listed, not yet read that long after, is pulled again later.
		const newest = Math.max(0, ...[...listing.values()].filter((entry) => entry.type === "file").map((entry) => entry.mtimeMs));
		for (const [path, entry] of listing) {
			const known = manifest.get(path);
			if (entry.type === "file" && entry.mtimeMs >= newest - RACY_MS && known?.settled === false && !this.#racy.has(path)) this.#racy.set(path, at);
		}
		for (const path of this.#racy.keys()) if (!listing.has(path)) this.#racy.delete(path);

		if (failures.length === 0) return ok(counts);
		const [first] = failures as [{ code: ComputerErrorCode; words: string }];
		const shown = failures.slice(0, 3).map(({ words }) => words);
		return fail(first.code, `${failures.length} of the folder's changes did not land, and are sent again at the next sync: ${shown.join("; ")}${failures.length > shown.length ? "; ..." : ""}`);
	}

	async #remove(path: string, type: "file" | "dir", counts: SyncCounts, failed: (code: ComputerErrorCode, words: string) => void): Promise<void> {
		const gone = await this.#sink.remove(path, type).catch((error: unknown) => fail("refused", error instanceof Error ? error.message : String(error)));
		if (!gone.ok) {
			failed(gone.error.code, `${path}${type === "dir" ? "/" : ""}: ${gone.error.message}`);
			return;
		}
		counts.removed++;
		this.#manifest.delete(path);
	}

	/** Of `dirs`, the ones a files.list of their own refuses: unreadable, so what the listing left out of them is unknown. */
	async #unreadable(dirs: readonly string[], signal?: AbortSignal): Promise<string[]> {
		const slots = new Slots(IN_FLIGHT);
		const listed = await Promise.all(
			dirs.map((dir) =>
				slots.run(() =>
					this.#client.call("files.list", { path: `${this.#root}/${dir}`, depth: 1, offset: 0 }, signal ? { signal } : {}).then(
						(page) => page.ok,
						() => false,
					),
				),
			),
		);
		return dirs.filter((_, index) => !listed[index]);
	}

	/**
	 * One changed file: one files.read where it was listed at MAX_CHUNK_BYTES or less and reads whole in it, else a
	 * tar.pull of it, whose header gives its size before its bytes come. Each body takes its bytes (`take`) before it is
	 * kept; one that would pass what is left of the sync's bytes fails, kind limit.
	 */
	async #pullFile(
		path: string,
		entry: FileEntry,
		put: (path: string, body: Uint8Array, entry: FileEntry) => Promise<void>,
		failed: (code: ComputerErrorCode, words: string) => void,
		take: (bytes: number) => boolean,
		signal?: AbortSignal,
	): Promise<void> {
		const at = `${this.#root}/${path}`;
		const over = `${path}: it grew since the listing past what is left of the ${SYNC_MAX_BYTES} bytes a sync reads`;
		if (entry.size <= MAX_CHUNK_BYTES) {
			const read = await this.#client.call("files.read", { path: at, offset: 0, length: MAX_CHUNK_BYTES }, signal ? { signal } : {});
			if (!read.ok) return void failed(read.error.code, `${path}: ${read.error.message}`);
			const body = Buffer.from(read.value.data, "base64");
			// One that grew past a chunk since the listing is read as a tar, below.
			if (read.value.eof || body.length === 0) return take(body.length) ? put(path, body, entry) : void failed("limit", over);
		}
		const pulled = pullTarStream(this.#client, at, signal ? { signal } : {});
		let body: Uint8Array | undefined;
		let refused = false;
		const taking = (bytes: number) => take(bytes) || ((refused = true), false);
		try {
			for await (const one of untarStream(pulled.chunks, { take: taking })) if (one.type === "file" && body === undefined) body = one.body ?? new Uint8Array();
		} catch (error) {
			const done = await pulled.done;
			if (refused) return void failed("limit", over);
			return void failed(done.ok ? "refused" : done.error.code, `${path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (body === undefined) return void failed("refused", `${path}: its tar held no file`);
		return put(path, body, entry);
	}

	/**
	 * A new directory's tree as one tar.pull: each file of it the listing has (`wanted`) put as it comes. Each entry takes
	 * its bytes (`take`) at its header, before they are held; one past what is left of the sync's bytes fails it, kind limit.
	 */
	async #pullTree(
		dir: string,
		wanted: ReadonlyMap<string, FileEntry>,
		puts: Slots,
		put: (path: string, body: Uint8Array, entry: FileEntry) => Promise<void>,
		failed: (code: ComputerErrorCode, words: string) => void,
		take: (bytes: number) => boolean,
		signal?: AbortSignal,
	): Promise<void> {
		const pulled = pullTarStream(this.#client, `${this.#root}/${dir}`, signal ? { signal } : {});
		const writing: Promise<void>[] = [];
		let refused = false;
		const taking = (bytes: number) => take(bytes) || ((refused = true), false);
		try {
			for await (const one of untarStream(pulled.chunks, { take: taking })) {
				const name = one.name.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
				if (one.type !== "file" || name === "") continue;
				const path = `${dir}/${name}`;
				const entry = wanted.get(path);
				// Only a file the listing has, of a confined path: one made since is the next sync's.
				if (entry === undefined || folderPathProblem(path) !== undefined) continue;
				const release = await puts.acquire();
				writing.push(put(path, one.body ?? new Uint8Array(), entry).finally(release));
			}
		} catch (error) {
			await Promise.all(writing);
			const done = await pulled.done;
			if (refused) return void failed("limit", `${dir}/: its files grew since the listing past what is left of the ${SYNC_MAX_BYTES} bytes a sync reads`);
			return void failed(done.ok ? "refused" : done.error.code, `${dir}/: ${error instanceof Error ? error.message : String(error)}`);
		}
		// A file listed but not in the tar was removed or replaced since: the next sync sees what it is now.
		await Promise.all(writing);
	}

	/**
	 * The folder's entries by their path relative to it: files.list from the root, MAX_LIST_DEPTH deep, its pages
	 * pipelined (the next asked for at the last page's count, and asked again where the daemon cut a page short), and
	 * listed again from each directory at the depth limit. A path the relative-path rule refuses fails the sync in words;
	 * an entry neither file, directory nor link (a socket, a fifo) is not the folder's. Over a cap, it fails, kind limit.
	 */
	async #list(signal?: AbortSignal): Promise<Result<Map<string, FileEntry>>> {
		const listing = new Map<string, FileEntry>();
		let bytes = 0;
		const queue = [this.#root];
		for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
			const base = dir === this.#root ? 0 : depthOf(dir.slice(this.#root.length + 1));
			const pages = await this.#pages(dir, SYNC_MAX_ENTRIES - listing.size, signal);
			if (!pages.ok) return pages;
			for (const entry of pages.value) {
				if (!entry.path.startsWith(`${this.#root}/`)) return fail("refused", `files.list of ${dir} gave ${JSON.stringify(entry.path)}, which is not in ${this.#root}`);
				const path = entry.path.slice(this.#root.length + 1);
				const problem = folderPathProblem(path);
				if (problem !== undefined) return fail("refused", `the run's folder holds ${JSON.stringify(path)}, which ${problem}, so no sink can keep it: rename or remove it`);
				if (entry.type === "other") continue;
				listing.set(path, entry);
				if (entry.type === "file") bytes += entry.size;
				if (entry.type === "dir" && depthOf(path) - base === MAX_LIST_DEPTH) queue.push(entry.path);
			}
		}
		if (bytes > SYNC_MAX_BYTES) return fail("limit", `the run's folder holds ${bytes} bytes, more than ${SYNC_MAX_BYTES}, the most a synced folder holds`);
		return ok(listing);
	}

	/**
	 * Every entry files.list gives below dir, MAX_LIST_DEPTH deep. Past a truncated page, the next is asked for while the
	 * one before is in flight, at the last page's count (the daemon may cut a page short of MAX_LIST_ENTRIES by bytes):
	 * one asked for where the count read so far is not is dropped, and asked for again there. More than `room` entries
	 * (what the folder's cap leaves) fails at once, kind limit, so no listing past the cap is held.
	 */
	async #pages(dir: string, room: number, signal?: AbortSignal): Promise<Result<FileEntry[]>> {
		const entries: FileEntry[] = [];
		const ask = (offset: number) => this.#client.call("files.list", { path: dir, depth: MAX_LIST_DEPTH, offset }, signal ? { signal } : {});
		let current = ask(0);
		let next: { offset: number; page: ReturnType<typeof ask> } | undefined;
		const drop = async () => {
			await next?.page.catch(() => undefined);
			next = undefined;
		};
		for (;;) {
			const page = await current;
			if (!page.ok) {
				await drop();
				return fail(page.error.code, `files.list of ${dir} at ${entries.length}: ${page.error.message}`);
			}
			entries.push(...page.value.entries);
			if (entries.length > room) {
				await drop();
				return fail("limit", TOO_MANY);
			}
			if (!page.value.truncated) {
				await drop();
				return ok(entries);
			}
			// Each truncated page holds an entry at least, so the room bounds how many pages there are.
			if (page.value.entries.length === 0) {
				await drop();
				return fail("refused", `files.list of ${dir} at ${entries.length} gave a truncated page with no entries`);
			}
			if (next !== undefined && next.offset === entries.length) current = next.page;
			else {
				await drop();
				current = ask(entries.length);
			}
			const guess = Math.min(page.value.entries.length, MAX_LIST_ENTRIES);
			next = { offset: entries.length + guess, page: ask(entries.length + guess) };
		}
	}
}
