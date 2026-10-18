import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import {
	type Box,
	BoxError,
	type BoxErrorCode,
	type BoxExecOptions,
	type BoxFacts,
	type BoxFile,
	type BoxProcess,
	type BoxProvider,
	type BoxRef,
	type BoxSnapshot,
	type BoxSpec,
	type BoxStatus,
} from "../box/box.ts";
import { type BoxReceipts, boxReceipts } from "../box/receipts.ts";
import type { Frame } from "./link.ts";

/** The frames a runner sends for boxes: the host answers them. */
export const BOX_REQUEST_FRAMES: ReadonlySet<string> = new Set([
	"box",
	"box-stdin",
	"box-abort",
	"box-resume",
	"box-ack",
]);

/** The operations a runner asks of a box provider or one of its boxes. */
export type BoxOp = "create" | "attach" | "list" | "status" | "exec" | "upload" | "download" | "destroy" | "snapshot";

const BOX_OPS: ReadonlySet<string> = new Set<BoxOp>([
	"create",
	"attach",
	"list",
	"status",
	"exec",
	"upload",
	"download",
	"destroy",
	"snapshot",
]);
const ERROR_CODES: ReadonlySet<string> = new Set<BoxErrorCode>([
	"aborted",
	"timeout",
	"not_found",
	"gone",
	"capacity",
	"unauthorized",
	"invalid",
	"unsupported",
	"spawn",
	"unknown",
]);
/** How long a call that ended is kept for a runner that lost the link at its very end. */
const DEFAULT_KEEP_MS = 10 * 60_000;
/** How long a runner keeps a call open while its link is down. */
const DEFAULT_RESUME_WITHIN_MS = 60_000;
/** A runner acknowledges a call's frames this often, so the host lets them go. */
const ACK_EVERY = 16;
/**
 * The most of an exec's output, in bytes, the host reads ahead of the runner's acknowledgements, and the most the runner
 * holds unread before it stops acknowledging: past it the host stops reading the program's streams, so the program
 * waits on its full pipe as it would with no proxy, and neither end holds much more than this.
 */
const STREAM_WINDOW_BYTES = 1_048_576;

const toBase64 = (bytes: Uint8Array) =>
	Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
const fromBase64 = (text: unknown) => new Uint8Array(Buffer.from(typeof text === "string" ? text : "", "base64"));
const wireError = (error: unknown) => {
	const code = error instanceof BoxError ? error.code : "unknown";
	const message = error instanceof Error ? error.message : String(error);
	return { code, message: message.slice(0, 2_000) };
};
const boxErrorOf = (value: unknown): BoxError => {
	const error = (value ?? {}) as { code?: unknown; message?: unknown };
	const code =
		typeof error.code === "string" && ERROR_CODES.has(error.code) ? (error.code as BoxErrorCode) : "unknown";
	return new BoxError(code, typeof error.message === "string" ? error.message : "the host's box call failed");
};

type ServedCall = {
	id: string;
	readonly cancel: () => void;
	readonly context: Context;
	/** The frames not yet acknowledged, from `acked + 1` on: a runner that lost the link asks for what it missed. */
	readonly frames: Frame[];
	/** The highest sequence the runner said it holds: frames up to it are let go. */
	acked: number;
	/** The output bytes of each frame in `frames` (0 for the others), and their sum: what the runner has not acknowledged. */
	readonly sizes: number[];
	unacked: number;
	/** An exec's output pumps waiting at the window, woken when an acknowledgement makes room or the call is cancelled. */
	readonly room: Set<() => void>;
	seq: number;
	done: boolean;
	send: ((frame: Frame) => boolean) | undefined;
	/** An exec: its program, once started, and the stdin writes applied, in order. */
	process?: Promise<BoxProcess | undefined>;
	stdinApplied: number;
	stdin: Promise<unknown>;
};

