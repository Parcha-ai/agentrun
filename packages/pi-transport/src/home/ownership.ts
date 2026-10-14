import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Seal } from "./store.ts";

/**
 * Why a key store call failed. `conflict` is the conditional write that lost: the key is not as the caller last saw
 * it. `unsupported` means the storage cannot make a write conditional.
 */
export type KeyStoreErrorCode = "aborted" | "conflict" | "unsupported" | "invalid" | "unavailable";

/** An expected failure of a key store call. Returned, never thrown. */
export class KeyStoreError extends Error {
	public code: KeyStoreErrorCode;

	constructor(code: KeyStoreErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "KeyStoreError";
		this.code = code;
	}
}

/**
 * Storage the host names, with one conditional write. `put` with `{ absent: true }` succeeds only when the key has no
 * value; with `{ version }` only when the key's value still has that version. Anything else is `conflict`. Every
 * successful `put` returns the new value's version, and `get` never returns a value that was not written whole.
 */
export interface ConditionalStore {
	get(
		key: string,
		context: Context,
	): Promise<Result<{ value: Uint8Array; version: string } | undefined, KeyStoreError>>;
	put(
		key: string,
		value: Uint8Array,
		when: { readonly absent: true } | { readonly version: string },
		context: Context,
	): Promise<Result<{ version: string }, KeyStoreError>>;
}

/** Why an ownership call failed. `lost` means another host acted: the epoch is not the one the caller expected. */
export type OwnershipErrorCode = "aborted" | "lost" | "corrupt" | "unavailable" | "invalid";

/** An expected failure of an ownership call. Returned, never thrown. */
export class OwnershipError extends Error {
	public code: OwnershipErrorCode;

	constructor(code: OwnershipErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "OwnershipError";
		this.code = code;
	}
}

/** Where a session's home is. Plain strings the host chooses; nothing in them is a secret. */
export type Holder = {
	readonly environment: string;
	readonly provider: string;
	readonly box: string;
	readonly host: string;
};

/** Extra facts a take records. `move` makes a retried take of the same move succeed instead of losing to itself. */
export type TakeDetails = { readonly move?: string; readonly seal?: Seal };

/** The record of one epoch of one session. */
export type LeaseRecord = {
	readonly v: 1;
	readonly session: string;
	readonly epoch: number;
	readonly holder: Holder;
	readonly move?: string;
	readonly seal?: Seal;
	/** When the take was made, as an ISO time of the host's clock. Informational: no decision reads it. */
	readonly at: string;
};

/** One writer per session, by a numbered lease. The epoch changes only when a host takes; no timer ever does. */
export interface Ownership {
	/**
	 * Take the session when its epoch is still `expected` (0 when it has none). The new epoch is `expected + 1`. Fails
	 * with `lost` when the epoch is anything else, or another host took it first. A retry of a take whose answer was
	 * lost succeeds when the record carries the same `move`.
	 */
	take(
		session: string,
		holder: Holder,
		expected: number,
		details: TakeDetails | undefined,
		context: Context,
	): Promise<Result<LeaseRecord, OwnershipError>>;
	/** The newest record of the session, or `undefined` when nobody ever took it. */
	current(session: string, context: Context): Promise<Result<LeaseRecord | undefined, OwnershipError>>;
}

