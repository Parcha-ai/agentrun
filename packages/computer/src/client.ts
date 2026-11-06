// The client end of a daemon connection, over any readable and writable byte stream.
import type { Readable, Writable } from "node:stream";
import type { DaemonMethod, DaemonMethods } from "./protocol.js";
import { fail, type Result } from "./result.js";

export interface DaemonStream {
	readable: Readable;
	writable: Writable;
}

export class DaemonClient {
	constructor(_stream: DaemonStream) {}

	async call<M extends DaemonMethod>(
		_method: M,
		_params: DaemonMethods[M]["params"],
		_options: { signal?: AbortSignal } = {},
	): Promise<Result<DaemonMethods[M]["result"]>> {
		return fail("unsupported", "DaemonClient.call is not implemented");
	}

	close(): void {}
}
