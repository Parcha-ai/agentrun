import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Result } from "@earendil-works/pi-durable/env";
import type { DrainOptions } from "./gate.ts";
import { type Frame, LINK_VERSION, type Link } from "./link.ts";
import { type Catalog, type ProxyModels, proxyModels } from "./models.ts";
import { type Home, type HomeOptions, openHome, type ResumeOrder } from "./run.ts";

/** The exit code of a runner the host refused: its epoch is not the lease's. Its launcher must not start it again. */
export const EXIT_REFUSED = 75;

/** What a runner needs: a home's options, without models, which come from the host over the link. */
export type RunnerOptions = Omit<HomeOptions, "models"> & {
	/** How long a model request waits for a lost link to come back. Default 30 s. */
	readonly resumeWithinMs?: number;
};

/** How a runner ended. `retired`: a later epoch took the session. `refused`: the host refused this runner's epoch. */
export type RunnerEnd = { readonly how: "retired" | "refused"; readonly exitCode: number; readonly reason: string };

/** A session's runner: the home of a session, driven by the host over a link. */
export interface Runner {
	/** Serve a host on `link`. A link that comes while another is up replaces it: one host at a time. */
	attach(link: Link): void;
	/** Settles when the runner is done with the session. */
	readonly ended: Promise<RunnerEnd>;
	/** The home, once the first host said hello. */
	readonly home: Home | undefined;
}

/** An error as it travels: its class, its code and its message. */
export type WireError = {
	readonly name: string;
	readonly code: string;
	readonly message: string;
	readonly holdouts?: readonly { readonly kind: string; readonly count: number }[];
};

function wire(error: Error & { code?: unknown; holdouts?: unknown }): WireError {
	return {
		name: error.name,
		code: typeof error.code === "string" ? error.code : "unknown",
		message: error.message,
		...(Array.isArray(error.holdouts) ? { holdouts: error.holdouts as WireError["holdouts"] } : {}),
	};
}

/**
 * A runner. It opens nothing until a host says so: a runner its launcher started again, with no host, waits. Every
 * frame it sends carries the epoch it runs at, so the host can refuse a home the lease left behind.
 *
 * What a lost link does: model requests wait for it to come back for a while. A drain in progress is given up, so held
 * work goes on: no host is there to finish the move. A home that sealed stays sealed until a host says `reopen` or
 * `retire`.
 */
