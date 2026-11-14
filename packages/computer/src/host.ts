// The machine host: what a vendor writes to put computers on its machines. A vendor answers seven calls about its own
// machines (create, get, list, delete, exec, errorCode, and its static facts); hostedProvider (./hosted/provider.ts)
// owns everything else a ComputerProvider does: the spec's check, the daemon's upload, install and start, the stdio
// bridge, the read-back and the probe, labels, list and attach, the deadline and extend, the waits after a delete and a
// stop, the sweep of a lost create, the Archil mount, and the words of every refusal. These doc comments are the
// contract a new vendor reads (PROVIDERS.md, "The eight members").
import type { MountKind, Unmounted } from "./mount.js";
import type { ComputerCapabilities, ComputerSpec, GpuCapability, GpuSpec, NetworkForm, NetworkPolicy, Refusal } from "./provider.js";
import type { ComputerErrorCode, Result } from "./result.js";

/**
 * One vendor's machines. Every call answers a Result: an expected failure (the vendor refused, the machine is not
 * there) is a result with a code from errorCode, never a throw. A call that throws is read through errorCode as well.
 * The adapter bounds each call by ctx.timeoutMs and ctx.signal; a host passes both on to its vendor call when it can.
 */
export interface MachineHost {
	/** The provider's descriptor id ("e2b"): the vendor named by every error of code vendor. */
	readonly id: string;
	readonly facts: HostFacts;
	/**
	 * Makes one machine, by its options, and answers once the vendor has its id. It does not wait for the machine to run
	 * (the adapter polls get while it is starting) or to be listed (the adapter waits for that too). The machine carries
	 * req.name where the vendor can find it again by listing: the vendor's native name, or a label. An answer that never
	 * comes is not a machine the adapter forgets: it lists by req.labels and deletes what it finds.
	 */
	create(req: MachineRequest, ctx: HostCall): Promise<Result<{ id: string }>>;
	/** One machine as the vendor reads it now; undefined once the vendor no longer has it (not found is that, not an error). */
	get(id: string, ctx: HostCall): Promise<Result<Machine | undefined>>;
	/**
	 * The machines of the account the vendor's listing shows for these labels, every page, within ctx.timeoutMs in all,
	 * each as the listing reads it: a field it leaves out (the network, drift) is absent, and the adapter reads get where
	 * it needs one. It may answer more machines than carry all the labels (a vendor that filters by some, or none): the
	 * adapter keeps those that do. A machine the vendor is deleting may still be listed; one it no longer has is not.
	 */
	list(labels: Record<string, string>, ctx: HostCall): Promise<Result<Machine[]>>;
	/** Deletes a machine; not found is ok. It answers once the vendor took the delete: the adapter waits for gone. */
	delete(id: string, ctx: HostCall): Promise<Result<void>>;
	/**
	 * Starts argv in the machine as root (the vendor's own command user when it is root, else one with passwordless
	 * sudo), the vendor's agent's own process, outside the computer's tools, and answers once it has started.
	 *
	 * exec is the whole protocol: the adapter installs and starts its daemon through it, then talks to the daemon over
	 * one exec'd process's stdin and stdout for the computer's whole life (the stdio bridge, spec/computer/stdio.md). So:
	 * - Two-way and live. Each write() reaches the process's stdin as it is written, and stdout and stderr bytes come
	 *   back as the process writes them, while it runs. Not request and response, never held until the process exits.
	 * - Byte-exact. Every byte value 0-255, both ways: no UTF-8 decode or encode, no newline translation, no terminal,
	 *   nothing added or dropped. A client that hands output over as text breaks this (E2B's commands.run does).
	 * - No timeout. The process runs until it exits or kill() ends it: a vendor's command timeout, and any idle timeout
	 *   on the stream, are off.
	 * - stdout and stderr stay apart. wait() answers the process's own exit code. kill() ends the process itself.
	 * With opts.stdin, the process reads what write() gives until end(). The exec pre-check (conformance --exec-stream,
	 * src/conformance/exec-stream.ts) checks each of these on a machine made by hand, with exec alone.
	 */
	exec(id: string, argv: readonly string[], opts: { stdin: boolean }, ctx: HostCall): Promise<Result<MachineProcess>>;
	/**
	 * Puts bytes at path in the machine, as root. Optional: a vendor with no file API leaves it out, and the adapter
	 * streams the file through exec's stdin.
	 */
	upload?(id: string, path: string, bytes: Uint8Array, ctx: HostCall): Promise<Result<void>>;
	/**
	 * The code of an error the vendor's client threw: one of ComputerErrorCode. Optional: the adapter reads an
	 * AbortError as "aborted" and a TimeoutError as "timeout" itself, and anything else a host does not map is "vendor".
	 */
	errorCode?(error: unknown): ComputerErrorCode;
	/** Vendor settings a machine takes once it runs and before the daemon goes in (egress rules, an idle timer). */
	prepare?(id: string, ctx: HostCall): Promise<Result<void>>;
	/**
	 * Asks the vendor to stop a machine, keeping it; declared with facts.release "stop". It answers once the vendor took
	 * the ask: the adapter waits until get and the listing read it stopped (gone, where a stop deletes it), and asks again
	 * while it reads running.
	 */
	stop?(id: string, ctx: HostCall): Promise<Result<void>>;
	/**
	 * Moves the vendor's own timer (facts.lifetime "vendor") so the machine ends at want.end, never past want.most, the
	 * most it may live. A refusal (limit, in words) when no timer the vendor takes lands there without moving the end
	 * earlier than it is or past want.most: nothing moves then. The adapter reads the end back with get.
	 */
	setTimer?(id: string, want: { end: Date; most: Date }, ctx: HostCall): Promise<Result<void>>;
	/** Replaces some labels of a machine (the janitor's deadline label, at extend); facts.lifetime "janitor". */
	setLabels?(id: string, labels: Record<string, string>, ctx: HostCall): Promise<Result<void>>;
	/**
	 * The vendor's own rules of a spec, over the adapter's shared ones: an image name it takes, a GPU's image. No call. The
	 * spec is an object, as the caller gave it: its fields are not checked yet (an image may be a number).
	 */
	check?(spec: Partial<ComputerSpec>): Refusal[];
	/** Settings' test, where a list would make something (an app); default: one list by the adapter's label, counted. */
	testConnection?(ctx: HostCall): Promise<Result<{ detail: string }>>;
}

