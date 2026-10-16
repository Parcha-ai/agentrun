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
 * once pi has opened the store, after what pi commits in opening it (what it recovers from a process that died) and
 * before anything else commits; `recordCommits` calls `write` with each commit's lines from there.
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
	/** The link is up: frames go through `send` once the host said where it is (`resend-after`). */
	up(send: (frame: Frame) => boolean): void;
	down(): void;
	/** Settles true when the host holds every commit and every line, false when `withinMs` passed first. */
	drained(withinMs: number): Promise<boolean>;
	/** The sequence the store's next commit takes; `undefined` while no store is open. */
	position(): number | undefined;
}

export type ShipperOptions = {
	readonly recording?: Recording;
	readonly linesSync?: LinesSync;
	/**
	 * Batches that admit an effect of the app's own: their commit waits for the host's acknowledgement, as pi's tool
	 * intent's always does (`admitsTool`).
	 */
	readonly admits?: (writes: readonly StorageWrite[]) => boolean;
	/** How long an admitting commit waits for the host. Default 30 s. */
	readonly acknowledgeWithinMs?: number;
};

/**
 * Ship a runner's commits to its host. Each commit's writes go out after the store has them, and its recorder lines
 * after that, on the same link: `record { commit, writes }`, then `lines { commit, lines }`. The host says where it is
 * when a link comes up (`resend-after { after, linesAfter }`, both exclusive), the runner sends what it has not
 * acknowledged from there, in order, and only then the commits that follow. A process's snapshot lines go after the
 * commits it opened at, once on each link, until the host acknowledges them.
 */
