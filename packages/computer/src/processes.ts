// Processes past one call: a stream read whole, page by page, until the process ends.
import type { DaemonClient } from "./client.js";
import type { ProcessStream } from "./protocol.js";
import { fail, type Result } from "./result.js";

export interface ReadAllResult {
	/** Every byte of the stream from offset on that the daemon still held. */
	data: Uint8Array;
	/** Bytes the ring had dropped before they could be read. */
	dropped: number;
	/** Where the stream ended. */
	nextOffset: number;
}

export async function readAll(
	_client: DaemonClient,
	_id: string,
	_stream: ProcessStream,
	_options: { offset?: number; waitMs?: number; signal?: AbortSignal } = {},
): Promise<Result<ReadAllResult>> {
	return fail("unsupported", "readAll is not built yet");
}