const LEASE_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const keyOf = (session: string) => `lease/${session}`;

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** A seal as `sealStore` makes it: a head and a size that are whole numbers, and a SHA-256 in lowercase hex. */
function isSeal(value: unknown): value is Seal {
	const seal = value as Partial<Seal> | null;
	return (
		typeof seal === "object" &&
		seal !== null &&
		isCount(seal.head) &&
		isCount(seal.bytes) &&
		typeof seal.sha256 === "string" &&
		/^[0-9a-f]{64}$/.test(seal.sha256)
	);
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

function parseRecord(session: string, bytes: Uint8Array): LeaseRecord | undefined {
	try {
		const record = JSON.parse(decoder.decode(bytes)) as Partial<LeaseRecord> | null;
		const holder = record?.holder as Partial<Holder> | undefined;
		if (record === null || record === undefined || record.v !== LEASE_VERSION) return undefined;
		if (record.session !== session) return undefined;
		if (!Number.isSafeInteger(record.epoch) || (record.epoch as number) < 1) return undefined;
		if (!isText(holder?.environment) || !isText(holder?.provider) || !isText(holder?.box) || !isText(holder?.host)) {
			return undefined;
		}
		if (record.move !== undefined && !isText(record.move)) return undefined;
		if (record.seal !== undefined && !isSeal(record.seal)) return undefined;
		return record as LeaseRecord;
	} catch {
		return undefined;
	}
}

function storeFailure(what: string, error: KeyStoreError): OwnershipError {
	return new OwnershipError(error.code === "aborted" ? "aborted" : "unavailable", `${what}: ${error.message}`, error);
}

/** Ownership over any storage with a conditional write: an object store, a row, a key, a directory. */
export function leaseIn(store: ConditionalStore): Ownership {
	async function read(
		session: string,
		context: Context,
	): Promise<Result<{ record: LeaseRecord; version: string } | undefined, OwnershipError>> {
		const got = await store.get(keyOf(session), context);
		if (!got.ok) return err(storeFailure(`could not read the lease of ${session}`, got.error));
		if (got.value === undefined) return ok(undefined);
		const record = parseRecord(session, got.value.value);
		if (record === undefined)
			return err(new OwnershipError("corrupt", `the lease of ${session} is not a lease record`));
		return ok({ record, version: got.value.version });
	}

	return {
		async current(session, context) {
			if (session === "") return err(new OwnershipError("invalid", "the session is empty"));
			const found = await read(session, context);
			return found.ok ? ok(found.value?.record) : found;
		},

		async take(session, holder, expected, details, context) {
			if (session === "") return err(new OwnershipError("invalid", "the session is empty"));
			if (!Number.isSafeInteger(expected) || expected < 0) {
				return err(new OwnershipError("invalid", "the expected epoch must be a whole number, 0 or more"));
			}
			if (!isText(holder.environment) || !isText(holder.provider) || !isText(holder.box) || !isText(holder.host)) {
				return err(new OwnershipError("invalid", "every field of the holder must be a non-empty string"));
			}
			if (details?.move !== undefined && !isText(details.move)) {
				return err(new OwnershipError("invalid", "the move id must be a non-empty string"));
			}
			if (details?.seal !== undefined && !isSeal(details.seal)) {
				return err(new OwnershipError("invalid", "the seal must be a head, a size and a lowercase SHA-256"));
			}
			const sameMove = (record: LeaseRecord) =>
				details?.move !== undefined && record.move === details.move && record.epoch === expected + 1;
			const seen = await read(session, context);
			if (!seen.ok) return seen;
			const epoch = seen.value?.record.epoch ?? 0;
			if (seen.value !== undefined && sameMove(seen.value.record)) return ok(seen.value.record);
			if (epoch !== expected) {
				return err(new OwnershipError("lost", `the epoch of ${session} is ${epoch}, not the expected ${expected}`));
			}
			const record: LeaseRecord = {
				v: LEASE_VERSION,
				session,
				epoch: expected + 1,
				holder: {
					environment: holder.environment,
					provider: holder.provider,
					box: holder.box,
					host: holder.host,
				},
				...(details?.move === undefined ? {} : { move: details.move }),
				...(details?.seal === undefined ? {} : { seal: details.seal }),
				at: new Date().toISOString(),
			};
			const put = await store.put(
				keyOf(session),
				encoder.encode(JSON.stringify(record)),
				seen.value === undefined ? { absent: true } : { version: seen.value.version },
				context,
			);
			if (put.ok) return ok(record);
			if (put.error.code !== "conflict") return err(storeFailure(`could not take ${session}`, put.error));
			// Another taker wrote first. It is us only when the record is the same move.
			const after = await read(session, context);
			if (!after.ok) return after;
			if (after.value !== undefined && sameMove(after.value.record)) return ok(after.value.record);
			return err(new OwnershipError("lost", `another host took ${session} at epoch ${expected + 1}`));
		},
	};
}
