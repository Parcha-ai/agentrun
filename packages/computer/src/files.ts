// Files in and out of a computer past one call's limit: whole files in chunks, and tar archives both ways.
import type { DaemonClient } from "./client.js";
import { MAX_CHUNK_BYTES, type TarPushEndResult } from "./protocol.js";
import { type ComputerError, fail, ok, type Result } from "./result.js";

export interface PulledTar {
	/**
	 * The archive's bytes, one tar.pull.read each time the loop asks, so nothing is read ahead of it. A pull that fails
	 * throws its error's message, with the error as the cause.
	 */
	chunks: AsyncIterable<Uint8Array>;
	/** How the pull ended: settled once the loop ends, is left, or the signal aborts. */
	done: Promise<Result<{ bytes: number }>>;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/** Reads a whole file, MAX_CHUNK_BYTES per call. */
export async function readFile(client: DaemonClient, path: string, options: { signal?: AbortSignal } = {}): Promise<Result<Uint8Array>> {
	const parts: Buffer[] = [];
	let offset = 0;
	for (;;) {
		const read = await client.call("files.read", { path, offset, length: MAX_CHUNK_BYTES }, options);
		if (!read.ok) return read;
		const data = Buffer.from(read.value.data, "base64");
		parts.push(data);
		offset += data.length;
		if (read.value.eof || data.length === 0) return ok(Buffer.concat(parts));
	}
}

/**
 * Writes a whole file: the first call replaces it (with parents), the rest write at their offsets. A mode is set with
 * the last chunk; until then the file also has owner write, so a read-only mode does not refuse the chunks after the
 * first.
 */
export async function writeFile(
	client: DaemonClient,
	path: string,
	bytes: Uint8Array,
	options: { mode?: number; parents?: boolean; signal?: AbortSignal } = {},
): Promise<Result<{ size: number }>> {
	const { mode, parents, signal } = options;
	let offset = 0;
	let size = 0;
	do {
		const data = base64(bytes.subarray(offset, offset + MAX_CHUNK_BYTES));
		const last = offset + MAX_CHUNK_BYTES >= bytes.length;
		const firstMode = mode === undefined || last ? mode : mode | 0o200;
		const params = offset === 0 ? { path, data, mode: firstMode, parents } : { path, data, offset, mode: last ? mode : undefined };
		const wrote = await client.call("files.write", params, { signal });
		if (!wrote.ok) return wrote;
		size = wrote.value.size;
		offset += MAX_CHUNK_BYTES;
	} while (offset < bytes.length);
	return ok({ size });
}

/**
 * Extracts a tar archive into dir in the computer (made when missing), sent in chunks of MAX_CHUNK_BYTES, each after
 * the last one's reply. An entry outside dir is refused (`denied`) and ends the push; what was written before it stays.
 * A push that begins is always ended, aborted or not, so it never holds one of the connection's 8 pushes.
 */
export async function pushTar(
	client: DaemonClient,
	dir: string,
	tar: Uint8Array | AsyncIterable<Uint8Array>,
	options: { signal?: AbortSignal } = {},
): Promise<Result<TarPushEndResult>> {
	const { signal } = options;
	if (signal?.aborted) return fail("aborted", `the push into ${dir} was aborted`);
	const begun = await client.call("tar.push.begin", { path: dir });
	if (!begun.ok) return begun;
	const { id } = begun.value;
	if (signal?.aborted) return abandon(client, id, fail("aborted", `the push into ${dir} was aborted`));
	const pending = Buffer.alloc(MAX_CHUNK_BYTES);
	let filled = 0;
	const send = async (): Promise<Result<unknown>> => {
		const wrote = await client.call("tar.push.write", { id, data: base64(pending.subarray(0, filled)) }, options);
		filled = 0;
		// A refused write ended the push in the daemon; an aborted one did not.
		return !wrote.ok && wrote.error.code === "aborted" ? abandon(client, id, wrote) : wrote;
	};
	try {
		for await (const piece of tar instanceof Uint8Array ? [tar] : tar) {
			for (let at = 0; at < piece.length; ) {
				const take = Math.min(MAX_CHUNK_BYTES - filled, piece.length - at);
				pending.set(piece.subarray(at, at + take), filled);
				filled += take;
				at += take;
				if (filled === MAX_CHUNK_BYTES) {
					const wrote = await send();
					if (!wrote.ok) return wrote;
				}
			}
		}
	} catch (error) {
		return abandon(client, id, fail("invalid", `the tar source failed: ${error instanceof Error ? error.message : String(error)}`));
	}
	if (filled > 0) {
		const wrote = await send();
		if (!wrote.ok) return wrote;
	}
	if (signal?.aborted) return abandon(client, id, fail("aborted", `the push into ${dir} was aborted`));
	return client.call("tar.push.end", { id }, options);
}

/** Ends a push this side gave up on, then returns why. */
async function abandon<T>(client: DaemonClient, id: string, why: Result<T>): Promise<Result<T>> {
	await client.call("tar.push.end", { id });
	return why;
}

/** Pulls the tar of a file or directory in the computer, as chunks while they come. */
export function pullTarStream(client: DaemonClient, path: string, options: { signal?: AbortSignal } = {}): PulledTar {
	const stop = new AbortController();
	const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
	const queue: Buffer[] = [];
	let received = 0;
	let finished = false;
	let wake: (() => void) | undefined;
	let room: (() => void) | undefined;
	const nudge = () => {
		wake?.();
		wake = undefined;
	};
	const free = () => {
		room?.();
		room = undefined;
	};
	const done = client
		.call(
			"tar.pull",
			{ path },
			{
				signal,
				onNotification: ({ method, params }) => {
					if (method !== TAR_DATA_METHOD) return;
					const data = Buffer.from((params as TarDataParams).data, "base64");
					received += data.length;
					queue.push(data);
					nudge();
					if (queue.length >= HIGH_WATER) return new Promise<void>((resolve) => (room = resolve));
				},
			},
		)
		.then((result): Result<TarPullResult> => {
			finished = true;
			nudge();
			if (result.ok && result.value.bytes !== received) {
				return fail("invalid", `the pull of ${path} sent ${received} bytes, and its reply says ${result.value.bytes}`);
			}
			return result;
		});
	async function* chunks(): AsyncGenerator<Uint8Array> {
		try {
			for (;;) {
				const next = queue.shift();
				if (next !== undefined) {
					if (queue.length < HIGH_WATER) free();
					yield next;
				} else if (finished) {
					return;
				} else {
					await new Promise<void>((resolve) => (wake = resolve));
				}
			}
		} finally {
			if (!finished) stop.abort();
			free();
		}
	}
	return { chunks: chunks(), done };
}

/** Pulls the tar of a file or directory in the computer, whole. */
export async function pullTar(client: DaemonClient, path: string, options: { signal?: AbortSignal } = {}): Promise<Result<Uint8Array>> {
	const { chunks, done } = pullTarStream(client, path, options);
	const parts: Uint8Array[] = [];
	for await (const chunk of chunks) parts.push(chunk);
	const ended = await done;
	return ended.ok ? ok(Buffer.concat(parts)) : ended;
}
