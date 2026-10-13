import type { Context } from "@earendil-works/chord";
import { type ConversationId, defineDoc, type Harness, type HarnessOptions } from "@earendil-works/pi-durable";
import type { Result } from "@earendil-works/pi-durable/env";
import type { BoxProvider } from "./box/box.ts";

/**
 * Why a transport call failed. Codes are the contract; messages are diagnostic.
 *
 * `unknown_environment`: no declared environment or role has that name. `unknown_provider`: an environment names a
 * provider the host did not pass. `unsupported`: the config asks for something this release does not do. `box`: a
 * provider could not give, find or end a box. `store`: the session's documents could not be read or written.
 */
export type TransportErrorCode = "unknown_environment" | "unknown_provider" | "unsupported" | "box" | "store";

/** A failure of the transport itself. Returned from calls on a running transport, thrown by `transport()` at start. */
export class TransportError extends Error {
	public code: TransportErrorCode;

	constructor(code: TransportErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "TransportError";
		this.code = code;
	}
}

/**
 * Which environment a conversation's tools run in. Absent, or with no `environment`, the conversation uses the
 * config's `hands.default`. A fork starts without one: it does not inherit its parent's assignment.
 */
export const HandsDoc = defineDoc<{ environment?: string }>({
	kind: "transport.hands",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
});

/**
 * Every box of the session, by what it serves: an environment id for a box the whole session shares, or
 * `<environment id>@<conversation id>` for a conversation's own. A transport opened later on the same store finds
 * its boxes here.
 */
export const SessionBoxesDoc = defineDoc<{ boxes: Record<string, string> }>({
	kind: "transport.boxes",
	version: 1,
	scope: "session",
	initial: () => ({ boxes: {} }),
});

/** What a transport needs from its host. */
export type TransportHost = {
	/** Box providers by the name a config's `environments.<id>.provider` uses. */
	readonly providers: Readonly<Record<string, BoxProvider>>;
	/**
	 * The Harness's `commit`, to record box ids and assignments. The Harness is opened with this transport's `env`, so
	 * pass a function that reaches the Harness once it exists.
	 */
	readonly commit: Harness["commit"];
	/**
	 * Labels for every box this transport creates, for example a session id, so the host can list what it left
	 * behind. The transport adds none of its own: `pi-transport` and the keys under it belong to providers, which
	 * mark their own boxes, and are refused here.
	 */
	readonly labels?: Readonly<Record<string, string>>;
};

/** Runs a session's tools in the boxes its config declares. Built once for each Harness. */
export interface Transport {
	/**
	 * `HarnessOptions.env`. Returns `undefined` for a conversation whose tools stay with the host: the config names no
	 * `hands`, or its environment is `local` and the host passed no `local` provider. The environment it returns is
	 * lazy: a box is created at the first file operation or command, never while a prompt is prepared.
	 */
	readonly env: NonNullable<HarnessOptions["env"]>;
	/**
	 * Point a conversation's tools at a role of the config's `hands`, or at a declared environment. It applies from the
	 * conversation's next tool call.
	 */
	assign(conversation: ConversationId, to: string, context: Context): Promise<Result<void, TransportError>>;
	/**
	 * Forget the session's boxes and leave them running, for a host that will open the session again. Commands this
	 * transport still runs are stopped. A box nobody comes back to ends at its lifetime.
	 */
	release(context: Context): Promise<void>;
	/**
	 * End every box of the session: those this transport created or found again, and those the session's documents
	 * name that it has not used yet. The error lists the boxes that could not be ended.
	 */
	destroy(context: Context): Promise<Result<void, TransportError>>;
}
