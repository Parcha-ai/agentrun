import type { Context } from "@earendil-works/chord";
import type { Harness, Session, Storage, StorageWrite } from "@earendil-works/pi-durable";
import type { Frame } from "./link.ts";
import { type LinesSync, type Outbox, openOutbox } from "./outbox.ts";
import type { WrappedStore } from "./run.ts";
import { admitsTool, shippingStorage } from "./shipping.ts";
import { storeHead } from "./store.ts";

/** A line of a recording as this package carries it: whatever the recorder made, with the commit it is about. */
export type RecordLine = { readonly commit: number };

/**
 * The recorder a runner runs in its process: the same functions as `@parcha/agentrun-pi/durable`'s, which the app's
 * bundle passes in (this package depends on no other). `snapshotLines` is the state at the store's latest commit, taken
 * after the store opens and before anything commits; `recordCommits` calls `write` with each commit's lines.
 */
export type Recording = {
	snapshotLines?(
		storage: Storage,
		options: { readonly at: number; readonly context: Context },
	): Promise<readonly RecordLine[]>;
	recordCommits(
		session: Pick<Session, "subscribeCommits">,
		options: { readonly from?: readonly RecordLine[]; readonly write: (lines: readonly RecordLine[]) => void },
	): () => Promise<void>;
};

/** The runner's end of the record stream. */
export interface Shipper {
	/** For the home's `wrapStore`: the store's commits go to the outbox and the host, and the recorder starts. */
	wrapStore(store: string): (storage: Storage, context: Context) => Promise<WrappedStore>;
	/** A frame from the host. False when it is not a record frame. */
	receive(frame: Frame): boolean;
	/** The link is up: frames go through `send` once the host said where it is (`records-from`). */
	up(send: (frame: Frame) => boolean): void;
	down(): void;
	/** Settles true when the host holds every commit and every line, false when `withinMs` passed first. */
	drained(withinMs: number): Promise<boolean>;
}

export type ShipperOptions = {
	readonly recording?: Recording;
	readonly linesSync?: LinesSync;
	/** Batches that admit an effect: their commit waits for the host's acknowledgement. Default: pi's tool intent. */
	readonly admits?: (writes: readonly StorageWrite[]) => boolean;
	/** How long an admitting commit waits for the host. Default 30 s. */
	readonly acknowledgeWithinMs?: number;
};

/**
 * Ship a runner's commits to its host. Each commit's writes go out after the store has them, and its recorder lines
 * after that, on the same link: `record { commit, writes }`, then `lines { commit, lines }`. The host says where it is
 * when a link comes up (`records-from { after, linesAfter }`, both exclusive), the runner sends what it has not
 * acknowledged from there, in order, and only then the commits that follow. A process's snapshot lines go once, after
 * the commits it opened at.
 */