export function createShipper(options: ShipperOptions = {}): Shipper {
	let outbox: Outbox | undefined;
	let next: number | undefined;
	let send: ((frame: Frame) => boolean) | undefined;
	// Set when the host said where it is: frames go out on this link from then on.
	let streaming = false;
	// Where the host said its log is, on this link: what the runner holds from there goes first.
	let hostAt: { readonly after: number; readonly linesAfter: number } | undefined;
	// Kept until the host acknowledges it; sent once on each link.
	let snapshot: { readonly commit: number; readonly lines: readonly RecordLine[] } | undefined;
	let snapshotSentOn: ((frame: Frame) => boolean) | undefined;
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
	const sendSnapshot = () => {
		if (snapshot === undefined || !streaming || send === undefined || snapshotSentOn === send) return;
		snapshotSentOn = send;
		sendLines(snapshot.commit, snapshot.lines, true);
	};
	/** What the host says its log holds lets the outbox go, whether or not the acknowledgements arrived. */
	const heldByHost = (box: Outbox | undefined) => {
		if (box === undefined || hostAt === undefined) return;
		if (hostAt.after > 0) box.ack(hostAt.after);
		if (hostAt.linesAfter > 0) box.ackLines(hostAt.linesAfter);
	};
	/**
	 * What the outbox holds from where the host is, in commit order, and the snapshot after the commits before it. Runs
	 * when the host says where it is and again when the store opens: the outbox of a process that died is read only
	 * then, after the host's word. Only commits the store has: one that is still committing goes when it lands.
	 */
	const catchUp = () => {
		if (!streaming || hostAt === undefined) return;
		for (const entry of outbox?.pending(hostAt.after, hostAt.linesAfter) ?? []) {
			if (next !== undefined && entry.commit >= next) continue;
			if (snapshot !== undefined && entry.commit > snapshot.commit) sendSnapshot();
			if (entry.writes !== undefined) sendRecord(entry.commit, entry.writes);
			if (entry.lines !== undefined) sendLines(entry.commit, entry.lines, false);
		}
		sendSnapshot();
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
				next = head.value;
				heldByHost(opened);
				const recording = options.recording;
				// What a process that died left goes first, from where the host is.
				catchUp();
				// The store's last commit: pi's own, as it opens the store, move it on before the recorder starts.
				let landed = head.value - 1;
				let stop: (() => Promise<void>) | undefined;
				return {
					storage: shippingStorage(storage, {
						outbox: opened,
						head: head.value,
						ship: (shipped) => {
							next = shipped.commit + 1;
							landed = shipped.commit;
							sendRecord(shipped.commit, shipped.writes);
						},
						admits:
							options.admits === undefined
								? admitsTool
								: (writes) => admitsTool(writes) || options.admits?.(writes) === true,
						acknowledged,
					}),
					async opened(harness: Harness) {
						// pi has opened the store and committed what it recovers, and nothing commits again before the recorder
						// starts: the state is exact at the last commit, and the recorder's lines follow from there.
						const at = landed;
						const lines = await recording?.snapshotLines?.(storage, { at, context });
						if (landed !== at) {
							throw new Error(
								`commit ${landed} landed while the recorder took its snapshot at ${at}: its lines would be lost`,
							);
						}
						if (lines !== undefined && lines.length > 0) {
							snapshot = { commit: at, lines };
							snapshotSentOn = undefined;
							// After the commits it is at, which went out as they landed or go from the outbox at the next connect.
							sendSnapshot();
						}
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
							if (outbox === opened) {
								outbox = undefined;
								next = undefined;
							}
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
				// A snapshot's acknowledgement lets the snapshot go, and nothing of the commit's own lines.
				if (frame.snapshot === true) {
					if (snapshot !== undefined && frame.commit === snapshot.commit) snapshot = undefined;
				} else if (typeof frame.commit === "number") outbox?.ackLines(frame.commit);
			} else if (frame.t === "resend-after") {
				const after = typeof frame.after === "number" ? frame.after : -1;
				const linesAfter = typeof frame.linesAfter === "number" ? frame.linesAfter : -1;
				streaming = true;
				hostAt = { after, linesAfter };
				hold(after);
				heldByHost(outbox);
				catchUp();
			} else {
				return false;
			}
			return true;
		},
		up(next) {
			send = next;
			streaming = false;
			hostAt = undefined;
		},
		down() {
			send = undefined;
			streaming = false;
			hostAt = undefined;
		},
		position() {
			return next;
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
 * process opened at, whatever was written before. A snapshot is sent until the host acknowledges it, so it can come
 * again after a link dropped: it is the same state at the same commit.
 */
export interface RecordSink {
	held(): { readonly after: number; readonly linesAfter: number };
	/** A commit's writes, in the log and synced when it settles. */
	append(commit: number, writes: readonly StorageWrite[]): Promise<void>;
	lines(commit: number, lines: readonly unknown[], snapshot: boolean): Promise<void>;
}

/** Each sink's work, one after another, whatever link it came on. */
const sinkWork = new WeakMap<RecordSink, Promise<unknown>>();

/**
 * Runs `work` on `sink` after everything begun on it before, from any link: two links to one log never append one
 * commit twice, and what `held()` says is read after every append begun before it settled.
 */
export function inSinkOrder<T>(sink: RecordSink, work: () => Promise<T>): Promise<T> {
	const before = sinkWork.get(sink) ?? Promise.resolve();
	const run = before.then(work, work);
	sinkWork.set(
		sink,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}

/**
 * The host's end of the record stream: a record frame is appended (and settles) before the next frame of the link is
 * acted on, which `connectHome` guarantees by handling a link's frames one after another, and before a frame of any
 * other link to the same sink is (`inSinkOrder`). Returns whether the frame was a record frame.
 */
export async function receiveRecords(
	sink: RecordSink,
	frame: Frame,
	reply: (frame: Frame) => boolean,
): Promise<boolean> {
	if (frame.t !== "record" && frame.t !== "lines") return false;
	const commit = typeof frame.commit === "number" && Number.isSafeInteger(frame.commit) ? frame.commit : undefined;
	if (commit === undefined) return true;
	return inSinkOrder(sink, () => keep(sink, frame, commit, reply));
}

async function keep(
	sink: RecordSink,
	frame: Frame,
	commit: number,
	reply: (frame: Frame) => boolean,
): Promise<boolean> {
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
		reply({ t: "lines-ack", commit, snapshot: true });
		return true;
	}
	if (commit > linesAfter) await sink.lines(commit, lines, false);
	reply({ t: "lines-ack", commit });
	return true;
}
