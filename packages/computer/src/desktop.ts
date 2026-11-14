// A desktop on an X server computerd starts itself: the provider gives init DISPLAY, then starts the X server through
// the daemon with process.start, as any program, so the server is in init's process table and ends with the computer.
// The daemon reaches the display once it answers, and hello declares screen, input.pointer, input.keys and apps from then
// on (hello re-checks the display on each call). A window manager, when the desktop has one, starts next, the same way.
// Docker's desktops, E2B's and Agent37's start the display this way.
import { setTimeout as sleep } from "node:timers/promises";
import type { ComputerClient } from "./protocol.js";
import { type ComputerErrorCode, fail, ok, type Result, vendorFail } from "./result.js";

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

/**
 * The window manager a host's desktops run where its facts say so (HostFacts.windowManager: E2B's and Agent37's), once
 * the display answers: it frames, stacks and focuses the windows apps.launch opens. xfwm4, which both images have, with
 * no compositor and no session manager, in a session bus of its own (dbus-run-session), where it reads its settings
 * from xfconfd: without one it exits at once, "Xfconf could not be initialized".
 */
export const WINDOW_MANAGER: readonly string[] = ["dbus-run-session", "--", "xfwm4", "--compositor=off", "--sm-client-disable"];

const DISPLAY = /^:\d{1,5}(\.\d{1,5})?$/;
/** How often create asks the daemon whether the display is up yet. */
const DISPLAY_POLL_MS = 100;
/** How long create watches a window manager it started: one that ends within it (it could not take the display) fails create. */
const WM_SETTLE_MS = 1_000;
/** The longest create gives a window manager's start and that watch, apart from the display's own timeoutMs. */
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
 * (code vendor, vendor the provider's id). version is the client's, sent with each hello. windowManager: the host's
 * desktops run WINDOW_MANAGER (HostFacts.windowManager), started once the display answers.
 */
export async function startDisplay(
	client: ComputerClient,
	desktop: Required<DesktopOptions>,
	{ version, vendor, signal, windowManager = false }: { version: string; vendor: string; signal?: AbortSignal | undefined; windowManager?: boolean },
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
		if (Array.isArray(hello.value.groups) && hello.value.groups.includes("screen")) return windowManager ? await startWindowManager(client, desktop, vendor, signal) : ok(undefined);
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
 * Starts WINDOW_MANAGER on the display that answers. A manager that cannot start, or ends
 * within WM_SETTLE_MS (xfwm4 with no session bus, or no display it may open), fails create with its last words. It has
 * its own bound, WM_BOUND_MS, not what is left of the display's: a display that came up late still gets its manager's
 * full second. The caller's abort still ends it.
 */
async function startWindowManager(
	client: ComputerClient,
	desktop: Required<DesktopOptions>,
	vendor: string,
	caller: AbortSignal | undefined,
): Promise<Result<void>> {
	const manager = WINDOW_MANAGER.join(" ");
	const bound = AbortSignal.timeout(WM_BOUND_MS);
	const signal = caller ? AbortSignal.any([caller, bound]) : bound;
	const stopped = (code: ComputerErrorCode, message: string) =>
		caller?.aborted
			? fail("aborted", "create was aborted while the window manager started")
			: bound.aborted
				? fail("timeout", `the window manager (${manager}) did not start on ${desktop.display} within ${WM_BOUND_MS / 1000} s`)
				: fail(code, message);
	// NO_AT_BRIDGE: GTK (xfwm4's toolkit) asks its session bus for no accessibility bus. On E2B Desktop, which has
	// at-spi2-core, that bus is an at-spi-bus-launcher and a socket of the user's under its home (~/.cache/at-spi/bus_0).
	const env = { DISPLAY: desktop.display, NO_AT_BRIDGE: "1" };
	const started = await client.call("process.start", { argv: [...WINDOW_MANAGER], env }, { signal });
	if (!started.ok) return stopped(started.error.code, `the window manager (${manager}) did not start on ${desktop.display}: ${started.error.message}`);
	const { id } = started.value;
	const waited = await client.call("process.wait", { id, timeoutMs: WM_SETTLE_MS }, { signal });
	if (!waited.ok) return stopped(waited.error.code, `the window manager (${manager}) could not be waited on: ${waited.error.message}`);
	if (waited.value.running) return ok(undefined);
	const read = await client.call("process.read", { id, stream: "stderr", offset: 0 }, { signal });
	const words = read.ok ? Buffer.from(read.value.data, "base64").toString("utf8").trim().split("\n").slice(-5).join("; ") : "";
	const how = waited.value.signal ? `signal ${waited.value.signal}` : `exit code ${waited.value.exitCode}`;
	return vendorFail(vendor, `the window manager (${manager}) ended with ${how} within ${WM_SETTLE_MS / 1000} s of starting on ${desktop.display}${words ? `: ${words}` : ""}`);
}
