// The machine host: what a vendor writes to put computers on its machines. A host has eleven members: its descriptor
// and its facts, five calls about its own machines (create, get, list, delete, exec), and four optional hooks (upload,
// errorCode, extend, check). HostedProvider (./hosted/provider.ts) owns everything else a ComputerProvider does: the
// spec's check, the daemon's upload, install and start, the stdio bridge, the read-back and the probe, labels, list and
// attach, the deadline and extend, the wait after a delete, the sweep of a lost create, the Archil mount, and the words
// of every refusal. These doc comments are the contract a new vendor reads (PROVIDERS.md, "The eleven members").
import type { ProviderDescriptor } from "./descriptor.js";
import type { ComputerCapabilities, ComputerSpec, GpuSpec, Refusal } from "./provider.js";
import type { ComputerErrorCode } from "./result.js";

/**
 * One vendor's machines. Every call answers its value or throws: a failure whose code the host knows throws a
 * HostError with that code, and any other error is read through errorCode (default "vendor"); an AbortError or a
 * TimeoutError the adapter reads itself. The adapter bounds each call by ctx.timeoutMs and ctx.signal; a host passes
 * both on to its vendor call when it can.
 */
export interface MachineHost {
	/**
	 * The provider's descriptor (./descriptors): its id names the vendor of every error of code vendor, its label is the
	 * vendor in words, and capabilities() and check() read its network forms, mount kinds and unmounted kinds, and its
	 * configuration of the adapter's kind: the groups and GPUs.
	 */
	readonly descriptor: HostDescriptor;
	readonly facts: HostFacts;
	/**
	 * Makes one machine, by its options, and answers its id once the vendor has one. It does not wait for the machine to
	 * run (the adapter polls get while it is starting) or to be listed (the adapter waits for that too), except where the
	 * vendor applies a machine's settings only once it is ready: there it may wait for ready within ctx.timeoutMs, set
	 * them, and answer then (PROVIDERS.md, create). The machine
	 * carries req.name where the vendor can find it again by listing: the vendor's native name, or a label. A native name
	 * the vendor already has throws exists (a REST host's named call: hosted/rest.ts), and the adapter adopts the machine
	 * the name lists, as a retry does. An answer that never comes is not a machine the adapter forgets: it lists by
	 * req.labels and deletes what it finds. A host with facts.labels "machine" keeps neither: req.name is its native
	 * name where it has one (Machine.name), and the adapter writes req.labels into the machine itself.
	 */
	create(req: MachineRequest, ctx: HostCall): Promise<{ id: string }>;
	/** One machine as the vendor reads it now; undefined once the vendor no longer has it (not found is that, or a HostError not_found). */
	get(id: string, ctx: HostCall): Promise<Machine | undefined>;
	/**
	 * The machines of the account the vendor's listing shows for these labels, every page, within ctx.timeoutMs in all.
	 * The listing finds; get answers: the adapter takes only the ids from it and reads each one it keeps by get, for its
	 * state, labels and end, so a listing may be stale (one still showing a deleted machine, or an end from before a
	 * timer moved: E2B's). It may answer more machines than carry all the labels (a vendor that filters by some, or
	 * none): the adapter keeps those whose get does. A listing may lag a create: two creates of one request on two
	 * provider instances can then both make a machine, and the adapter deletes every one but the oldest (createdAt), so
	 * a vendor may see a second create deleted. With facts.labels "machine" it lists by req.name where the vendor lists by
	 * name, else every machine: the adapter keeps those of the name, then reads each one's labels from inside it.
	 */
	list(labels: Record<string, string>, ctx: HostCall): Promise<Machine[]>;
	/**
	 * Deletes a machine; not found is ok. It answers once the vendor took the delete: the adapter then waits until get
	 * answers none, twice running (a machine get reads gone is still going, and holds the wait).
	 */
	delete(id: string, ctx: HostCall): Promise<void>;
	/**
	 * Starts argv in the machine as root (the vendor's own command user when it is root, else one with passwordless
	 * sudo), the vendor's agent's own process, outside the computer's tools, and answers once it has started.
	 *
	 * exec is the whole protocol: the adapter installs and starts its daemon through it, then talks to the daemon over
	 * one exec'd process's stdin and stdout for the computer's whole life (the stdio bridge, spec/computer/stdio.md). So:
	 * - Two-way and live. Each write() reaches the process's stdin as it is written, and stdout and stderr come back as
	 *   the process writes them, while it runs. Not request and response, never held until the process exits.
	 * - Text intact. UTF-8 text both ways, every code point as it was: long lines, \r and \r\n kept (no terminal, no
	 *   newline translation), nothing added or dropped. Everything the adapter sends or reads is text (the bridge's JSON
	 *   lines, its upload in base64), and each write() holds whole characters. An exec that carries bytes carries this.
	 * - No timeout. The process runs until it exits or kill() ends it: a vendor's command timeout, and any idle timeout
	 *   on the stream, are off.
	 * - stdout and stderr stay apart. wait() answers the process's own exit code. kill() ends the process in the
	 *   machine, not only its streams.
	 * end() ends stdin where the vendor can (the adapter calls it at once for a command it gives no input); where it
	 * can't, end() does nothing, and nothing the adapter runs waits for it: its upload and its label file's write read a
	 * length, a root command's input is one line, its bridge ends by kill(). A vendor whose exec comes in pieces (a start, an event stream, a call per write, no end or no kill) builds
	 * this from them with framedExec (./hosted/framed-exec.ts). The exec pre-check (conformance --exec-stream,
	 * src/conformance/exec-stream.ts) checks each of these on a machine made by hand, with exec alone.
	 */
	exec(id: string, argv: readonly string[], ctx: HostCall): Promise<MachineProcess>;
	/**
	 * Puts bytes at path in the machine, as root. Optional: a vendor with no file API leaves it out, and the adapter
	 * streams the file through exec's stdin as base64 text, which root decodes (`base64 -d`, in coreutils and busybox).
	 */
	upload?(id: string, path: string, bytes: Uint8Array, ctx: HostCall): Promise<void>;
	/**
	 * The code of an error the vendor's client threw: one of ComputerErrorCode. Optional: the adapter reads a HostError's
	 * own code, an AbortError as "aborted" and a TimeoutError as "timeout" itself, and anything else a host does not map
	 * is "vendor".
	 */
	errorCode?(error: unknown): ComputerErrorCode;
	/**
	 * Moves the machine's end to endsAt, never past its agentrun.computer.max-deadline label, the most it may live: the
	 * vendor's own timer (facts.lifetime "vendor"), or the janitor's deadline label (facts.lifetime "janitor"). A refusal
	 * (a HostError limit, in words) when no end the vendor takes lands there without moving it earlier than it is or past
	 * the most: nothing moves then. The adapter reads the end back with get (deadlineOf, the deadline label: a vendor that
	 * keeps no label change reads its moved timer as that label), and init's deadline follows it. With facts.labels
	 * "machine", the adapter then moves the deadline label in the machine itself. Optional: a host without it has no extend.
	 */
	extend?(id: string, endsAt: Date, ctx: HostCall): Promise<void>;
	/**
	 * The vendor's own rules of a spec, over the adapter's shared ones: an image name it takes, a GPU's image. No call. The
	 * spec is an object, as the caller gave it: its fields are not checked yet (an image may be a number).
	 */
	check?(spec: Partial<ComputerSpec>): Refusal[];
}