/** Every call's bound: the adapter's timeout for this kind of call, and the caller's signal when it has one. */
export interface HostCall {
	signal?: AbortSignal;
	timeoutMs: number;
}

/** What create asks of the vendor: the adapter fills every field but the ones facts.specFields leaves out. */
export interface MachineRequest {
	/** computer-<12 hex digits>, from the create's request id: the vendor's native name, or a label it lists by. */
	name: string;
	/** The image or template, as the spec names it (host.check holds it to the vendor's rule). */
	image: string;
	/** The caller's labels and the adapter's own (agentrun.computer*, the Archil mount's), every one to be read back. */
	labels: Record<string, string>;
	/** With facts.lifetime "vendor": the vendor's timer, the spec's lifetime. Absent for a janitor's machine. */
	lifetimeMs?: number;
	/**
	 * The vendor's network for the machine: "open" only for an Archil computer's root, which reaches Archil; its tools'
	 * network is init's own, none, read from inside.
	 */
	network: "none" | "open";
	/** facts.daemon "pid1" alone: the machine's main process (the entrypoint that waits for the daemon, then becomes init). */
	command?: readonly string[];
	gpu?: GpuSpec;
	cpus?: number;
	memoryMb?: number;
	workdir?: string;
	user?: string;
}

/** One machine as the vendor reads it back. */
export interface Machine {
	id: string;
	/** Every label it carries, the adapter's own included. */
	labels: Record<string, string>;
	/** starting: not yet running; stopping: on its way to stopped; going: being deleted or ended; failed: the vendor gave up on it (why says how). */
	state: "starting" | "running" | "stopping" | "stopped" | "going" | "failed";
	/** The vendor's own read of its network; absent when the vendor reads none back (the probe stands for it then). */
	network?: NetworkPolicy;
	/** What the vendor resolved the image to, by its own name (a template's id, a snapshot). */
	image?: { resolved?: string };
	/**
	 * When the vendor made it, by its clock, where it says. Two creates of one request on two provider instances can each
	 * make a machine before either is listed: the oldest is kept, by this, or by the lowest id where a machine has none.
	 */
	createdAt?: Date;
	/** With facts.lifetime "vendor": when the vendor's timer ends it. */
	endsAt?: Date;
	/**
	 * With facts.lifetime "vendor": the vendor's timer was moved past where create set it (by an extend), so endsAt,
	 * held to the most the machine may live, stands for its deadline: the vendor keeps no label change.
	 */
	timerMoved?: boolean;
	/**
	 * The vendor's own create options read back wrong, in words, one each ("lifecycle onTimeout: declared ..."). Held at
	 * create and at attach alike, so only what holds for the machine's whole life: a timer an extend moved is timerMoved,
	 * never drift (create refuses a machine whose timer reads moved before any extend).
	 */
	drift?: string[];
	/** The size the vendor reads back, in CPUs and MiB: attach reports it. */
	size?: { cpus?: number; memoryMb?: number };
	gpu?: GpuSpec;
	/** The vendor's words for a failed state. */
	why?: string;
}