export function createRunner(options: RunnerOptions, context: Context = BACKGROUND_CONTEXT): Runner {
	let proxy: ProxyModels | undefined;
	// The one opening of the home, with the models it opened with. A host that says hello meanwhile waits for it.
	let opening: { readonly proxy: ProxyModels; readonly home: Promise<Result<Home, Error>> } | undefined;
	let home: Home | undefined;
	let current: Link | undefined;
	let finished = false;
	let end: (how: RunnerEnd) => void = () => {};
	const ended = new Promise<RunnerEnd>((resolve) => {
		end = resolve;
	});

	const stop = async (how: RunnerEnd["how"], exitCode: number, reason: string) => {
		if (finished) return;
		finished = true;
		proxy?.down(reason);
		if (how === "refused") await home?.close(context);
		current?.close(reason);
		end({ how, exitCode, reason });
	};

	const send = (link: Link, frame: Frame): boolean => link.send({ ...frame, epoch: home?.epoch ?? null });

	const answer = async (
		link: Link,
		id: unknown,
		work: () => Promise<Result<unknown, Error>>,
		then?: (result: Result<unknown, Error>) => void,
	): Promise<void> => {
		let result: Result<unknown, Error>;
		try {
			result = await work();
		} catch (cause) {
			result = { ok: false, error: cause instanceof Error ? cause : new Error(String(cause)) };
		}
		send(
			link,
			result.ok
				? { t: "answer", id, ok: true, value: result.value ?? null }
				: { t: "answer", id, ok: false, error: wire(result.error) },
		);
		then?.(result);
	};

	/** One order, in `within`: the runner's context, which the host's `cancel` for this order ends. */
	const run = async (home: Home, order: string, args: Readonly<Record<string, unknown>>, within: Context) => {
		switch (order) {
			case "resume":
				return home.resume(args as unknown as ResumeOrder, within);
			case "reopen":
				return home.reopen({ epoch: Number(args.epoch) }, within);
			case "retire":
				return home.retire({ epoch: Number(args.epoch) }, within);
			case "drain":
				return home.drain(args as DrainOptions, within);
			case "abandon":
				home.abandon();
				return { ok: true as const, value: null };
			case "seal":
				return home.seal(within);
			case "submit": {
				const root = await home.root(within);
				if (!root.ok) return root;
				const requestId = typeof args.requestId === "string" ? args.requestId : undefined;
				const submission = await root.value.submit(
					{ type: "input", content: String(args.content), ...(requestId === undefined ? {} : { requestId }) },
					within,
				);
				return { ok: true as const, value: { submission: submission.id } };
			}
			case "idle": {
				const root = await home.root(within);
				if (!root.ok) return root;
				await root.value.waitForIdle(within);
				return { ok: true as const, value: null };
			}
			case "status":
				return {
					ok: true as const,
					value: {
						state: home.state,
						epoch: home.epoch ?? null,
						...(home.sealed === undefined ? {} : { sealed: home.sealed }),
					},
				};
			default:
				return { ok: false as const, error: new Error(`no such order: ${order}`) };
		}
	};

	const hello = async (link: Link, frame: Frame) => {
		if (frame.v !== LINK_VERSION) {
			link.close(`the host speaks version ${String(frame.v)} of the link; this runner speaks ${LINK_VERSION}`);
			return;
		}
		if (opening === undefined) {
			const made = proxyModels(frame.catalog as Catalog, {
				...(options.resumeWithinMs === undefined ? {} : { resumeWithinMs: options.resumeWithinMs }),
			});
			proxy = made;
			opening = { proxy: made, home: openHome({ ...options, models: made.models }) };
		}
		const mine = opening;
		const opened = await mine.home;
		if (!opened.ok) {
			// Nothing opened: the next host's hello tries again, with its own catalog. Ready only with a home.
			if (opening === mine) {
				opening = undefined;
				proxy = undefined;
			}
			send(link, { t: "ready", v: LINK_VERSION, ok: false, error: wire(opened.error) });
			return;
		}
		home = opened.value;
		if (link !== current) return;
		mine.proxy.up((model) => (current === link ? send(link, model) : false));
		send(link, { t: "ready", v: LINK_VERSION, ok: true, session: options.session, state: opened.value.state });
	};

	return {
		attach(link) {
			if (finished) {
				link.close("this runner has ended");
				return;
			}
			const previous = current;
			current = link;
			previous?.close("another host connected");
			// The orders of this link that still run, by id: a `cancel` ends one's context.
			const running = new Map<unknown, () => void>();
			link.onFrame((frame) => {
				if (current !== link) return;
				if (frame.t === "hello") void hello(link, frame);
				else if (frame.t === "refused") void stop("refused", EXIT_REFUSED, String(frame.reason ?? "refused"));
				else if (frame.t === "cancel") running.get(frame.id)?.();
				else if (proxy?.receive(frame)) return;
				else if (frame.t === "order") {
					const active = home;
					if (active === undefined) {
						void answer(link, frame.id, async () => ({ ok: false, error: new Error("no hello yet") }));
						return;
					}
					const args = (frame.args ?? {}) as Readonly<Record<string, unknown>>;
					const order = String(frame.order);
					const within = withCancel(context);
					running.set(frame.id, within.cancel);
					// A home that retired has no session left: the runner ends once the host has its answer.
					void answer(
						link,
						frame.id,
						() => run(active, order, args, within.context),
						(result) => {
							running.delete(frame.id);
							if (order === "retire" && result.ok)
								void stop("retired", 0, `epoch ${String(args.epoch)} took the session`);
						},
					);
				}
			});
			link.onClose((reason) => {
				if (current !== link) return;
				current = undefined;
				proxy?.down(reason);
				// No host is there to finish a move: held work goes on. A sealed home stays sealed.
				if (home?.state === "open") home.abandon();
			});
		},
		ended,
		get home() {
			return home;
		},
	};
}
