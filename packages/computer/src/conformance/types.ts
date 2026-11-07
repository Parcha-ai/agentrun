// The conformance suite's shapes: a case is data that names its level, its group and the capabilities it needs.
import type { ComputerClient, ComputerKind, DaemonMethod, DaemonMethods, ExecRunParams, Group, HelloResult } from "../protocol.js";
import type { ComputerConnection, ComputerProvider, ComputerRef, ComputerSpec, DaemonMode } from "../provider.js";
import type { ComputerError, ComputerErrorCode, Result } from "../result.js";
import type { StartedFixture } from "./fixture.js";

/** Core: what a computer of its kind must do. Full: an optional capability, tested only where it is declared. */
export type Level = "core" | "full";
/** The suite's own grouping of its cases, the first part of each case id; not the protocol's Group. */
export type CaseGroup = "health" | "exec" | "files" | "process" | "provider" | "drift" | "screen" | "input" | "touch" | "apps" | "lifetime";

/**
 * What a case needs: a group (declared by both the provider's capabilities().groups and the computer's hello), a
 * network the provider declares, the janitor as the keeper of deadlines, a spec.user the provider takes, or a provider
 * method that is optional (extend, stream), declared by being there.
 */
export type Capability =
	| Group
	| "network:none"
	| "network:open"
	| "network:allow"
	| "lifetime:janitor"
	| "user:root"
	| "user:uid"
	| "extend"
	| "stream";

/**
 * What a computer of this kind and daemon mode must declare: a case that needs one of these fails Core when it is
 * missing, where a case that needs an undeclared optional group is skipped. exec, files and processes are Core whenever
 * computerd runs (pid1 or child); with daemon none they are tested only when declared. Network none is Core wherever
 * computerd runs; a phone is tested on an open network.
 */
export function coreGroups(kind: ComputerKind, daemon: DaemonMode): Capability[] {
	const computerd: Capability[] = daemon === "none" ? [] : ["exec", "files", "processes", "network:none"];
	switch (kind) {
		case "linux":
			return computerd;
		case "desktop":
			return [...computerd, "screen", "input.pointer", "input.keys"];
		case "android":
		case "ios":
			return ["screen", "input.touch"];
		default:
			return computerd;
	}
}

/** exec.run's result with its streams decoded. */
export interface Ran {
	exitCode: number | null;
	signal?: string;
	out: string;
	err: string;
	timedOut: boolean;
	truncated: boolean;
}

/** What a case is given. Every computer and connection made through it is ended when the case ends. */
export interface CaseContext {
	readonly provider: ComputerProvider;
	readonly image: string;
	/** Aborts when the run is aborted or the case runs past its time. */
	readonly signal: AbortSignal;
	/** The case's computer: the run's shared one, or one made for this case alone. */
	readonly ref: ComputerRef;
	/** A connection of the case's own to that computer, after hello: computerd, or the provider itself (daemon none). */
	readonly client: ComputerClient;
	readonly hello: HelloResult;
	/** The label every computer of this run carries. */
	readonly runLabels: Record<string, string>;
	/** How long a case waits on a program before it fails: a bound, never a claim about speed. */
	readonly patience: number;
	/** A spec with this run's label, the image, a lifetime and network none, with extra over it. */
	spec(extra?: Partial<ComputerSpec>): ComputerSpec;
	/** Makes a computer for this case; fails the case when create refuses. */
	create(extra?: Partial<ComputerSpec>): Promise<ComputerRef>;
	/**
	 * Calls create with this whole spec, through by (default the provider), and gives its result as it is. The runner
	 * waits for it: a computer it makes is deleted when the case ends, or as it comes after that, named in cleanup.late.
	 */
	attempt(spec: ComputerSpec, by?: ComputerProvider): Promise<Result<ComputerRef>>;
	/** A computer the case made through another provider (the drifted one): deleted through it when the case ends. */
	track(ref: ComputerRef, by?: ComputerProvider): void;
	/** A further connection, to the case's computer or another; fails the case when connect refuses. */
	connect(ref?: ComputerRef): Promise<ComputerConnection>;
	/** The computer's HOME, which its user can write: the suite works under it. */
	home(): Promise<string>;
	/** A new directory for this case under HOME. */
	dir(): Promise<string>;
	/** The same provider with a daemon that reports another version; skips the case when none was given. */
	drifted(): Promise<ComputerProvider>;
	/**
	 * Starts the run's fixture in the case's computer and waits until it is up: an app that logs each input event it
	 * gets, so a case checks what an action did with no model. It is stopped when the case ends. Skips the case when the
	 * run was given no fixture, or none can start on this kind of computer.
	 */
	fixture(): Promise<StartedFixture>;
	/** fetch, as the run was given it; the global one by default. */
	fetch(url: string, init?: { signal?: AbortSignal; method?: string }): Promise<{ status: number }>;
	/** The run's clock: the wall clock by default. A case that waits on a vendor's timer reads time and waits through it. */
	clock: Clock;
	exec(argv: string[], extra?: Partial<ExecRunParams>, client?: ComputerClient): Promise<Ran>;
	call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], client?: ComputerClient): Promise<DaemonMethods[M]["result"]>;
	ok<T>(result: Result<T>, what: string): T;
	/** Asserts the result is an error, with one of these codes when given. */
	refused(result: Result<unknown>, what: string, codes?: ComputerErrorCode[]): ComputerError;
	equal(actual: unknown, expected: unknown, what: string): void;
	deepEqual(actual: unknown, expected: unknown, what: string): void;
	match(text: string, pattern: RegExp, what: string): void;
	/** Fails the case with what when condition is false. */
	assert(condition: unknown, what: string): void;
	/** The value, or the case fails with what when it is undefined or null. */
	present<T>(value: T | undefined | null, what: string): T;
	/** Calls fn until it returns a value other than undefined or false, for up to ms (default patience). */
	until<T>(fn: () => Promise<T | undefined | false>, what: string, ms?: number): Promise<T>;
	/** Ends the case as a skip, with the reason. */
	skip(reason: string): never;
}