/** A host's failure whose code it knows: thrown by a host member, read by the adapter as that code, in these words. */
export class HostError extends Error {
	readonly code: ComputerErrorCode;
	constructor(code: ComputerErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** Every call's bound: the adapter's timeout for this kind of call, and the caller's signal when it has one. */
export interface HostCall {
	signal?: AbortSignal;
	timeoutMs: number;
}

/**
 * What create asks of the vendor. A size (cpus, memoryMb) is passed whenever the spec gives one: a vendor whose size is
 * its image's refuses it in its own check.
 */
export interface MachineRequest {
	/** computer-<12 hex digits>, from the create's request id: the vendor's native name, or a label it lists by. */
	name: string;
	/** The image or template, as the spec names it (host.check holds it to the vendor's rule). */
	image: string;
	/** The caller's labels and the adapter's own (agentrun.computer*, the Archil mount's), every one to be read back. */
	labels: Record<string, string>;
	/** The spec's lifetime: the vendor's timer (facts.lifetime "vendor"); a janitor's host may leave it. */
	lifetimeMs: number;
	/**
	 * Whether the machine reaches out: true for an Archil computer's root, which reaches Archil, and for a network open
	 * or a list, whose egress proxy init starts outside its tools' network (./hosted/network.ts). Its tools' own network
	 * is init's, loopback alone, read from inside, either way.
	 */
	egress: boolean;
	/** facts.daemon "pid1" alone: the machine's main process (the entrypoint that waits for the daemon, then becomes init). */
	command?: readonly string[];
	/** A GPU computer's GPUs; the adapter records them in a label too, so no vendor reads them back. */
	gpu?: GpuSpec;
	cpus?: number;
	memoryMb?: number;
	/** With facts.user: the spec's user, uid:gid. */
	user?: string;
}

/**
 * One machine as the vendor reads it back. The adapter holds the rest itself: what create asked is in the labels, what
 * runs is read from inside (the daemon's hello and sha256, the network probe).
 */
export interface Machine {
	id: string;
	/** Every label it carries, the adapter's own included; with facts.labels "machine", none (the adapter reads them). */
	labels: Record<string, string>;
	/**
	 * With facts.labels "machine": the vendor's native name, the MachineRequest.name create gave it, where the vendor
	 * keeps one. A machine of a request's name whose labels are not written yet is the request's (provider.md).
	 */
	name?: string;
	/**
	 * starting: not yet running; stopped: there, not running, and not being deleted (paused, asleep): listed, so the
	 * janitor still ends it; gone: being deleted, ended, or failed (why says how).
	 */
	state: "starting" | "running" | "stopped" | "gone";
	/** With facts.lifetime "vendor": when the vendor's timer ends it. */
	endsAt?: Date;
	/**
	 * When the vendor made it, by its clock, where it says. Two creates of one request on two provider instances can each
	 * make a machine before either is listed: the oldest is kept, by this, or by the lowest id where a machine has none.
	 */
	createdAt?: Date;
	/** The vendor's words for a machine that is gone because it failed: a create stops in them. */
	why?: string;
}

/** A process exec started: its output as it comes, its stdin, and its end. */
export interface MachineProcess {
	stdout: AsyncIterable<Uint8Array>;
	stderr: AsyncIterable<Uint8Array>;
	/** Writes UTF-8 text to its stdin, in order, whole characters each; rejects once the process has ended. */
	write(bytes: Uint8Array): Promise<void>;
	/** Ends its stdin, so it reads end of file, where the vendor can; else nothing (exec's doc). */
	end(): Promise<void>;
	/** Its exit code once it has ended. */
	wait(): Promise<number>;
	/** Ends it, best effort, and lets go of its streams; never throws. */
	kill(): Promise<void>;
}

/**
 * What the host reads of its provider's descriptor: its id and label, its network forms and mounts, and its
 * configurations, each kind's groups and GPUs.
 */
export type HostDescriptor = Pick<ProviderDescriptor, "id" | "label" | "network" | "mounts" | "unmounted" | "capabilities">;

/**
 * What a vendor's machines are, static: with its descriptor (network, mounts, each kind's groups and GPUs) and the
 * adapter's options, capabilities() is built from these alone.
 */
export interface HostFacts {
	/**
	 * child: the vendor's agent is the machine's first process and starts init, after the adapter closes the session
	 * buses in /tmp (/tmp/dbus-*) to the computer's user, since a network namespace does not cut a path socket. pid1:
	 * init is the machine's main process (Modal's, whose sandbox ends when it does), started by request.command.
	 */
	daemon: "child" | "pid1";
	isolation: ComputerCapabilities["isolation"];
	/** Who ends a machine at its deadline: the vendor's timer, or the janitor by label. */
	lifetime: "vendor" | "janitor";
	/** The vendor's hard cap of a machine's life; the adapter's maxLifetimeMs may only lower it. */
	maxLifetimeMs: number;
	arch: "amd64" | "arm64";
	/** The TCP ports the vendor's own agent listens on inside the machine (E2B's envd 49983). */
	vendorAgentPorts: number[];
	/** Whether its desktops run WINDOW_MANAGER (xfwm4, which its image has) once the display answers. Default none. */
	windowManager?: boolean;
	/** What spec.user may ask for, beside the daemon user: with it, the spec's user goes in MachineRequest.user. */
	user?: Array<"root" | "uid">;
	/**
	 * The most a machine's labels may be, the adapter's own with the caller's: count, how many; bytes, every name and
	 * value together, the adapter's at their longest. Past either, check() refuses, and so create, before any host call.
	 * Absent: no bound. packed: the host stores the labels as packLabels packs them (./hosted/values.ts: one name to
	 * list by, the map in parts of at most valueBytes each) and get answers unpackLabels' map; count and bytes are then
	 * the packed labels'. "machine": the vendor keeps no labels, so the adapter writes them as JSON to a root-only file in
	 * the machine (LABEL_FILE, ./hosted/scripts.ts) right after it runs, and reads them back from it: at most 64 KiB as
	 * JSON, what a run's output keeps (OUTPUT_MAX, ./hosted/process.ts). Only with
	 * lifetime "vendor": a machine whose labels were never written is ended by the vendor's timer alone.
	 */
	labels?: { count?: number; bytes?: number; packed?: { valueBytes?: number } } | "machine";
	/**
	 * Paths of the vendor's image that root runs or reads and whose permissions its template build sets wider than
	 * root's: create makes each root's alone (owned by root, writable by no group or other user), and everything under a
	 * directory, before the daemon's upload, so the computer's user can change nothing root runs. Default none.
	 */
	rootOnly?: readonly string[];
}