/** The host's end of the box proxy. */
export interface BoxServer {
	/** The providers' names, as the runner's `TransportHost.providers` names them: said in the link's hello. */
	readonly names: readonly string[];
	/**
	 * A box frame from the runner, which came on the link that `send` reaches. A call's frames go to the link it was
	 * asked or last resumed on. False when it is not a box frame.
	 */
	receive(frame: Frame, send: (frame: Frame) => boolean): boolean;
	/** The link that `send` reaches is down (every link, without `send`): its calls run on and keep their frames. */
	down(send?: (frame: Frame) => boolean): void;
	/** End every call that still runs. The boxes stay: `release` ends them. */
	close(): void;
	/** Destroy every box this server made that is not ended yet: a sweep, when the session is done with its boxes. */
	release(context: Context): Promise<void>;
	/** The boxes the server made, by the label the runner knows each by, ended ones too until `release`. */
	readonly held: ReadonlyMap<string, { readonly provider: string; readonly box: Box }>;
}

export type ServeBoxesOptions = {
	/** The host's providers, by the name the session's config names them: they hold the credentials, and keep them. */
	readonly providers: Readonly<Record<string, BoxProvider>>;
	/**
	 * The receipts ledger the boxes go on, so each has its receipt and its label in the ledger's numbering (the same as
	 * the session's home boxes when the box place passes its own). Default: a ledger of its own, with no prices.
	 */
	readonly receipts?: BoxReceipts;
	/** Why a runner may not make this box, or `undefined` when it may. Default: any box of a served provider. */
	readonly allow?: (provider: string, spec: BoxSpec) => string | undefined;
	readonly keepMs?: number;
};

/**
 * Serve the host's box providers to a runner over its link: the runner asks for a box and gets a handle it can exec on,
 * named by a label (`box-7`), never by the provider's id, and no credential leaves the host. The host holds every box
 * it made, so a runner that comes back (a dropped link, a restore after its own box was lost) finds them by label.
 */
