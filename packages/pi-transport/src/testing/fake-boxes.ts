import type { Context } from "@earendil-works/chord";
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
	type BoxSpec,
	type BoxStatus,
	isReservedLabel,
} from "../box/box.ts";

/**
 * A box provider for tests: it does what a test scripts and writes down everything it was asked. It runs no real program:
 * a program in a fake box is a function the test registers (`program`), and the box's files are in memory. It follows the
 * `BoxProvider` / `Box` contract (typed errors as values, stable ids, labels, facts), so a test written against it
 * holds on a real provider.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------------------------------------------------
// Time

/** Time for a fake provider: `now`, a timer that can be cancelled, and, on a fake clock, `advance`. */
export interface FakeClock {
	now(): number;
	/** Run `fn` after `ms`; the returned function cancels it. */
	after(ms: number, fn: () => void): () => void;
	/** Move time forward, running every due timer in order. Only a clock made by `fakeClock()` can. */
	advance(ms: number): Promise<void>;
}

/** Real time: delays are real, `advance` is refused. */
export const realClock: FakeClock = {
	now: () => Date.now(),
	after: (ms, fn) => {
		const timer = setTimeout(fn, ms);
		return () => clearTimeout(timer);
	},
	advance: () => Promise.reject(new Error("a real clock cannot be advanced: pass fakeClock() to the provider")),
};

