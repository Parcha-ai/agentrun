// The conformance suite's shapes: a case is data that names its level, its group and the capabilities it needs.
import type { DaemonClient } from "../client.js";
import type { DaemonCapability, DaemonMethod, DaemonMethods, ExecRunParams, HelloResult } from "../protocol.js";
import type { ComputerConnection, ComputerProvider, ComputerRef, ComputerSpec } from "../provider.js";
import type { ComputerError, ComputerErrorCode, Result } from "../result.js";

/** Core: what every computer must do. Full: an optional capability, tested only where it is declared. */
export type Level = "core" | "full";
export type Group = "health" | "exec" | "files" | "process" | "provider" | "drift";

/**
 * What a case needs: a daemon capability (declared by both the provider's capabilities().daemon and the daemon's
 * hello), a network the provider declares, the janitor as the keeper of deadlines, a spec.user the provider takes, or
 * a release that stops a computer and keeps it.
 */
export type Capability =
	| DaemonCapability
	| "network:none"
	| "network:open"
	| "network:allow"
	| "lifetime:janitor"
	| "user:root"
	| "user:uid"
	| "release:stop";

/** What every computer must declare: a provider without one of these cannot pass Core. */
export const CORE_CAPABILITIES: readonly Capability[] = ["exec", "files", "processes", "network:none"];

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
	/** A connection of the case's own to that computer, after hello. */
	readonly client: DaemonClient;
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
	exec(argv: string[], extra?: Partial<ExecRunParams>, client?: DaemonClient): Promise<Ran>;
	call<M extends DaemonMethod>(method: M, params: DaemonMethods[M]["params"], client?: DaemonClient): Promise<DaemonMethods[M]["result"]>;
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
	group: Group;
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
	group: Group;
	status: "pass" | "fail" | "skip";
	reason?: string;
}

export interface ConformanceReport {
	/** The provider's id. */
	provider: string;
	providerVersion: string;
	image: string;
	/** What the daemon of the run's computer said in hello; null when no computer could be made. */
	daemon: { version: string; arch: string } | null;
	/** The groups or case ids the run was limited to, when it was. */
	only?: string[];
	/** When only was given: the Core cases it left out, which did not run. */
	coreNotRun?: string[];
	results: CaseResult[];
	/**
	 * pass when every Core case ran and passed, and the run left no computer behind. partial when only left Core cases
	 * out and every case that ran passed (a Core case skipped is not a pass), with nothing left behind: no Core verdict.
	 * fail otherwise.
	 */
	core: "pass" | "partial" | "fail";
	/** Capabilities Full cases needed that the provider or the daemon does not declare. */
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
}
