import type { Context } from "@earendil-works/chord";
import type { Result } from "@earendil-works/pi-durable/env";
import type { Seal } from "./store.ts";

/** Which home holds a session: an environment of the config, the box it runs in, and the host that put it there. */
export type Holder = {
	readonly environment: string;
	readonly provider: string;
	/** The box's id, or `null` for a home on the host's own machine. */
	readonly box: string | null;
	readonly host: string;
};

/**
 * The move that took a session: its id, what the agent is told, and the workspace roots before and after. A host
 * that starts again finishes the move from the lease alone.
 */
export type LeaseMove = {
	readonly id: string;
	readonly notice: string;
	readonly roots?: { readonly from: string; readonly to: string };
};

/**
 * The lease of one session. `epoch` moves only when a host takes the session; no timer moves it. `seal` names the
 * store the holder must open, `move` the move that took it, so a host that retries its own take recognises it.
 */
export type LeaseRecord = {
	readonly v: 1;
	readonly session: string;
	readonly epoch: number;
	readonly holder: Holder;
	readonly move?: LeaseMove;
	readonly seal?: Seal;
	/** When it was taken, for people. */
	readonly at: string;
};

/**
 * Why a lease call failed. `lost`: another take came first, the epoch is not the one expected. `store`: the storage
 * did not answer or refused.
 */
export type OwnershipErrorCode = "lost" | "store";

/** A lease call that did not succeed. Returned, never thrown. */
export class OwnershipError extends Error {
	public code: OwnershipErrorCode;

	constructor(code: OwnershipErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "OwnershipError";
		this.code = code;
	}
}

/** What a take writes beside the holder. */
export type TakeOptions = { readonly move?: LeaseMove; readonly seal?: Seal };

/**
 * One writer per session, by a numbered lease. A host takes a session when its epoch is still `expected`; the new
 * epoch is `expected + 1`. Of many takers of one epoch exactly one wins, and the take is a conditional write in
 * storage the host names.
 */
export interface Ownership {
	take(
		session: string,
		holder: Holder,
		expected: number,
		options: TakeOptions | undefined,
		context: Context,
	): Promise<Result<LeaseRecord, OwnershipError>>;
	current(session: string, context: Context): Promise<Result<LeaseRecord | undefined, OwnershipError>>;
}
