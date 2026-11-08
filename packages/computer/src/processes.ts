// Processes past one call: a stream read whole, page by page, until the process ends.
import { type ComputerClient, MAX_CHUNK_BYTES, type ProcessInfo, type ProcessStream } from "./protocol.js";
import { ok, type Result } from "./result.js";

export interface ReadAllResult {
	/** Every byte of the stream from offset on that the daemon still held. */
	data: Uint8Array;
	/** Bytes the ring had dropped before they could be read. */
	dropped: number;
	/** Where the stream ended. */
	nextOffset: number;
}

/** How long each read waits for new bytes while the process runs. */
const DEFAULT_WAIT_MS = 10_000;

/**
 * Reads a process's stream from offset (default 0) until the process has ended and every byte is read: pages of
 * MAX_CHUNK_BYTES, each from the last one's nextOffset, waiting up to waitMs for bytes while it runs. It returns only
 * when the process ends, the daemon refuses a read, or signal aborts.
 */
export async function readAll(
	client: ComputerClient,
	id: string,
	stream: ProcessStream,
	options: { offset?: number; waitMs?: number; signal?: AbortSignal } = {},
): Promise<Result<ReadAllResult>> {
	const { waitMs = DEFAULT_WAIT_MS, signal } = options;
	const parts: Buffer[] = [];
	let offset = options.offset ?? 0;
	let dropped = 0;
	for (;;) {
		const read = await client.call("process.read", { id, stream, offset, maxBytes: MAX_CHUNK_BYTES, waitMs }, { signal });
		if (!read.ok) return read;
		parts.push(Buffer.from(read.value.data, "base64"));
		dropped += read.value.dropped;
		offset = read.value.nextOffset;
		if (read.value.exited) return ok({ data: Buffer.concat(parts), dropped, nextOffset: offset });
	}
}

/** Lists every process the daemon holds, in start order, page by page. */
export async function listProcesses(client: ComputerClient, options: { signal?: AbortSignal } = {}): Promise<Result<ProcessInfo[]>> {
	const processes: ProcessInfo[] = [];
	let params: { from?: number } = {};
	for (;;) {
		const page = await client.call("process.list", params, options);
		if (!page.ok) return page;
		processes.push(...page.value.processes);
		if (!page.value.truncated) return ok(processes);
		params = { from: page.value.next };
	}
}