export function createShipper(options: ShipperOptions = {}): Shipper {
	let outbox: Outbox | undefined;
	let send: ((frame: Frame) => boolean) | undefined;
	// Set when the host said where it is: frames go out on this link from then on.
	let streaming = false;
	let snapshot: { readonly commit: number; readonly lines: readonly RecordLine[] } | undefined;
	// The last commit the host holds, and the commits that wait for it to hold theirs.
	let acked = 0;
	const waiting = new Set<{ readonly commit: number; readonly settle: (held: boolean) => void }>();
	const hold = (commit: number) => {
		acked = Math.max(acked, commit);
		for (const waiter of waiting) if (waiter.commit <= acked) waiter.settle(true);
	};
	const acknowledged = (commit: number) =>
		new Promise<boolean>((resolve) => {
			if (commit <= acked) {
				resolve(true);
				return;
			}
			const waiter = {
				commit,
				settle: (held: boolean) => {
					waiting.delete(waiter);
					clearTimeout(deadline);
					resolve(held);
				},
			};
			const deadline = setTimeout(() => waiter.settle(false), options.acknowledgeWithinMs ?? 30_000);
			waiting.add(waiter);
		});

	const sendRecord = (commit: number, writes: readonly StorageWrite[]) => {
		if (streaming) send?.({ t: "record", commit, writes });
	};
	const sendLines = (commit: number, lines: readonly unknown[], isSnapshot: boolean) => {
		if (streaming) send?.({ t: "lines", commit, lines, ...(isSnapshot ? { snapshot: true } : {}) });
	};

	return {
		wrapStore(store) {
			return async (storage, context) => {
				const head = await storeHead(store);
				if (!head.ok) throw head.error;
				const opened = openOutbox(`${store}.outbox.jsonl`, {
					head: head.value,
					...(options.linesSync === undefined ? {} : { linesSync: options.linesSync }),
				});
				outbox = opened;
				const recording = options.recording;
				// Nothing has committed through pi yet, and this process holds the store alone: the state is exact.
				const lines = await recording?.snapshotLines?.(storage, { at: head.value - 1, context });
				if (lines !== undefined && lines.length > 0) {
					snapshot = { commit: head.value - 1, lines };
					sendLines(snapshot.commit, lines, true);
					if (streaming) snapshot = undefined;
				}
				let stop: (() => Promise<void>) | undefined;
				return {
					storage: shippingStorage(storage, {
						outbox: opened,
						head: head.value,
						ship: (shipped) => sendRecord(shipped.commit, shipped.writes),
						admits: options.admits ?? admitsTool,
						acknowledged,
					}),
					opened(harness: Harness) {
						stop = recording?.recordCommits(harness, {
							...(lines === undefined ? {} : { from: lines }),
							write(recorded) {
								const commit = recorded[0]?.commit;
								if (commit === undefined) return;
								// On the disk before this returns: a death loses at most the commit in flight.
								opened.lines(commit, recorded);
								sendLines(commit, recorded, false);
							},
						});
					},
					async closed() {
						try {
							await stop?.();
						} finally {
							opened.close();
							if (outbox === opened) outbox = undefined;
						}
					},
				};
			};
		},
		receive(frame) {
			if (frame.t === "record-ack") {
				if (typeof frame.commit === "number") {
					outbox?.ack(frame.commit);
					hold(frame.commit);
				}
			} else if (frame.t === "lines-ack") {
				if (typeof frame.commit === "number") outbox?.ackLines(frame.commit);
			} else if (frame.t === "records-from") {
				const after = typeof frame.after === "number" ? frame.after : -1;
				const linesAfter = typeof frame.linesAfter === "number" ? frame.linesAfter : -1;
				streaming = true;
				hold(after);
				for (const entry of outbox?.pending(after, linesAfter) ?? []) {
					if (snapshot !== undefined && entry.commit > snapshot.commit) {
						sendLines(snapshot.commit, snapshot.lines, true);
						snapshot = undefined;
					}
					if (entry.writes !== undefined) sendRecord(entry.commit, entry.writes);
					if (entry.lines !== undefined) sendLines(entry.commit, entry.lines, false);
				}
				if (snapshot !== undefined) sendLines(snapshot.commit, snapshot.lines, true);
				snapshot = undefined;
			} else {
				return false;
			}
			return true;
		},
		up(next) {
			send = next;
			streaming = false;
		},
		down() {
			send = undefined;
			streaming = false;
		},
		async drained(withinMs) {
			const deadline = performance.now() + withinMs;
			for (;;) {
				if (snapshot === undefined && (outbox?.pending().length ?? 0) === 0) return true;
				if (performance.now() >= deadline) return false;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		},
	};
}

/**
 * Where a host keeps a session's record stream. `held` says what it holds whole: the last commit whose writes are in
 * the log, and the last commit whose lines were written. A new session's log holds nothing, `{ after: 0, linesAfter:
 * 0 }`: a store's first commit is 1. The host calls `append` for each commit in
 * order, and `lines` for a commit only once its writes are in the log; a snapshot's lines come at the commit their
 * process opened at, whatever was written before.
 */
export interface RecordSink {
	held(): { readonly after: number; readonly linesAfter: number };
	/** A commit's writes, in the log and synced when it settles. */
	append(commit: number, writes: readonly StorageWrite[]): Promise<void>;
	lines(commit: number, lines: readonly unknown[], snapshot: boolean): Promise<void>;
}

/**
 * The host's end of the record stream: a record frame is appended (and settles) before the next frame of the link is
 * acted on, which `connectHome` guarantees by handling a link's frames one after another. Returns whether the frame was
 * a record frame.
 */
export async function receiveRecords(
	sink: RecordSink,
	frame: Frame,
	reply: (frame: Frame) => boolean,
): Promise<boolean> {
	if (frame.t !== "record" && frame.t !== "lines") return false;
	const commit = typeof frame.commit === "number" && Number.isSafeInteger(frame.commit) ? frame.commit : undefined;
	if (commit === undefined) return true;
	const { after, linesAfter } = sink.held();
	if (frame.t === "record") {
		// Out of order: the runner sends again from where the host is at its next connect.
		if (commit > after + 1) return true;
		if (commit === after + 1) await sink.append(commit, (frame.writes ?? []) as readonly StorageWrite[]);
		reply({ t: "record-ack", commit });
		return true;
	}
	const lines = Array.isArray(frame.lines) ? frame.lines : [];
	// A commit's lines never before its writes are in the log.
	if (commit > after) return true;
	if (frame.snapshot === true) {
		await sink.lines(commit, lines, true);
		return true;
	}
	if (commit > linesAfter) await sink.lines(commit, lines, false);
	reply({ t: "lines-ack", commit });
	return true;
}
