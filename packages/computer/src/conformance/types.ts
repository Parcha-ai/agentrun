// The conformance suite's shapes: a case is data that names its level, its group and the capabilities it needs.
import type { MountKind, MountSpec } from "../mount.js";
import type { ComputerClient, ComputerKind, ComputerOs, DaemonMethod, DaemonMethods, ExecRunParams, Group, HelloResult } from "../protocol.js";
import type { ComputerConnection, ComputerProvider, ComputerRef, ComputerSpec, DaemonMode } from "../provider.js";
import type { ComputerError, ComputerErrorCode, Result } from "../result.js";
import type { ComputerSettingKind } from "../kinds.js";
import type { CdpDialer, CdpSocket } from "./cdp.js";
import type { StartedFixture } from "./fixture.js";
import type { KindVerdict } from "./kind.js";

/** Core: what a computer of its kind must do. Full: an optional capability, tested only where it is declared. */
export type Level = "core" | "full";
/** The suite's own grouping of its cases, the first part of each case id; not the protocol's Group. */
export type CaseGroup = "health" | "exec" | "files" | "process" | "provider" | "drift" | "isolation" | "mount" | "screen" | "input" | "touch" | "apps" | "lifetime" | "browser";

/**
 * What a case needs: a group (declared by both the provider's capabilities().groups and the computer's hello), a
 * network the provider declares, the janitor as the keeper of deadlines, a spec.user the provider takes, a release that
 * stops a computer and keeps it, a mount kind capabilities().mount declares, a provider method that is optional
 * (extend, stream), declared by being there, or the ports of a vendor's agent in the computer (vendor-agent: declared
 * by capabilities().vendorAgentPorts, an empty list included).
 */
export type Capability =
	| Group
	| "network:none"
	| "network:open"
	| "network:allow"
	| "lifetime:janitor"
	| "user:root"
	| "user:uid"
	| "release:stop"
	| "mount:bind"
	| "mount:archil"
	| "extend"
	| "stream"
	| "vendor-agent";

/**
 * A fresh run's folder for one mount kind, made by the provider's conformance module: the mount that reaches it, and its
 * outside, where a computer does not run (the folder on the host for a bind, the disk's file API for Archil).
 */
export interface RunFolder {
	mount: MountSpec;
	/** The run whose folder it is, for a mount made for a run (Archil: agents/<agent>/runs/<run>/work): a computer that
	 *  mounts it is labelled agentrun.run with it. */
	run?: string;
	/** A file of the folder, by its path relative to the folder, read from outside; undefined when there is none. */
	read(path: string): Promise<Uint8Array | undefined>;
	/** Writes a file of the folder from outside, by its path relative to the folder. */
	write(path: string, data: Uint8Array): Promise<void>;
	/** Removes the folder and what is in it; the runner calls it when the case ends. */
	close(): Promise<void>;
}

/**
 * What a computer of this kind and daemon mode must declare: a case that needs one of these fails Core when it is
 * missing, where a case that needs an undeclared optional group is skipped. exec, files and processes are Core whenever
 * computerd runs (pid1 or child); with daemon none they are tested only when declared. Network none is Core wherever
 * computerd runs; a phone is tested on an open network. A child daemon runs beside the vendor's own agent, so it must
 * declare that agent's ports (vendor-agent), and isolation.vendor-agent checks its programs reach none of them. A
 * browser must declare its CDP target.
 */
