// A desktop on an X server computerd starts itself: the provider gives init DISPLAY, then starts the X server through
// the daemon with process.start, as any program, so the server is in init's process table and ends with the computer.
// The daemon reaches the display once it answers, and hello declares screen, input.pointer, input.keys and apps from then
// on (hello re-checks the display on each call). A window manager, when the desktop has one, comes next: computerd starts
// it itself when init was asked to (init --window-manager; see daemon/internal/windowmanager), and create waits on
// hello's windowManager until it runs.
// Docker's desktops, E2B's, Agent37's and Daytona's start the display this way.
import { setTimeout as sleep } from "node:timers/promises";
import type { ComputerClient } from "./protocol.js";
import { fail, ok, type Result, vendorFail } from "./result.js";

export interface DesktopOptions {
	/** The display the daemon and the X server use, given to the daemon as DISPLAY. Default ":0". */
	display?: string;
	/** The X server's argv, run in the computer as its user. Default Xvfb on the display, 1280x800 at 24 bits, no TCP. */
	server?: readonly string[];
	/** How long create waits for the display to answer after starting the server. Default 30 s. */
	timeoutMs?: number;
}

/** The groups a desktop declares besides exec, files and processes: apps is computerd's, from the desktop's .desktop files. */
export const DESKTOP_GROUPS = ["screen", "input.pointer", "input.keys", "apps"] as const;

const DISPLAY = /^:\d{1,5}(\.\d{1,5})?$/;
/** How often create asks the daemon whether the display is up yet. */
const DISPLAY_POLL_MS = 100;
/** The longest create waits on the window manager computerd starts, apart from the display's own timeoutMs. */
const WM_BOUND_MS = 15_000;
/** The longest a Node timer or AbortSignal.timeout holds. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The desktop options with their defaults, or a throw in words. */
export function desktopOf({ display = ":0", server, timeoutMs = 30_000 }: DesktopOptions): Required<DesktopOptions> {
	if (typeof display !== "string" || !DISPLAY.test(display)) throw new Error(`the desktop's display ${JSON.stringify(display)} must be a local X display, such as :0`);
	const argv = server ?? ["Xvfb", display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"];
	const program = (list: unknown) => Array.isArray(list) && list.length > 0 && list.every((arg) => typeof arg === "string" && !arg.includes("\0")) && list[0] !== "";
	if (!program(argv)) throw new Error("the desktop's server must be a program and its arguments, such as [\"Xvfb\", \":0\"]");
	// AbortSignal.timeout and Node's timers hold at most 2^31 - 1 ms (a longer one throws or fires at once), so a longer
	// bound is refused here, before any computer exists, not in create after the computer is made.
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
		throw new Error(`the desktop's timeoutMs must be a whole number of milliseconds above 0 and at most ${MAX_TIMER_MS}, not ${timeoutMs}`);
	}
	return { display, server: [...argv], timeoutMs };
}

/**
 * Starts the desktop's X server through the daemon (process.start) and waits until hello declares the display: the
 * server ending first, or the bound passing, is a failure in words, with the server's own last words, as the vendor's
 * (code vendor, vendor the provider's id). version is the client's, sent with each hello. Once the display answers, a
 * hello with windowManager (computerd was asked to start it) is waited on until the manager runs.
 */
export async function startDisplay(
	client: ComputerClient,
	desktop: Required<DesktopOptions>,
	{ version, vendor, signal }: { version: string; vendor: string; signal?: AbortSignal | undefined },
): Promise<Result<void>> {
	const server = desktop.server.join(" ");
	// Every call takes a signal that ends at the bound, so a hello the X connection setup holds, or a daemon that stops
	// answering, cannot outwait it. A call that failed because the bound passed is the timeout; the caller's own abort
	// stays aborted.
	const bound = AbortSignal.timeout(desktop.timeoutMs);
	const either = signal ? AbortSignal.any([signal, bound]) : bound;
	const late = () => fail("timeout", `the display ${desktop.display} was not up within ${desktop.timeoutMs / 1000} s of starting the X server (${server})`);
	const timedOut = () => bound.aborted && !signal?.aborted;
	const started = await client.call("process.start", { argv: [...desktop.server] }, { signal: either });
	if (!started.ok) return timedOut() ? late() : fail(started.error.code, `the X server (${server}) did not start: ${started.error.message}`);
	const { id } = started.value;
	for (;;) {
		const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${version}` }, { signal: either });
		if (!hello.ok) return timedOut() ? late() : hello;
		if (Array.isArray(hello.value.groups) && hello.value.groups.includes("screen")) {
			return hello.value.windowManager ? await awaitWindowManager(client, desktop, { version, vendor, caller: signal }) : ok(undefined);
		}
		const waited = await client.call("process.wait", { id, timeoutMs: 0 }, { signal: either });
		if (waited.ok && !waited.value.running) {
			const read = await client.call("process.read", { id, stream: "stderr", offset: 0 }, { signal: either });
			const words = read.ok ? Buffer.from(read.value.data, "base64").toString("utf8").trim().split("\n").slice(-5).join("; ") : "";
			const how = waited.value.signal ? `signal ${waited.value.signal}` : `exit code ${waited.value.exitCode}`;
			return vendorFail(vendor, `the X server (${server}) ended with ${how} before the display ${desktop.display} was up${words ? `: ${words}` : ""}`);
		}
		if (timedOut()) return late();
		if (signal?.aborted) return fail("aborted", "create was aborted while the display came up");
		await sleep(DISPLAY_POLL_MS, undefined, { signal: either }).catch(() => undefined);
		if (signal?.aborted) return fail("aborted", "create was aborted while the display came up");
	}
}

/**
 * Waits on the window manager computerd starts itself (hello's windowManager, init --window-manager) until hello says it
 * runs: one that ended fails create in computerd's words, its last lines among them. The bound is WM_BOUND_MS; the
 * caller's abort still ends it.
 */
async function awaitWindowManager(
	client: ComputerClient,
	desktop: Required<DesktopOptions>,
	{ version, vendor, caller }: { version: string; vendor: string; caller: AbortSignal | undefined },
): Promise<Result<void>> {
	const bound = AbortSignal.timeout(WM_BOUND_MS);
	const signal = caller ? AbortSignal.any([caller, bound]) : bound;
	const stopped = () =>
		caller?.aborted
			? fail("aborted", "create was aborted while the window manager started")
			: fail("timeout", `the window manager computerd starts did not run on ${desktop.display} within ${WM_BOUND_MS / 1000} s`);
	for (;;) {
		const hello = await client.call("hello", { client: `@parcha/agentrun-computer ${version}` }, { signal });
		if (!hello.ok) return signal.aborted ? stopped() : fail(hello.error.code, `hello, while the window manager computerd starts came up on ${desktop.display}: ${hello.error.message}`);
		const fact = hello.value.windowManager;
		if (fact?.state === "running") return ok(undefined);
		if (fact?.state === "ended") return vendorFail(vendor, fact.why ?? `the window manager computerd starts ended on ${desktop.display}`);
		await sleep(DISPLAY_POLL_MS, undefined, { signal }).catch(() => undefined);
		if (signal.aborted) return stopped();
	}
}