export function serveBoxes(options: ServeBoxesOptions): BoxServer {
	const keepMs = options.keepMs ?? DEFAULT_KEEP_MS;
	const ledger = options.receipts ?? boxReceipts({ prices: [], write: () => {} });
	const providers = new Map<string, BoxProvider>();
	for (const [name, provider] of Object.entries(options.providers)) providers.set(name, ledger.wrap(provider));
	const held = new Map<string, { provider: string; box: Box }>();
	const calls = new Map<string, ServedCall>();

	const labelOf = (provider: string, box: Box): string => {
		const wrapped = providers.get(provider) as BoxProvider;
		return ledger.labelOf(wrapped.name, box.id) ?? `${provider}-${held.size + 1}`;
	};
	const emit = (call: ServedCall, frame: Frame, size = 0) => {
		call.seq += 1;
		const numbered: Frame = { ...frame, id: call.id, seq: call.seq };
		call.frames.push(numbered);
		call.sizes.push(size);
		call.unacked += size;
		call.send?.(numbered);
	};
	/** Wait while the call's unacknowledged output is at the window: until an acknowledgement makes room or it is cancelled. */
	const roomIn = async (call: ServedCall) => {
		const signal = call.context.abortSignal;
		while (call.unacked >= STREAM_WINDOW_BYTES && signal?.aborted !== true) {
			await new Promise<void>((resolve) => {
				const wake = () => {
					call.room.delete(wake);
					signal?.removeEventListener("abort", wake);
					resolve();
				};
				call.room.add(wake);
				signal?.addEventListener("abort", wake, { once: true });
			});
		}
	};
	const answer = (call: ServedCall, result: Result<unknown, unknown>) =>
		emit(
			call,
			result.ok
				? { t: "box-answer", ok: true, value: result.value }
				: { t: "box-answer", ok: false, error: wireError(result.error) },
		);
	const finish = (call: ServedCall) => {
		call.done = true;
		setTimeout(() => {
			if (calls.get(call.id) === call) calls.delete(call.id);
		}, keepMs).unref?.();
	};
	const boxIn = (label: unknown): { provider: string; box: Box } | undefined =>
		typeof label === "string" ? held.get(label) : undefined;
	const gone = (label: unknown) => err(new BoxError("not_found", `this host holds no box ${String(label)}`));

	const operate = async (call: ServedCall, frame: Frame): Promise<Result<unknown, unknown>> => {
		const op = String(frame.op);
		const args = (frame.args ?? {}) as Readonly<Record<string, unknown>>;
		if (op === "create" || op === "attach" || op === "list") {
			const name = typeof frame.provider === "string" ? frame.provider : "";
			const provider = providers.get(name);
			if (provider === undefined) return err(new BoxError("invalid", `this host serves no box provider "${name}"`));
			if (op === "create") {
				const spec = (args.spec ?? {}) as BoxSpec;
				const refused = options.allow?.(name, spec);
				if (refused !== undefined) return err(new BoxError("invalid", refused));
				const made = await provider.create(spec, call.context);
				if (!made.ok) return made;
				const label = labelOf(name, made.value);
				held.set(label, { provider: name, box: made.value });
				return ok({ box: label, facts: made.value.facts() });
			}
			if (op === "attach") {
				const known = boxIn(args.box);
				if (known === undefined || known.provider !== name) return ok(null);
				const found = await provider.attach(known.box.id, call.context);
				if (!found.ok) return found;
				if (found.value === undefined) return ok(null);
				return ok({ box: args.box, facts: found.value.facts() });
			}
			const listed = await provider.list((args.labels ?? {}) as Record<string, string>, call.context);
			if (!listed.ok) return listed;
			// Only the boxes this host made, each by its label: a runner never learns a provider's id.
			const byId = new Map(
				[...held].filter(([, one]) => one.provider === name).map(([label, one]) => [one.box.id, label]),
			);
			const refs: BoxRef[] = listed.value.flatMap((ref) => {
				const label = byId.get(ref.id);
				return label === undefined ? [] : [{ id: label, labels: ref.labels }];
			});
			return ok(refs);
		}
		const known = boxIn(frame.box);
		if (known === undefined) return gone(frame.box);
		const { box } = known;
		if (op === "status") return box.status(call.context);
		if (op === "upload") {
			const files = ((args.files ?? []) as { path?: unknown; bytes?: unknown; mode?: unknown }[]).map(
				(file): BoxFile => ({
					path: String(file.path),
					bytes: fromBase64(file.bytes),
					...(typeof file.mode === "number" ? { mode: file.mode } : {}),
				}),
			);
			const uploaded = await box.upload(files, call.context);
			return uploaded.ok ? ok(null) : uploaded;
		}
		if (op === "download") {
			const read = await box.download(((args.paths ?? []) as unknown[]).map(String), call.context);
			if (!read.ok) return read;
			return ok(
				read.value.map((file) => ({
					path: file.path,
					bytes: toBase64(file.bytes),
					...(file.mode === undefined ? {} : { mode: file.mode }),
				})),
			);
		}
		// An ended box stays known by its label: it answers as an ended box does (a destroy again succeeds).
		if (op === "destroy") {
			const destroyed = await box.destroy(call.context);
			return destroyed.ok ? ok(null) : destroyed;
		}
		if (op === "snapshot") {
			if (box.snapshot === undefined) return err(new BoxError("unsupported", "this box takes no snapshot"));
			return box.snapshot(call.context);
		}
		return err(new BoxError("invalid", `no box operation "${op}"`));
	};

	/** An exec: the program's start is the answer, then its output and its exit are the call's stream. */
	const exec = async (call: ServedCall, frame: Frame) => {
		const known = boxIn(frame.box);
		let started!: (process: BoxProcess | undefined) => void;
		call.process = new Promise((resolve) => {
			started = resolve;
		});
		if (known === undefined) {
			started(undefined);
			answer(call, gone(frame.box));
			return;
		}
		const args = (frame.args ?? {}) as { command?: unknown; options?: BoxExecOptions };
		const command = Array.isArray(args.command) ? args.command.map(String) : [];
		const options = typeof args.options?.timeoutMs === "number" ? { timeoutMs: args.options.timeoutMs } : undefined;
		const begun = await known.box.exec(command, options, call.context);
		if (!begun.ok) {
			started(undefined);
			answer(call, begun);
			return;
		}
		const process = begun.value;
		started(process);
		answer(call, ok(null));
		const pump = async (stream: "stdout" | "stderr", from: AsyncIterable<Uint8Array>) => {
			for await (const chunk of from) {
				// Past the window the runner has not acknowledged (it reads slowly, or its link is down) the pump waits, and
				// the program waits on its full pipe. A cancelled call's output is read on and dropped.
				await roomIn(call);
				if (call.context.abortSignal?.aborted === true) continue;
				emit(call, { t: "box-stream", stream, bytes: toBase64(chunk) }, chunk.byteLength);
			}
		};
		await Promise.all([pump("stdout", process.stdout), pump("stderr", process.stderr)]).catch(() => {});
		const exit = await process.wait();
		emit(call, {
			t: "box-stream",
			exit: exit.ok ? { ok: true, value: exit.value } : { ok: false, error: wireError(exit.error) },
		});
	};

	return {
		names: [...providers.keys()],
		held,
		receive(frame, reply) {
			if (!BOX_REQUEST_FRAMES.has(frame.t)) return false;
			const id = typeof frame.id === "string" ? frame.id : "";
			const call = calls.get(id);
			if (frame.t === "box") {
				// The same id again is a resend of a request that did arrive: never act twice on one id.
				if (call !== undefined || !BOX_OPS.has(String(frame.op))) {
					if (call === undefined)
						reply({
							t: "box-answer",
							id,
							seq: 1,
							ok: false,
							error: { code: "invalid", message: `no box operation "${String(frame.op)}"` },
						});
					return true;
				}
				const within = withCancel(BACKGROUND_CONTEXT);
				const made: ServedCall = {
					id,
					cancel: within.cancel,
					context: within.context,
					frames: [],
					acked: 0,
					sizes: [],
					unacked: 0,
					room: new Set(),
					seq: 0,
					done: false,
					send: reply,
					stdinApplied: 0,
					stdin: Promise.resolve(),
				};
				calls.set(id, made);
				const work =
					frame.op === "exec"
						? exec(made, frame)
						: operate(made, frame).then(
								(result) => answer(made, result),
								(cause) => answer(made, err(cause)),
							);
				void work.catch((cause) => answer(made, err(cause))).finally(() => finish(made));
			} else if (frame.t === "box-abort") {
				if (call !== undefined && !call.done) call.cancel();
			} else if (frame.t === "box-ack") {
				if (call !== undefined && typeof frame.seq === "number" && frame.seq > call.acked) {
					call.frames.splice(0, frame.seq - call.acked);
					for (const size of call.sizes.splice(0, frame.seq - call.acked)) call.unacked -= size;
					call.acked = frame.seq;
					for (const wake of [...call.room]) wake();
				}
			} else if (frame.t === "box-stdin") {
				const n = typeof frame.n === "number" ? frame.n : 0;
				if (call === undefined || call.process === undefined || n <= call.stdinApplied) return true;
				// In order and once each: a write the runner sent again after a resume is applied only the first time.
				call.stdin = call.stdin.then(async () => {
					if (n !== call.stdinApplied + 1) return;
					const process = await call.process;
					if (process !== undefined) {
						if (frame.close === true) await process.stdin.close().catch(() => {});
						else await process.stdin.write(fromBase64(frame.bytes)).catch(() => {});
					}
					call.stdinApplied = n;
					emit(call, { t: "box-stream", stdin: n });
				});
			} else if (call === undefined) {
				reply({ t: "box-unknown", id });
			} else {
				// What the runner missed first, then the live frames, all on this link.
				const after = typeof frame.after === "number" ? frame.after : 0;
				if (after < call.acked) {
					reply({ t: "box-unknown", id });
					return true;
				}
				call.id = id;
				for (const kept of call.frames) if ((kept.seq as number) > after) reply(kept);
				call.send = reply;
			}
			return true;
		},
		down(from) {
			for (const call of calls.values()) if (from === undefined || call.send === from) call.send = undefined;
		},
		close() {
			for (const call of calls.values()) {
				call.send = undefined;
				if (!call.done) call.cancel();
			}
		},
		async release(context) {
			for (const [label, { box }] of [...held]) {
				const destroyed = await box.destroy(context).catch(() => undefined);
				if (destroyed?.ok === true) held.delete(label);
			}
		},
	};
}