/** A clock that moves only when a test says: no waiting, timers in due order. */
export function fakeClock(start = 0): FakeClock {
	let now = start;
	let seq = 0;
	const timers: { at: number; seq: number; fn: () => void }[] = [];
	const settle = async () => {
		for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
	};
	return {
		now: () => now,
		after(ms, fn) {
			const timer = { at: now + Math.max(0, ms), seq: seq++, fn };
			timers.push(timer);
			return () => {
				const at = timers.indexOf(timer);
				if (at >= 0) timers.splice(at, 1);
			};
		},
		async advance(ms) {
			const target = now + ms;
			await settle();
			for (;;) {
				timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
				const next = timers[0];
				if (next === undefined || next.at > target) break;
				timers.shift();
				now = next.at;
				next.fn();
				await settle();
			}
			now = target;
			await settle();
		},
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// What a provider records

export type FakeOp =
	| "create"
	| "attach"
	| "list"
	| "exec"
	| "upload"
	| "download"
	| "status"
	| "destroy"
	| "snapshot"
	| "launch"
	| "launchState"
	| "launchStop"
	/** A launcher's incarnation of its program (the first, and each restart): the fake's own event, never a host call. It is not an `exec`. */
	| "incarnation";

/** One call a provider saw, in the order it saw them. */
export type FakeCall = {
	/** 1.., in the order the provider saw the calls (not the order they finished). */
	readonly seq: number;
	/** The clock's `now()` when the call was seen. */
	readonly at: number;
	endedAt?: number;
	readonly op: FakeOp;
	/** The box's id. Absent for `create` and `list`; a `create` that succeeded names its box in `box` after it ends. */
	box?: string;
	/** For `exec`: exactly what was passed, never joined into a string. */
	readonly argv?: readonly string[];
	readonly options?: BoxExecOptions;
	/** For `exec`: the NAMES of the program's environment, never the values. */
	readonly envKeys?: readonly string[];
	/** For `exec`: every byte written to its stdin, in order. */
	stdin?: Uint8Array;
	stdinClosed?: boolean;
	/** For `upload` and `download`: paths, sizes and modes. Content is read through `box.files`. */
	readonly files?: readonly { readonly path: string; readonly bytes?: number; readonly mode?: number }[];
	/** For `launch`, `launchState`, `launchStop` and `incarnation`: the launch's id; for an `incarnation`, which one (1 is the first start). */
	launch?: string;
	incarnation?: number;
	/** For `launch`: who the program runs as, and the restart policy, as asked. */
	user?: string;
	restart?: { readonly onFailure: boolean; readonly preventExit?: readonly number[] };
	/** For `create`: the spec as asked. */
	readonly spec?: BoxSpec;
	/** For `attach` and `list`: what was asked. */
	readonly asked?: string | Readonly<Record<string, string>>;
	/** What the provider answered. */
	result: "pending" | "ok" | { readonly error: BoxErrorCode; readonly message: string };
	/** The label of the script rule that decided this call, so a failure line says why. */
	scripted?: string;
};

/** Where a value was found in what a provider recorded. */
export type FakeLeak = {
	readonly seq: number;
	readonly op: FakeOp;
	readonly where: "argv" | "env" | "stdin" | "upload" | "path" | "label" | "spec";
};

// ---------------------------------------------------------------------------------------------------------------------
// Scripts

export type CallMatch = {
	readonly op: FakeOp | "*";
	/** A box id. */
	readonly box?: string;
	/** The nth call of this op, 1-based: counted per box when `box` is set, else per provider. */
	readonly nth?: number;
	/** For `exec`: pick a command. */
	readonly argv?: (argv: readonly string[]) => boolean;
	/** Anything else the call shows. */
	readonly when?: (call: FakeCall) => boolean;
};

export type Outcome =
	/** `leakBox` (on a `create`): the call fails, but the box was made and `list` and `attach` find it: a create whose call failed after the machine existed. */
	| { readonly fail: BoxErrorCode; readonly message?: string; readonly leakBox?: boolean }
	| { readonly delayMs: number; readonly next?: Outcome }
	| { readonly hang: true }
	| { readonly lose: "stdin-eof" | "stdout" | "stderr" }
	| { readonly truncate: { readonly stream: "stdout" | "stderr"; readonly afterBytes: number } }
	| { readonly exit: number }
	| { readonly gone: { readonly afterBytes?: number } | true }
	| { readonly refuse: "unsupported" };

export type FakeRule = {
	readonly label: string;
	remaining: number;
	readonly match: CallMatch;
	readonly outcome: Outcome;
};

export interface FakeScript {
	/** A rule: the first rule whose match fits a call decides it. One call each unless `times` says more. */
	on(match: CallMatch, outcome: Outcome, options?: { readonly times?: number; readonly label?: string }): FakeRule;
	clear(): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// Programs

export type ProgramMatch = string | ((argv: readonly string[]) => boolean);

export type ProgramContext = {
	readonly argv: readonly string[];
	/** What the program sees: the box's `spec.env`. A secret is never here. */
	readonly env: Readonly<Record<string, string>>;
	readonly stdin: { read(): Promise<Uint8Array | null>; readAll(): Promise<Uint8Array> };
	readonly stdout: { write(bytes: Uint8Array | string): void };
	readonly stderr: { write(bytes: Uint8Array | string): void };
	readonly files: FakeFiles;
	/** Aborts when the box ends or the program is killed or timed out. */
	readonly signal: AbortSignal;
	readonly box: FakeBox;
	readonly clock: FakeClock;
};

/** Resolves with the exit code. */
export type Program = (context: ProgramContext) => Promise<number> | number;

/** One program started in a fake box, for a test to look at. */
export type FakeProgramRun = {
	readonly argv: readonly string[];
	state: "running" | "exited";
	exitCode?: number;
	killed: boolean;
	/** Everything the program wrote, as text. */
	stdout: string;
	stderr: string;
};

// ---------------------------------------------------------------------------------------------------------------------
// Files

type Entry = { bytes: Uint8Array; mode: number | undefined };

/** A box's file system, in memory. Paths are absolute; a relative path resolves against the box's workspace. */
export class FakeFiles {
	readonly #entries = new Map<string, Entry>();
	readonly #workspace: string;

	constructor(workspace: string) {
		this.#workspace = workspace;
	}

	#key(path: string): string {
		const absolute = path.startsWith("/") ? path : `${this.#workspace}/${path}`;
		const parts: string[] = [];
		for (const part of absolute.split("/")) {
			if (part === "" || part === ".") continue;
			if (part === "..") parts.pop();
			else parts.push(part);
		}
		return `/${parts.join("/")}`;
	}

	has(path: string): boolean {
		return this.#entries.has(this.#key(path));
	}

	get(path: string): Uint8Array | undefined {
		return this.#entries.get(this.#key(path))?.bytes;
	}

	text(path: string): string | undefined {
		const bytes = this.get(path);
		return bytes === undefined ? undefined : decoder.decode(bytes);
	}

	mode(path: string): number | undefined {
		return this.#entries.get(this.#key(path))?.mode;
	}

	set(path: string, bytes: Uint8Array | string, mode?: number): void {
		this.#entries.set(this.#key(path), {
			bytes: typeof bytes === "string" ? encoder.encode(bytes) : new Uint8Array(bytes),
			mode,
		});
	}

	delete(path: string): boolean {
		return this.#entries.delete(this.#key(path));
	}

	/** The paths of every file under `dir` (all depths), sorted. */
	list(dir = "."): string[] {
		const root = this.#key(dir);
		const prefix = root === "/" ? "/" : `${root}/`;
		return [...this.#entries.keys()].filter((key) => key.startsWith(prefix)).sort();
	}

	all(): [string, Uint8Array][] {
		return [...this.#entries].map(([path, entry]) => [path, entry.bytes]);
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// The provider

/** What a box reports: the contract's facts, and the ones its contract is about to carry (placeholders until they land on `BoxFacts`). */
export type FakeFacts = Partial<BoxFacts> & {
	readonly fuse?: boolean;
	readonly startedAt?: string;
	/** Yama ptrace_scope as the box reads it, and whether a launcher may raise it. */
	readonly ptraceScope?: 0 | 1 | 2;
	readonly ptraceRaisable?: boolean;
};

export type FakeBoxesOptions = {
	/** `BoxProvider.name`. Default `fake`. */
	readonly name?: string;
	/** What every box reports; `spec` fields (`cpus`, `memoryMb`, `gpu`, `workspace`) win for those. */
	readonly facts?: FakeFacts;
	/** `true`: each box reports `startedAt` (ISO, from the clock) in its facts. A placeholder until the box contract carries it. */
	readonly startedAt?: boolean;
	/** The most restarts a launcher makes of a program that keeps failing. Default 10. */
	readonly maxRestarts?: number;
	readonly clock?: FakeClock;
	/** Live boxes at once; the next `create` is `capacity`. Default unlimited. */
	readonly capacity?: number;
	/** The id of the nth box. Default `fake-1`, `fake-2`. */
	readonly ids?: (n: number) => string;
	/** `true`: the box ends when its first program exits, with that program's exit code (a box whose life is one program). Default `false`. */
	readonly endsWithProgram?: boolean;
	/** `false`: leave out the built-in programs (`cat`, `sleep`, `true`, `false`, `echo`, `env`). */
	readonly programs?: boolean;
};

export interface FakeProvider extends BoxProvider {
	create(spec: BoxSpec, context: Context): Promise<Result<FakeBox, BoxError>>;
	attach(id: string, context: Context): Promise<Result<FakeBox | undefined, BoxError>>;
	readonly script: FakeScript;
	readonly calls: readonly FakeCall[];
	readonly boxes: readonly FakeBox[];
	readonly clock: FakeClock;
	box(id: string): FakeBox | undefined;
	callsOf(op: FakeOp, box?: string): FakeCall[];
	/** Register what a command does. The latest registration wins over earlier ones and over the built-ins. */
	program(match: ProgramMatch, run: Program): void;
	/** Every live box ends, as if the machine went away. */
	endAll(exitCode?: number | null): void;
	/** Where a value appears in anything recorded: argv, an env value, stdin, an upload's bytes or path, a label, a spec. */
	leaks(marker: string | Uint8Array): FakeLeak[];
}

/**
 * The launcher's types as the K2 signature assumes them (T3's launch / launchState / launchStop), PLACEHOLDERS until T3 lands on main:
 * the names and shapes follow that signature and are replaced by T3's own.
 */
export type FakeLaunchSpec = {
	readonly argv: readonly string[];
	readonly user: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly inheritEnv?: boolean;
	/** Replayed to every incarnation. */
	readonly stdin?: Uint8Array;
	readonly restart?: { readonly onFailure: boolean; readonly preventExit?: readonly number[] };
	/** Run on a planned stop, after the drain and before the kill. */
	readonly beforeStop?: readonly string[];
};
/** What `launch` returns: Json-able, kept by the host. */
export type FakeLaunchHandle = { readonly id: string };
export type FakeLaunchState = {
	readonly state: "starting" | "running" | "exited";
	readonly code: number | null;
	readonly incarnation: number;
	readonly restarts: number;
};
/** One launch, for a test to read and to drive. */
export interface FakeLaunch {
	readonly id: string;
	readonly spec: FakeLaunchSpec;
	/** What the launcher reports now. */
	readonly status: FakeLaunchState;
	/** In order: what a planned stop did (`drain`, `beforeStop`, `kill`). */
	readonly events: readonly string[];
	/** The instance exits now with this code; the launcher restarts it or settles as its policy says. */
	exit(code: number): void;
	/** Force what the launcher reports (for example `starting` for a while), without touching the program. */
	setState(state: Partial<FakeLaunchState>): void;
}

export interface FakeBox extends Box {
	readonly launches: readonly FakeLaunch[];
	launch(spec: FakeLaunchSpec, context: Context): Promise<Result<FakeLaunchHandle, BoxError>>;
	launchState(launch: FakeLaunchHandle, context: Context): Promise<Result<FakeLaunchState, BoxError>>;
	launchStop(
		launch: FakeLaunchHandle,
		options: { readonly graceMs: number },
		context: Context,
	): Promise<Result<void, BoxError>>;
	readonly spec: BoxSpec;
	readonly state: "running" | "ended";
	readonly files: FakeFiles;
	readonly programs: readonly FakeProgramRun[];
	/** The box ends now: calls pending on it answer `gone`, later ones too, status says ended. */
	end(exitCode?: number | null): void;
}

type Queue = {
	push(bytes: Uint8Array): void;
	end(): void;
	iterable: AsyncIterable<Uint8Array>;
};

function queue(): Queue {
	const chunks: Uint8Array[] = [];
	let ended = false;
	let wake: (() => void) | undefined;
	const notify = () => {
		const run = wake;
		wake = undefined;
		run?.();
	};
	return {
		push(bytes) {
			if (ended) return;
			chunks.push(bytes);
			notify();
		},
		end() {
			ended = true;
			notify();
		},
		iterable: {
			async *[Symbol.asyncIterator]() {
				for (;;) {
					const next = chunks.shift();
					if (next !== undefined) {
						yield next;
						continue;
					}
					if (ended) return;
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
				}
			},
		},
	};
}

const concat = (a: Uint8Array | undefined, b: Uint8Array): Uint8Array => {
	if (a === undefined) return new Uint8Array(b);
	const out = new Uint8Array(a.length + b.length);
	out.set(a);
	out.set(b, a.length);
	return out;
};

const contains = (haystack: Uint8Array, needle: Uint8Array): boolean =>
	needle.length > 0 && Buffer.from(haystack).includes(Buffer.from(needle));

const BUILT_INS: [ProgramMatch, Program][] = [
	["true", () => 0],
	["false", () => 1],
	[
		"echo",
		({ argv, stdout }) => {
			stdout.write(`${argv.slice(1).join(" ")}\n`);
			return 0;
		},
	],
	[
		"env",
		({ env, stdout }) => {
			for (const [key, value] of Object.entries(env)) stdout.write(`${key}=${value}\n`);
			return 0;
		},
	],
	[
		"cat",
		async ({ argv, stdin, stdout, stderr, files }) => {
			if (argv.length === 1) {
				stdout.write(await stdin.readAll());
				return 0;
			}
			let code = 0;
			for (const path of argv.slice(1)) {
				const bytes = files.get(path);
				if (bytes === undefined) {
					stderr.write(`cat: ${path}: No such file or directory\n`);
					code = 1;
				} else stdout.write(bytes);
			}
			return code;
		},
	],
	[
		"sleep",
		({ argv, clock, signal }) =>
			new Promise<number>((resolve) => {
				const cancel = clock.after(Number(argv[1] ?? 0) * 1000, () => resolve(0));
				signal.addEventListener("abort", () => {
					cancel();
					resolve(143);
				});
			}),
	],
];

/** A spec as it was when the call arrived: a later change to the caller's objects must not rewrite what was recorded. */
const copySpec = (spec: BoxSpec): BoxSpec => ({
	...spec,
	...(spec.env === undefined ? {} : { env: { ...spec.env } }),
	...(spec.labels === undefined ? {} : { labels: { ...spec.labels } }),
});

/** A provider for tests. See `FakeBoxesOptions`, `FakeProvider` and `FakeBox`. */
export function fakeBoxes(options: FakeBoxesOptions = {}): FakeProvider {
	const name = options.name ?? "fake";
	const clock = options.clock ?? realClock;
	const calls: FakeCall[] = [];
	const boxes: FakeBox[] = [];
	const rules: FakeRule[] = [];
	const programs: [ProgramMatch, Program][] = options.programs === false ? [] : [...BUILT_INS];
	/** What ends a started program with a chosen exit code: a test's `launch.exit(code)` and a launcher's stop. */
	const exits = new WeakMap<BoxProcess, (code: number) => void>();
	let ruleSeq = 0;

	/** How many calls of each op the provider has seen, overall and per box: counted ONCE per call, whatever rules exist. */
	const seenAll = new Map<FakeOp, number>();
	const seenByBox = new Map<string, number>();

	const find = (call: FakeCall, nthAll: number, nthBox: number | undefined): FakeRule | undefined => {
		for (const rule of rules) {
			if (rule.remaining <= 0) continue;
			const m = rule.match;
			if (m.op !== "*" && m.op !== call.op) continue;
			if (m.box !== undefined && m.box !== call.box) continue;
			if (m.nth !== undefined && m.nth !== (m.box === undefined ? nthAll : nthBox)) continue;
			if (m.argv !== undefined && (call.argv === undefined || !m.argv(call.argv))) continue;
			if (m.when !== undefined && !m.when(call)) continue;
			rule.remaining -= 1;
			return rule;
		}
		return undefined;
	};

	const record = (op: FakeOp, extra: Partial<FakeCall>): { call: FakeCall; rule: FakeRule | undefined } => {
		const call: FakeCall = { seq: calls.length + 1, at: clock.now(), op, result: "pending", ...extra };
		calls.push(call);
		const nthAll = (seenAll.get(op) ?? 0) + 1;
		seenAll.set(op, nthAll);
		let nthBox: number | undefined;
		if (call.box !== undefined) {
			const key = `${op}:${call.box}`;
			nthBox = (seenByBox.get(key) ?? 0) + 1;
			seenByBox.set(key, nthBox);
		}
		const rule = find(call, nthAll, nthBox);
		if (rule !== undefined) call.scripted = rule.label;
		return { call, rule };
	};

	const finish = <T>(call: FakeCall, result: Result<T, BoxError>): Result<T, BoxError> => {
		call.endedAt = clock.now();
		call.result = result.ok ? "ok" : { error: result.error.code, message: result.error.message };
		return result;
	};

	/** Wait `ms` on the clock, or end early when the context aborts: `true` when the wait ran its course. */
	const wait = (ms: number, context: Context): Promise<boolean> =>
		new Promise<boolean>((resolve) => {
			const signal = context.abortSignal;
			if (signal?.aborted === true) return resolve(false);
			let onAbort: (() => void) | undefined;
			const cancel = clock.after(ms, () => {
				if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
				resolve(true);
			});
			onAbort = () => {
				cancel();
				resolve(false);
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});

	const aborted = <T>(): Result<T, BoxError> => err(new BoxError("aborted", "the call was aborted"));

	/** A rule with its delay chain waited out: what the call does is the final outcome. `null` when the context aborted meanwhile. */
	const settled = async (rule: FakeRule | undefined, context: Context): Promise<FakeRule | undefined | null> => {
		if (rule === undefined) return undefined;
		let outcome: Outcome | undefined = rule.outcome;
		while (outcome !== undefined && "delayMs" in outcome) {
			if (!(await wait(outcome.delayMs, context))) return null;
			outcome = outcome.next;
		}
		return outcome === undefined ? undefined : { ...rule, outcome };
	};

	/** A call that is not an exec, through the script: `normal` runs when no rule decides otherwise. */
	async function scripted<T>(
		call: FakeCall,
		rule: FakeRule | undefined,
		context: Context,
		box: FakeBoxImpl | undefined,
		normal: () => Result<T, BoxError> | Promise<Result<T, BoxError>>,
	): Promise<Result<T, BoxError>> {
		if (context.abortSignal?.aborted === true) return finish(call, aborted<T>());
		const ready = await settled(rule, context);
		if (ready === null) return finish(call, aborted<T>());
		const outcome: Outcome | undefined = ready?.outcome;
		if (outcome !== undefined) {
			if ("fail" in outcome)
				return finish(
					call,
					err(new BoxError(outcome.fail, outcome.message ?? `scripted ${outcome.fail}`)) as Result<T, BoxError>,
				);
			if ("refuse" in outcome)
				return finish(call, err(new BoxError("unsupported", "scripted refusal")) as Result<T, BoxError>);
			if ("hang" in outcome) {
				// Never answers: it ends when the caller's context aborts, when the call's own timeout passes, or when the box ends.
				const signal = context.abortSignal;
				const how = await new Promise<"aborted" | "timeout" | "gone">((resolve) => {
					const undo: (() => void)[] = [];
					const settleWith = (value: "aborted" | "timeout" | "gone") => {
						for (const u of undo) u();
						resolve(value);
					};
					if (signal?.aborted === true) return settleWith("aborted");
					const onAbort = () => settleWith("aborted");
					signal?.addEventListener("abort", onAbort, { once: true });
					undo.push(() => signal?.removeEventListener("abort", onAbort));
					if (call.options?.timeoutMs !== undefined)
						undo.push(clock.after(call.options.timeoutMs, () => settleWith("timeout")));
					if (box !== undefined) undo.push(box.watchEnd(() => settleWith("gone")));
				});
				if (how === "timeout")
					return finish(
						call,
						err(new BoxError("timeout", `the call ran past ${call.options?.timeoutMs} ms`)) as Result<
							T,
							BoxError
						>,
					);
				if (how === "gone")
					return finish(call, err(new BoxError("gone", `the box ${box?.id} ended`)) as Result<T, BoxError>);
				return finish(call, aborted<T>());
			}
			if ("gone" in outcome) {
				box?.end(null);
				return finish(call, err(new BoxError("gone", "scripted: the box ended")) as Result<T, BoxError>);
			}
		}
		if (box?.state === "ended" && call.op !== "destroy" && call.op !== "status") {
			return finish(call, err(new BoxError("gone", `the box ${box.id} ended`)) as Result<T, BoxError>);
		}
		return finish(call, await normal());
	}

	class FakeBoxImpl implements FakeBox {
		readonly id: string;
		readonly spec: BoxSpec;
		readonly files: FakeFiles;
		readonly programs: FakeProgramRun[] = [];
		state: "running" | "ended" = "running";
		#exitCode: number | null = null;
		readonly #facts: BoxFacts & FakeFacts;
		readonly launches: LaunchImpl[] = [];
		readonly #killers = new Set<() => void>();
		readonly #cancelLife: () => void;

		constructor(id: string, spec: BoxSpec) {
			this.id = id;
			this.spec = spec;
			const workspace = spec.workspace ?? options.facts?.workspace ?? "/workspace";
			this.files = new FakeFiles(workspace);
			this.#facts = {
				provider: name,
				isolation: "container",
				cpus: null,
				memoryMb: null,
				gpu: null,
				snapshot: null,
				...options.facts,
				// What the spec asked for wins over the provider's defaults; the defaults stay where the spec is silent.
				...(spec.cpus === undefined ? {} : { cpus: spec.cpus }),
				...(spec.memoryMb === undefined ? {} : { memoryMb: spec.memoryMb }),
				...(spec.gpu === undefined ? {} : { gpu: spec.gpu }),
				maxLifetimeMs: spec.maxLifetimeMs,
				...(options.startedAt === true ? { startedAt: new Date(clock.now()).toISOString() } : {}),
				workspace,
			};
			this.#cancelLife = clock.after(spec.maxLifetimeMs, () => this.end(null));
		}

		/** Calls `fn` when the box ends; the returned function stops watching. */
		watchEnd(fn: () => void): () => void {
			this.#killers.add(fn);
			return () => this.#killers.delete(fn);
		}

		facts(): BoxFacts & FakeFacts {
			return this.#facts;
		}

		end(exitCode: number | null = null): void {
			if (this.state === "ended") return;
			this.state = "ended";
			this.#exitCode = exitCode;
			this.#cancelLife();
			for (const kill of [...this.#killers]) kill();
		}

		status(context: Context): Promise<Result<BoxStatus, BoxError>> {
			const { call, rule } = record("status", { box: this.id });
			return scripted(call, rule, context, this, () =>
				ok(
					this.state === "running"
						? ({ state: "running" } as const)
						: ({ state: "ended", exitCode: this.#exitCode } as const),
				),
			);
		}

		destroy(context: Context): Promise<Result<void, BoxError>> {
			const { call, rule } = record("destroy", { box: this.id });
			return scripted(call, rule, context, this, () => {
				this.end(null);
				return ok(undefined);
			});
		}

		upload(files: readonly BoxFile[], context: Context): Promise<Result<void, BoxError>> {
			const { call, rule } = record("upload", {
				box: this.id,
				files: files.map((f) => ({
					path: f.path,
					bytes: f.bytes.length,
					...(f.mode === undefined ? {} : { mode: f.mode }),
				})),
			});
			(call as { uploads?: readonly BoxFile[] }).uploads = files.map((f) => ({
				...f,
				bytes: new Uint8Array(f.bytes),
			}));
			return scripted(call, rule, context, this, () => {
				for (const file of files) this.files.set(file.path, file.bytes, file.mode);
				return ok(undefined);
			});
		}

		download(paths: readonly string[], context: Context): Promise<Result<readonly BoxFile[], BoxError>> {
			const { call, rule } = record("download", { box: this.id, files: paths.map((path) => ({ path })) });
			return scripted(call, rule, context, this, () => {
				const out: BoxFile[] = [];
				for (const path of paths) {
					const bytes = this.files.get(path);
					if (bytes === undefined) return err(new BoxError("not_found", `${path} does not exist`));
					const mode = this.files.mode(path);
					out.push({ path, bytes: new Uint8Array(bytes), ...(mode === undefined ? {} : { mode }) });
				}
				return ok(out);
			});
		}

		async launch(spec: FakeLaunchSpec, context: Context): Promise<Result<FakeLaunchHandle, BoxError>> {
			const { call, rule: asked } = record("launch", {
				box: this.id,
				argv: [...spec.argv],
				user: spec.user,
				envKeys: Object.keys(spec.env ?? {}),
				...(spec.restart === undefined ? {} : { restart: { ...spec.restart } }),
			});
			const rule = await settled(asked, context);
			if (rule === null) return finish(call, aborted<FakeLaunchHandle>());
			return scripted(
				call,
				rule === undefined || !("exit" in rule.outcome) ? rule : undefined,
				context,
				this,
				() => {
					const handle = new LaunchImpl(`launch-${this.launches.length + 1}`, spec, this);
					this.launches.push(handle);
					call.launch = handle.id;
					if (spec.stdin !== undefined) call.stdin = new Uint8Array(spec.stdin);
					call.stdinClosed = true;
					handle.begin(rule !== undefined && "exit" in rule.outcome ? rule.outcome.exit : undefined);
					return ok({ id: handle.id });
				},
			);
		}

		launchState(launch: FakeLaunchHandle, context: Context): Promise<Result<FakeLaunchState, BoxError>> {
			const { call, rule } = record("launchState", { box: this.id, launch: launch.id });
			return scripted(call, rule, context, this, () => {
				const found = this.launches.find((l) => l.id === launch.id);
				return found === undefined
					? err(new BoxError("not_found", `no launch ${launch.id}`))
					: ok({ ...found.status });
			});
		}

		launchStop(
			launch: FakeLaunchHandle,
			stopOptions: { readonly graceMs: number },
			context: Context,
		): Promise<Result<void, BoxError>> {
			const { call, rule } = record("launchStop", { box: this.id, launch: launch.id });
			return scripted(call, rule, context, this, async () => {
				const found = this.launches.find((l) => l.id === launch.id);
				if (found === undefined) return err(new BoxError("not_found", `no launch ${launch.id}`));
				await found.stop(stopOptions.graceMs);
				return ok(undefined);
			});
		}

		async exec(
			command: readonly string[],
			execOptions: BoxExecOptions | undefined,
			context: Context,
		): Promise<Result<BoxProcess, BoxError>> {
			const { call, rule } = record("exec", {
				box: this.id,
				argv: [...command],
				...(execOptions === undefined ? {} : { options: execOptions }),
				envKeys: Object.keys(this.spec.env ?? {}),
			});
			const ready = await settled(rule, context);
			if (ready === null) return finish(call, aborted<BoxProcess>());
			const outcome: Outcome | undefined = ready?.outcome;
			const started = await scripted(
				call,
				outcome !== undefined &&
					("lose" in outcome || "truncate" in outcome || "exit" in outcome || "gone" in outcome)
					? undefined
					: ready,
				context,
				this,
				() => ok(undefined),
			);
			if (!started.ok) return started;
			call.result = "pending";
			return ok(this.startProgram(call, command, execOptions, outcome, context.abortSignal));
		}

		startProgram(
			call: FakeCall,
			command: readonly string[],
			execOptions: BoxExecOptions | undefined,
			outcome: Outcome | undefined,
			callerSignal?: AbortSignal,
		): BoxProcess {
			const run: FakeProgramRun = { argv: [...command], state: "running", killed: false, stdout: "", stderr: "" };
			const first = this.programs.length === 0;
			this.programs.push(run);
			const stdinQueue: Uint8Array[] = [];
			let stdinEnded = false;
			let stdinWake: (() => void) | undefined;
			const abort = new AbortController();
			const out = queue();
			const errq = queue();
			let outBytes = 0;
			let errBytes = 0;
			const lose = outcome !== undefined && "lose" in outcome ? outcome.lose : undefined;
			const cut = outcome !== undefined && "truncate" in outcome ? outcome.truncate : undefined;
			const goneAfter =
				outcome !== undefined && "gone" in outcome && outcome.gone !== true ? outcome.gone.afterBytes : undefined;
			let written = 0;
			let done: (result: Result<number, BoxError>) => void = () => {};
			const result = new Promise<Result<number, BoxError>>((resolve) => {
				done = resolve;
			});
			let finished = false;
			const ended = (value: Result<number, BoxError>) => {
				if (finished) return;
				finished = true;
				run.state = "exited";
				if (value.ok) run.exitCode = value.value;
				out.end();
				errq.end();
				this.#killers.delete(kill);
				callerSignal?.removeEventListener("abort", onCallerAbort);
				if (options.endsWithProgram === true && first && value.ok) this.end(value.value);
				cancelTimeout();
				call.endedAt = clock.now();
				call.result = value.ok ? "ok" : { error: value.error.code, message: value.error.message };
				done(value);
			};
			const kill = () => {
				run.killed = true;
				abort.abort();
				ended(err(new BoxError("gone", `the box ${this.id} ended`)));
			};
			this.#killers.add(kill);
			// The caller's context aborting after exec returned ends the wait with `aborted` (the program is told to stop; the contract does not promise it dies).
			const onCallerAbort = () => {
				run.killed = true;
				abort.abort();
				ended(err(new BoxError("aborted", "the call was aborted")));
			};
			if (callerSignal?.aborted === true) queueMicrotask(onCallerAbort);
			else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
			const cancelTimeout =
				execOptions?.timeoutMs === undefined
					? () => {}
					: clock.after(execOptions.timeoutMs, () => {
							run.killed = true;
							abort.abort();
							ended(err(new BoxError("timeout", `the program ran past ${execOptions.timeoutMs} ms`)));
						});
			const write = (stream: "stdout" | "stderr") => (bytes: Uint8Array | string) => {
				const data = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
				run[stream] += decoder.decode(data);
				const hidden = lose === stream;
				const cap = cut?.stream === stream ? cut.afterBytes : undefined;
				const sent = stream === "stdout" ? outBytes : errBytes;
				const allowed = hidden
					? 0
					: cap === undefined
						? data.length
						: Math.max(0, Math.min(data.length, cap - sent));
				if (allowed > 0) (stream === "stdout" ? out : errq).push(data.subarray(0, allowed));
				if (stream === "stdout") outBytes += allowed;
				else errBytes += allowed;
			};
			const stdinReader = {
				read: async (): Promise<Uint8Array | null> => {
					for (;;) {
						const next = stdinQueue.shift();
						if (next !== undefined) return next;
						if (stdinEnded || finished) return null;
						await new Promise<void>((resolve) => {
							stdinWake = resolve;
						});
					}
				},
				readAll: async (): Promise<Uint8Array> => {
					let all: Uint8Array = new Uint8Array(0);
					for (;;) {
						const chunk = await stdinReader.read();
						if (chunk === null) return all;
						all = concat(all, chunk);
					}
				},
			};
			const wake = () => {
				const run2 = stdinWake;
				stdinWake = undefined;
				run2?.();
			};
			abort.signal.addEventListener("abort", wake);
			if (
				outcome !== undefined &&
				"gone" in outcome &&
				(outcome.gone === true || outcome.gone.afterBytes === undefined)
			)
				queueMicrotask(() => this.end(null));
			const program =
				outcome !== undefined && "exit" in outcome
					? undefined
					: programs
							.slice()
							.reverse()
							.find(([match]) => (typeof match === "string" ? command[0] === match : match(command)));
			if (outcome !== undefined && "exit" in outcome) {
				queueMicrotask(() => ended(ok(outcome.exit)));
			} else if (program === undefined) {
				queueMicrotask(() => {
					write("stderr")(`${command[0] ?? ""}: not found\n`);
					ended(ok(127));
				});
			} else {
				const env = { ...(this.spec.env ?? {}) };
				const context: ProgramContext = {
					argv: command,
					env,
					stdin: stdinReader,
					stdout: { write: write("stdout") },
					stderr: { write: write("stderr") },
					files: this.files,
					signal: abort.signal,
					box: this,
					clock,
				};
				queueMicrotask(() => {
					Promise.resolve()
						.then(() => program[1](context))
						.then(
							(code) => ended(ok(code)),
							(cause: unknown) => {
								write("stderr")(`${cause instanceof Error ? cause.message : String(cause)}\n`);
								ended(ok(70));
							},
						);
				});
			}
			const proc: BoxProcess = {
				stdin: {
					write: async (bytes) => {
						if (this.state === "ended" && !finished) throw new BoxError("gone", `the box ${this.id} ended`);
						call.stdin = concat(call.stdin, bytes);
						written += bytes.length;
						stdinQueue.push(new Uint8Array(bytes));
						wake();
						if (goneAfter !== undefined && written >= goneAfter) this.end(null);
					},
					close: async () => {
						call.stdinClosed = true;
						if (lose === "stdin-eof" && call.stdin === undefined) {
							// The end of an input nothing was written to is never delivered; close() returns once the program is gone.
							await result;
							return;
						}
						stdinEnded = true;
						wake();
					},
				},
				stdout: out.iterable,
				stderr: errq.iterable,
				wait: () => result,
			};
			exits.set(proc, (code) => {
				abort.abort();
				ended(ok(code));
			});
			return proc;
		}
	}

	class LaunchImpl implements FakeLaunch {
		readonly events: string[] = [];
		status: FakeLaunchState = { state: "starting", code: null, incarnation: 0, restarts: 0 };
		#proc: BoxProcess | undefined;
		#stopped = false;

		readonly id: string;
		readonly spec: FakeLaunchSpec;
		readonly box: FakeBoxImpl;

		constructor(id: string, spec: FakeLaunchSpec, box: FakeBoxImpl) {
			this.id = id;
			this.spec = spec;
			this.box = box;
		}

		begin(exitNow?: number): void {
			this.#incarnate(exitNow);
		}

		#incarnate(exitNow?: number): void {
			const n = this.status.incarnation + 1;
			const { call, rule } = record("incarnation", {
				box: this.box.id,
				launch: this.id,
				incarnation: n,
				argv: [...this.spec.argv],
			});
			if (rule !== undefined && "fail" in rule.outcome) {
				finish(call, err(new BoxError(rule.outcome.fail, rule.outcome.message ?? `scripted ${rule.outcome.fail}`)));
				this.status = { ...this.status, state: "exited" };
				return;
			}
			this.status = { ...this.status, state: "running", incarnation: n };
			const proc = this.box.startProgram(
				call,
				this.spec.argv,
				undefined,
				exitNow === undefined ? undefined : { exit: exitNow },
			);
			this.#proc = proc;
			void (async () => {
				if (this.spec.stdin !== undefined && this.spec.stdin.length > 0) await proc.stdin.write(this.spec.stdin);
				await proc.stdin.close();
			})().catch(() => {});
			void proc.wait().then((result) => {
				if (this.#proc !== proc) return;
				this.#exited(result);
			});
		}

		#exited(result: Result<number, BoxError>): void {
			if (this.#stopped || !result.ok) {
				this.status = { ...this.status, state: "exited", code: result.ok ? result.value : null };
				return;
			}
			const code = result.value;
			const policy = this.spec.restart;
			const again =
				policy?.onFailure === true &&
				code !== 0 &&
				!(policy.preventExit ?? []).includes(code) &&
				this.status.restarts < (options.maxRestarts ?? 10);
			if (!again) {
				this.status = { ...this.status, state: "exited", code };
				return;
			}
			this.status = { ...this.status, state: "starting", code, restarts: this.status.restarts + 1 };
			this.#incarnate();
		}

		exit(code: number): void {
			const proc = this.#proc;
			if (proc !== undefined) exits.get(proc)?.(code);
		}

		setState(state: Partial<FakeLaunchState>): void {
			this.status = { ...this.status, ...state };
		}

		async stop(_graceMs: number): Promise<void> {
			// A planned stop: from here a program that exits is not restarted, even while the hook runs.
			this.#stopped = true;
			this.events.push("drain");
			const before = this.spec.beforeStop;
			if (before !== undefined) {
				this.events.push("beforeStop");
				const silent: FakeCall = { seq: 0, at: clock.now(), op: "launchStop", result: "pending" };
				const hook = this.box.startProgram(silent, before, undefined, undefined);
				await hook.stdin.close();
				await hook.wait();
			}
			this.events.push("kill");
			this.exit(143);
			this.status = { ...this.status, state: "exited", code: 143 };
		}
	}

	const make = (spec: BoxSpec, call: FakeCall): Result<FakeBox, BoxError> => {
		if (!(spec.maxLifetimeMs > 0)) return err(new BoxError("invalid", "maxLifetimeMs must be a positive number"));
		const reserved = Object.keys(spec.labels ?? {}).find(isReservedLabel);
		if (reserved !== undefined) return err(new BoxError("invalid", `the label ${reserved} belongs to providers`));
		if (spec.isolation !== undefined && spec.isolation !== (options.facts?.isolation ?? "container")) {
			return err(new BoxError("unsupported", `this provider cannot give isolation ${spec.isolation}`));
		}
		if (options.capacity !== undefined && boxes.filter((b) => b.state === "running").length >= options.capacity) {
			return err(new BoxError("capacity", "the provider has no machine to give"));
		}
		const id = options.ids?.(boxes.length + 1) ?? `fake-${boxes.length + 1}`;
		const box = new FakeBoxImpl(id, spec);
		boxes.push(box);
		call.box = id;
		return ok(box);
	};

	return {
		name,
		clock,
		script: {
			on(match, outcome, ruleOptions) {
				const rule: FakeRule = {
					label: ruleOptions?.label ?? `rule-${++ruleSeq}`,
					remaining: ruleOptions?.times ?? 1,
					match,
					outcome,
				};
				rules.push(rule);
				return rule;
			},
			clear() {
				rules.length = 0;
			},
		},
		get calls() {
			return calls;
		},
		get boxes() {
			return boxes;
		},
		box: (id) => boxes.find((b) => b.id === id),
		callsOf: (op, box) => calls.filter((c) => c.op === op && (box === undefined || c.box === box)),
		program(match, run) {
			programs.push([match, run]);
		},
		endAll(exitCode = null) {
			for (const b of boxes) b.end(exitCode);
		},
		leaks(marker) {
			const needle = typeof marker === "string" ? encoder.encode(marker) : marker;
			const text = typeof marker === "string" ? marker : decoder.decode(marker);
			const found: FakeLeak[] = [];
			for (const call of calls) {
				const hit = (where: FakeLeak["where"]) => found.push({ seq: call.seq, op: call.op, where });
				if (call.argv?.some((a) => a.includes(text))) hit("argv");
				if (call.stdin !== undefined && contains(call.stdin, needle)) hit("stdin");
				if (call.files?.some((f) => f.path.includes(text))) hit("path");
				const uploads = (call as { uploads?: readonly BoxFile[] }).uploads;
				if (uploads?.some((f) => contains(f.bytes, needle))) hit("upload");
				if (call.spec !== undefined) {
					if (Object.values(call.spec.env ?? {}).some((v) => v.includes(text))) hit("env");
					if (Object.entries(call.spec.labels ?? {}).some(([k, v]) => k.includes(text) || v.includes(text)))
						hit("label");
					const { env: _env, labels: _labels, ...rest } = call.spec;
					if (JSON.stringify(rest).includes(text)) hit("spec");
				}
			}
			return found;
		},
		async create(spec, context) {
			const given = copySpec(spec);
			const { call, rule: asked } = record("create", { spec: given });
			const rule = await settled(asked, context);
			if (rule === null) return finish(call, aborted<FakeBox>());
			// leakBox: the machine exists although the call fails, as a create that failed after the sandbox was made.
			if (rule !== undefined && "fail" in rule.outcome && rule.outcome.leakBox === true) make(given, call);
			return scripted(call, rule, context, undefined, () => make(given, call));
		},
		async attach(id, context) {
			const { call, rule } = record("attach", { asked: id });
			return scripted(call, rule, context, undefined, () => {
				const found = boxes.find((b) => b.id === id);
				return ok(found !== undefined && found.state === "running" ? found : undefined);
			});
		},
		async list(labels, context) {
			const { call, rule } = record("list", { asked: labels });
			return scripted(call, rule, context, undefined, () =>
				ok(
					boxes
						.filter(
							(b) => b.state === "running" && Object.entries(labels).every(([k, v]) => b.spec.labels?.[k] === v),
						)
						.map((b): BoxRef => ({ id: b.id, labels: b.spec.labels ?? {} })),
				),
			);
		},
	};
}

/**
 * A Modal-like provider: a VM that can mount a FUSE file system, keeps programs running, moves files as files, reports when it
 * started, and reads ptrace_scope 0 (a launcher may raise it to 1).
 */
export function modalLike(overrides: FakeBoxesOptions = {}): FakeBoxesOptions {
	return {
		name: "modal-like",
		startedAt: true,
		...overrides,
		facts: {
			isolation: "vm",
			liveProcesses: true,
			bulk: "files",
			fuse: true,
			ptraceScope: 0,
			ptraceRaisable: true,
			...overrides.facts,
		},
	};
}

/**
 * A Daytona-like provider: a container with no FUSE (a host that needs a mount gets its UNSUPPORTED path), live programs, and
 * ptrace_scope 0 that cannot be raised.
 */
export function daytonaLike(overrides: FakeBoxesOptions = {}): FakeBoxesOptions {
	return {
		name: "daytona-like",
		startedAt: true,
		...overrides,
		facts: {
			isolation: "container",
			liveProcesses: true,
			bulk: "stream",
			fuse: false,
			ptraceScope: 0,
			ptraceRaisable: false,
			...overrides.facts,
		},
	};
}