/** A process exec started: its output as it comes, its stdin, and its end. */
export interface MachineProcess {
	stdout: AsyncIterable<Uint8Array>;
	stderr: AsyncIterable<Uint8Array>;
	/** Writes to its stdin, in order; rejects once the process has ended. */
	write(bytes: Uint8Array): Promise<void>;
	/** Ends its stdin, so it reads end of file. */
	end(): Promise<void>;
	/** Its exit code once it has ended. */
	wait(): Promise<number>;
	/** Ends it, best effort, and lets go of its streams; never throws. */
	kill(): Promise<void>;
}

/** What a vendor's machines are, static: with the adapter's options, capabilities() is built from these alone. */
export interface HostFacts {
	/** child: the vendor's agent is the machine's first process and starts init; pid1: init is the machine's main process. */
	daemon: "child" | "pid1";
	isolation: ComputerCapabilities["isolation"];
	/** Who ends a machine at its deadline: the vendor's timer, or the janitor by label. */
	lifetime: "vendor" | "janitor";
	/** The vendor's hard cap of a machine's life; the adapter's maxLifetimeMs may only lower it. */
	maxLifetimeMs: number;
	arch: "amd64" | "arm64";
	/** The TCP ports the vendor's own agent listens on inside the machine (E2B's envd 49983). */
	vendorAgentPorts: number[];
	/**
	 * The vendor's own path unix sockets outside /run, as shell patterns with no space (Daytona's D-Bus session bus,
	 * /tmp/dbus-*). Init takes others' access off every socket under /run itself; a child host's create does the same
	 * for each socket these name, as root, before init starts, since a network namespace does not cut a path socket.
	 */
	vendorSockets?: string[];
	/** Whether get reads the network back from the vendor. */
	networkReadBack: boolean;
	/**
	 * Whether get reads a machine's GPUs back from the vendor (Machine.gpu, absent for a machine with none): a retry of a
	 * request is held to them only then. A vendor that reads none back (Modal) answers the request's computer as made.
	 */
	gpuReadBack?: boolean;
	/** The network forms its computers take: of its descriptor's. */
	network: NetworkForm[];
	/** The mount kinds it takes: of its descriptor's. */
	mounts?: MountKind[];
	/** Why it takes none of these mount kinds, each in check()'s words: of its descriptor's. */
	unmounted?: Unmounted;
	/** How release may end one; "stop" needs host.stop. */
	release: Array<"stop" | "delete">;
	stopDeletes?: boolean;
	gpu?: GpuCapability;
	/** What spec.user may ask for, beside the daemon user. */
	user?: Array<"root" | "uid">;
	/** The spec's size and place fields the vendor takes, passed in MachineRequest; any other is refused. */
	specFields?: Array<"cpus" | "memoryMb" | "workdir" | "user">;
	/** The vendor's label rules: how many labels a machine takes, and the names it takes. */
	labelRules?: { max?: number; key?: RegExp };
	/** The runtime a machine of this request runs: "gvisor" only where the vendor runs one (a pid1 host's GPU). */
	runtime?(req: MachineRequest): "vm" | "gvisor";
}