/** A stream of chunks a consumer reads with `for await`, fed by frames: `onRead` is told each time it takes one. */
function chunks(onRead: () => void) {
	const queue: Uint8Array[] = [];
	let unread = 0;
	let ended = false;
	let wake: (() => void) | undefined;
	return {
		push(chunk: Uint8Array) {
			queue.push(chunk);
			unread += chunk.byteLength;
			wake?.();
		},
		/** The bytes pushed and not read yet. */
		unread: () => unread,
		end() {
			ended = true;
			wake?.();
		},
		iterable: {
			async *[Symbol.asyncIterator]() {
				for (;;) {
					const next = queue.shift();
					if (next !== undefined) {
						unread -= next.byteLength;
						onRead();
						yield next;
						continue;
					}
					if (ended) return;
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
					wake = undefined;
				}
			},
		} as AsyncIterable<Uint8Array>,
	};
}

type OpenCall = {
	readonly id: string;
	readonly request: Frame;
	seq: number;
	lastAcked: number;
	/** The output bytes received since the last acknowledgement. */
	bytesSinceAck: number;
	/** An exec's output the app has not read yet, in bytes. */
	unread?: () => number;
	deadline: ReturnType<typeof setTimeout> | undefined;
	/** A single answer, or the exec's start. */
	onAnswer(frame: Frame): void;
	/** An exec's output, its stdin acknowledgements and its exit. */
	onStream?(frame: Frame): void;
	/** The call cannot go on: the link stayed down, or frames were lost. */
	lose(why: string): void;
	/** Stdin writes not yet acknowledged, sent again after a resume. */
	readonly pending: Map<number, Frame>;
};