export interface Case {
	/** `<group>.<name>`. */
	id: string;
	level: Level;
	group: CaseGroup;
	needs: Capability[];
	/** "shared" (default): the run's computer; "fresh": one of its own; "none": no computer. */
	computer?: "shared" | "fresh" | "none";
	/** The longest this case may run, when it needs longer than the run's default. */
	timeoutMs?: number;
	run(t: CaseContext): Promise<void>;
}

export interface CaseResult {
	id: string;
	level: Level;
	group: CaseGroup;
	status: "pass" | "fail" | "skip";
	reason?: string;
	/**
	 * On a skip: the needs that were not declared and are optional for this kind of computer. A Core case skipped for
	 * these does not fail Core; any other skip of a Core case does.
	 */
	undeclared?: Capability[];
}

export interface ConformanceReport {
	/** The provider's id. */
	provider: string;
	providerVersion: string;
	/** What the provider declares the computer is, and who answers its methods. */
	kind: ComputerKind;
	daemonMode: DaemonMode;
	image: string;
	/** What the run's computer said in hello; null when no computer could be made. */
	daemon: { version: string; os: string; arch: string } | null;
	/** The groups or case ids the run was limited to, when it was. */
	only?: string[];
	/** When only was given: the Core cases it left out, which did not run. */
	coreNotRun?: string[];
	results: CaseResult[];
	/**
	 * pass when every Core case ran and passed, but those skipped for an optional group the computer does not declare,
	 * and the run left no computer behind. partial when only left Core cases out and every case that ran passed (a Core
	 * case skipped for any other reason is not a pass), with nothing left behind: no Core verdict. fail otherwise.
	 */
	core: "pass" | "partial" | "fail";
	/** What cases needed that the provider or the computer does not declare and its kind does not require. */
	undeclared: Capability[];
	/**
	 * The computers of this run deleted, those still there after it, what went wrong, and the computers a provider gave
	 * after their case had ended (each deleted as it came).
	 */
	cleanup: { deleted: string[]; left: string[]; errors: string[]; late: string[] };
}

export interface ConformanceOptions {
	/** The image every computer of the run starts from. */
	image: string;
	/** Run only these groups or case ids. */
	only?: string[];
	signal?: AbortSignal;
	/** The cases to run; default every case of the suite. */
	cases?: Case[];
	/** The same provider with a daemon that reports another version, for the drift cases. */
	drifted?: () => Promise<ComputerProvider> | ComputerProvider;
	/** Called as each case ends. */
	onResult?: (result: CaseResult) => void;
	/** The longest one case may run; default 180 s. */
	caseTimeoutMs?: number;
	/** How long a case waits on a program; default 30 s. */
	patience?: number;
	/** The longest each cleanup call (release, the sweep, list) may take; default 60 s. */
	cleanupTimeoutMs?: number;
	/**
	 * The fixture on this machine, for the cases that check what input did: computerd-fixture for a desktop, the
	 * fixture APK for an Android phone. Without it those cases skip, and Core cannot pass where kind requires them.
	 */
	fixture?: string;
	/** fetch for screen.stream; default the global one. */
	fetch?: CaseContext["fetch"];
	/** The clock lifetime.extend reads and waits on; default the wall clock. Tests give one their fakes share. */
	clock?: Clock;
}

/** Time as a case reads it: now() in ms since the epoch, and a wait of ms on the same clock. */
export interface Clock {
	now(): number;
	sleep(ms: number): Promise<void>;
}