export function coreGroups(kind: ComputerKind, daemon: DaemonMode): Capability[] {
	const computerd: Capability[] = daemon === "none" ? [] : ["exec", "files", "processes", "network:none", ...(daemon === "child" ? (["vendor-agent"] as const) : [])];
	switch (kind) {
		case "linux":
			return computerd;
		case "desktop":
			return [...computerd, "screen", "input.pointer", "input.keys"];
		case "android":
		case "ios":
			return ["screen", "input.touch"];
		case "browser":
			return ["cdp"];
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
	/** A fresh run's folder for this mount kind, closed when the case ends; skips the case when the run can make none. */
	runFolder(kind: MountKind): Promise<RunFolder>;
	/**
	 * Starts the run's fixture in the case's computer and waits until it is up: an app that logs each input event it
	 * gets, so a case checks what an action did with no model. It is stopped when the case ends. Skips the case when the
	 * run was given no fixture, or none can start on this kind of computer.
	 */
	fixture(): Promise<StartedFixture>;
	/** fetch, as the run was given it; the global one by default. */
	fetch(url: string, init?: { signal?: AbortSignal; method?: string }): Promise<{ status: number }>;
	/** A CDP socket to a browser's CDP URL, through the run's dialer, closed when the case ends. */
	cdp(url: string): Promise<CdpSocket>;
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
	/** Records what the case saw without asserting it (its result's observed), for a fact not yet known either way. */
	observe(words: string): void;
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
	/**
	 * The systems the case's body is written for. Absent: any, but a case that needs exec or processes runs POSIX
	 * programs (sh, id, /proc) and is Linux's alone, and one that needs files names POSIX paths (/tmp) and is no Windows
	 * computer's (caseOs). A computer of another os skips it in words.
	 */
	os?: readonly ComputerOs[];
	run(t: CaseContext): Promise<void>;
}

/** The systems a case runs on: its own os; else Linux alone for one that runs programs, any but Windows for one that names paths. */
export function caseOs(c: Pick<Case, "os" | "needs">): readonly ComputerOs[] | undefined {
	if (c.os !== undefined) return c.os;
	if (c.needs.some((need) => need === "exec" || need === "processes")) return ["linux"];
	if (c.needs.includes("files")) return ["linux", "macos", "android", "ios"];
	return undefined;
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
	/** What the case saw and recorded without asserting it (CaseContext.observe); absent when nothing. */
	observed?: string[];
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
	/** When only or kind was given: the Core cases it left out, which did not run. */
	coreNotRun?: string[];
	/** When the run was by kind: whether the provider passes it, and why not. */
	kindVerdict?: KindVerdict;
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
	/** What the provider module says of its configuration, for whoever reads the report; absent when it says nothing. */
	notes?: string[];
	/**
	 * What create's read-back recorded of each computer the run made that does not refuse it (a probe target that
	 * accepted and sent nothing back), one entry per note, naming the computer, in the order they came; absent when none.
	 */
	computerNotes?: ComputerNote[];
	/**
	 * What the provider said through its onNote option during the run (a release that did not let an Archil folder go
	 * cleanly), naming the computer, in the order it came: no failure of any case. The CLI gives the option and fills
	 * this; absent when nothing was said.
	 */
	providerNotes?: ComputerNote[];
}

/** One note a create returned: the computer's name and the note's words. */
export interface ComputerNote {
	computer: string;
	note: string;
}

export interface ConformanceOptions {
	/** The image every computer of the run starts from. */
	image: string;
	/** Run only these groups or case ids. */
	only?: string[];
	/**
	 * Run a setting kind's cases (kindCases) and give its verdict (report.kindVerdict); not with only. Kind none, no
	 * computer, is refused, in words.
	 */
	kind?: ComputerSettingKind;
	signal?: AbortSignal;
	/** The cases to run; default casesFor the provider's machine kind: a browser's own cases, else every case of the suite. */
	cases?: Case[];
	/** The same provider with a daemon that reports another version, for the drift cases. */
	drifted?: () => Promise<ComputerProvider> | ComputerProvider;
	/**
	 * A fresh run's folder for a mount kind, for the mount cases: the provider's conformance module makes it (a folder on
	 * the Docker host for a bind), or gives undefined for a kind it cannot make. Without it, those cases skip in words.
	 */
	mountFor?: (kind: MountKind) => Promise<RunFolder | undefined> | RunFolder | undefined;
	/** Called as each case ends. */
	onResult?: (result: CaseResult) => void;
	/** Notes the provider module gives for the report, printed before the verdict. */
	notes?: string[];
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
	/** How the browser cases open a CDP socket; default a WebSocket (dialCdp). Tests give a fake browser's. */
	cdp?: CdpDialer;
	/** The clock lifetime.extend reads and waits on; default the wall clock. Tests give one their fakes share. */
	clock?: Clock;
}

/** Time as a case reads it: now() in ms since the epoch, and a wait of ms on the same clock. */
export interface Clock {
	now(): number;
	sleep(ms: number): Promise<void>;
}