/** The runner's end of the box proxy. */
export interface ProxyBoxes {
	/** The host's providers, by name, for `TransportHost.providers`: every call a frame to the host. */
	readonly providers: Readonly<Record<string, BoxProvider>>;
	/** A frame from the host. False when it is not a box frame. */
	receive(frame: Frame): boolean;
	/** The link is up: `send` reaches the host. Open calls ask the host for what they missed. */
	up(send: (frame: Frame) => boolean): void;
	/** The link is down. Open calls wait for it to come back, for a while. */
	down(reason: string): void;
}

/**
 * Box providers for a runner that holds no credential: each of the host's providers by name, every call one `box`
 * frame to the host, every box a handle named by the host's label. A lost link keeps open calls open for
 * `resumeWithinMs`: when it comes back the runner asks for what it missed, and a program's output comes whole and once.
 */
export function proxyBoxes(names: readonly string[], options?: { readonly resumeWithinMs?: number }): ProxyBoxes {
	const resumeWithinMs = options?.resumeWithinMs ?? DEFAULT_RESUME_WITHIN_MS;
	const open = new Map<string, OpenCall>();
	// Unique for each runner process: a runner that started again never reuses an id the host still knows.
	const process = randomUUID().slice(0, 8);
	let counter = 0;
	let send: ((frame: Frame) => boolean) | undefined;

	const wait = (call: OpenCall, why: string) => {
		call.deadline ??= setTimeout(() => call.lose(`${why}, not back in ${resumeWithinMs} ms`), resumeWithinMs);
	};
	const begin = (frame: Frame, handlers: Pick<OpenCall, "onAnswer" | "onStream" | "lose">): OpenCall => {
		counter += 1;
		const id = `${process}.b${counter}`;
		const request: Frame = { ...frame, id };
		const call: OpenCall = {
			id,
			request,
			seq: 0,
			lastAcked: 0,
			bytesSinceAck: 0,
			deadline: undefined,
			pending: new Map(),
			...handlers,
		};
		open.set(id, call);
		if (send?.(request) !== true) wait(call, "the link is down");
		return call;
	};
	const end = (call: OpenCall) => {
		open.delete(call.id);
		clearTimeout(call.deadline);
	};
	/**
	 * Tell the host what the call holds, so it lets those frames go and reads on: every ACK_EVERY frames or half a window
	 * of output (`now`: at once), and only while what the app has not read is under the window. An app that does not
	 * read its program's output stops the acknowledgements, so the host stops reading and the program waits on its full
	 * pipe. An acknowledgement counts only once the link took it: one that cannot leave is made when the link is back.
	 */
	const acknowledge = (call: OpenCall, now = false) => {
		if (send === undefined || !open.has(call.id) || call.seq <= call.lastAcked) return;
		if ((call.unread?.() ?? 0) >= STREAM_WINDOW_BYTES) return;
		if (!now && call.seq - call.lastAcked < ACK_EVERY && call.bytesSinceAck < STREAM_WINDOW_BYTES / 2) return;
		if (send({ t: "box-ack", id: call.id, seq: call.seq }) !== true) return;
		call.lastAcked = call.seq;
		call.bytesSinceAck = 0;
	};

	/** One call with one answer. */
	const ask = <T>(frame: Frame, context: Context, decode: (value: unknown) => T): Promise<Result<T, BoxError>> =>
		new Promise((resolve) => {
			const signal = context.abortSignal;
			const settle = (result: Result<T, BoxError>) => {
				signal?.removeEventListener("abort", onAbort);
				end(call);
				resolve(result);
			};
			const onAbort = () => {
				send?.({ t: "box-abort", id: call.id });
				settle(err(new BoxError("aborted", "the call was aborted")));
			};
			const call = begin(frame, {
				onAnswer(answer) {
					settle(answer.ok === true ? ok(decode(answer.value)) : err(boxErrorOf(answer.error)));
				},
				lose(why) {
					settle(err(new BoxError("unknown", `the host's box call was lost (${why})`)));
				},
			});
			if (signal?.aborted) queueMicrotask(onAbort);
			else signal?.addEventListener("abort", onAbort, { once: true });
		});

	const execIn = (
		provider: string,
		label: string,
		command: readonly string[],
		execOptions: BoxExecOptions | undefined,
		context: Context,
	) =>
		new Promise<Result<BoxProcess, BoxError>>((resolve) => {
			// What the app reads of either stream may let the runner acknowledge again.
			const stdout = chunks(() => acknowledge(call));
			const stderr = chunks(() => acknowledge(call));
			let exited!: (result: Result<number, BoxError>) => void;
			const exit = new Promise<Result<number, BoxError>>((done) => {
				exited = done;
			});
			let stdinN = 0;
			const acks = new Map<number, () => void>();
			let started = false;
			const signal = context.abortSignal;
			const stop = (result: Result<number, BoxError>) => {
				signal?.removeEventListener("abort", onAbort);
				stdout.end();
				stderr.end();
				for (const release of acks.values()) release();
				acks.clear();
				end(call);
				exited(result);
			};
			const write = (frame: Omit<Frame, "id" | "t" | "n">) =>
				new Promise<void>((done) => {
					stdinN += 1;
					const n = stdinN;
					const sent: Frame = { t: "box-stdin", id: call.id, n, ...frame };
					call.pending.set(n, sent);
					acks.set(n, done);
					send?.(sent);
				});
			const call = begin(
				{
					t: "box",
					op: "exec",
					provider,
					box: label,
					args: { command: [...command], ...(execOptions === undefined ? {} : { options: execOptions }) },
				},
				{
					onAnswer(answer) {
						if (answer.ok !== true) {
							signal?.removeEventListener("abort", onAbort);
							end(call);
							resolve(err(boxErrorOf(answer.error)));
							return;
						}
						started = true;
						resolve(
							ok({
								stdin: {
									write: (bytes: Uint8Array) => write({ bytes: toBase64(bytes) }),
									close: () => write({ close: true }),
								},
								stdout: stdout.iterable,
								stderr: stderr.iterable,
								wait: () => exit,
							}),
						);
					},
					onStream(frame) {
						if (typeof frame.stdin === "number") {
							call.pending.delete(frame.stdin);
							acks.get(frame.stdin)?.();
							acks.delete(frame.stdin);
						} else if (frame.exit !== undefined) {
							const result = frame.exit as { ok?: boolean; value?: unknown; error?: unknown };
							stop(result.ok === true ? ok(Number(result.value)) : err(boxErrorOf(result.error)));
						} else {
							const chunk = fromBase64(frame.bytes);
							call.bytesSinceAck += chunk.byteLength;
							(frame.stream === "stderr" ? stderr : stdout).push(chunk);
						}
					},
					lose(why) {
						const error = new BoxError("unknown", `the host's box call was lost (${why})`);
						if (!started) {
							end(call);
							resolve(err(error));
						} else stop(err(error));
					},
				},
			);
			call.unread = () => stdout.unread() + stderr.unread();
			// Aborting ends the wait; it does not promise the program died, as for any box.
			function onAbort() {
				send?.({ t: "box-abort", id: call.id });
				if (!started) {
					end(call);
					resolve(err(new BoxError("aborted", "the call was aborted")));
				} else stop(err(new BoxError("aborted", "the call was aborted")));
			}
			signal?.addEventListener("abort", onAbort, { once: true });
		});

	const handle = (provider: string, label: string, facts: BoxFacts): Box => {
		const box: Box = {
			id: label,
			facts: () => facts,
			exec: (command, execOptions, context) => execIn(provider, label, command, execOptions, context),
			upload: (files, context) =>
				ask(
					{
						t: "box",
						op: "upload",
						provider,
						box: label,
						args: {
							files: files.map((file) => ({
								path: file.path,
								bytes: toBase64(file.bytes),
								...(file.mode === undefined ? {} : { mode: file.mode }),
							})),
						},
					},
					context,
					() => undefined,
				),
			download: (paths, context) =>
				ask({ t: "box", op: "download", provider, box: label, args: { paths: [...paths] } }, context, (value) =>
					((value ?? []) as { path: string; bytes: string; mode?: number }[]).map(
						(file): BoxFile => ({
							path: file.path,
							bytes: fromBase64(file.bytes),
							...(typeof file.mode === "number" ? { mode: file.mode } : {}),
						}),
					),
				),
			status: (context) =>
				ask({ t: "box", op: "status", provider, box: label }, context, (value) => value as BoxStatus),
			destroy: (context) => ask({ t: "box", op: "destroy", provider, box: label }, context, () => undefined),
		};
		if (facts.snapshot === null) return box;
		return {
			...box,
			snapshot: (context: Context) =>
				ask({ t: "box", op: "snapshot", provider, box: label }, context, (value) => value as BoxSnapshot),
		};
	};
	const handleOf = (provider: string) => (value: unknown) => {
		const made = value as { box: string; facts: BoxFacts };
		return handle(provider, made.box, made.facts);
	};

	const providers: Record<string, BoxProvider> = {};
	for (const name of names) {
		providers[name] = {
			name,
			create: (spec, context) =>
				ask({ t: "box", op: "create", provider: name, args: { spec } }, context, handleOf(name)),
			attach: (id, context) =>
				ask({ t: "box", op: "attach", provider: name, args: { box: id } }, context, (value) =>
					value === null ? undefined : handleOf(name)(value),
				),
			list: (labels, context) =>
				ask(
					{ t: "box", op: "list", provider: name, args: { labels } },
					context,
					(value) => value as readonly BoxRef[],
				),
		};
	}

	return {
		providers,
		receive(frame) {
			if (frame.t !== "box-answer" && frame.t !== "box-stream" && frame.t !== "box-unknown") return false;
			const call = typeof frame.id === "string" ? open.get(frame.id) : undefined;
			if (call === undefined) return true;
			if (frame.t === "box-unknown") {
				// The host never saw the call: sending it again cannot act twice. A call it answered and forgot is lost.
				if (call.seq > 0) call.lose("the host no longer knows this call");
				else send?.(call.request);
				return true;
			}
			const seq = typeof frame.seq === "number" ? frame.seq : -1;
			// A replay after a resume can repeat frames; a gap means what follows cannot be trusted.
			if (seq <= call.seq) return true;
			if (seq !== call.seq + 1) {
				call.lose(`frame ${seq} came after ${call.seq}`);
				return true;
			}
			call.seq = seq;
			if (frame.t === "box-answer") call.onAnswer(frame);
			else call.onStream?.(frame);
			acknowledge(call);
			return true;
		},
		up(next) {
			send = next;
			for (const call of open.values()) {
				clearTimeout(call.deadline);
				call.deadline = undefined;
				// The host answers with what was missed, or with box-unknown when the call never reached it.
				next({ t: "box-resume", id: call.id, after: call.seq });
				for (const pending of call.pending.values()) next(pending);
				// An acknowledgement the link lost on its way down is said again, and what the app read while the link was
				// down is acknowledged now: the host may be waiting at its window for it.
				if (call.lastAcked > 0) next({ t: "box-ack", id: call.id, seq: call.lastAcked });
				acknowledge(call, true);
			}
		},
		down(reason) {
			send = undefined;
			for (const call of open.values()) wait(call, reason);
		},
	};
}
