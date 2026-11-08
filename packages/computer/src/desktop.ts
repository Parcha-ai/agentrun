// A desktop on an X server computerd starts itself: the provider gives init DISPLAY, then starts the X server through
// the daemon with process.start, as any program, so the server is in init's process table and ends with the computer.
// The daemon reaches the display once it answers, and hello declares screen, input.pointer and input.keys from then on
// (hello re-checks the display on each call). Docker's desktops and E2B's start the display this way.
import { setTimeout as sleep } from "node:timers/promises";
import type { ComputerClient } from "./protocol.js";
import { type ComputerErrorCode, fail, ok, type Result } from "./result.js";

export interface DesktopOptions {
	/** The display the daemon and the X server use, given to the daemon as DISPLAY. Default ":0". */
	display?: string;
	/** The X server's argv, run in the computer as its user. Default Xvfb on the display, 1280x800 at 24 bits, no TCP. */
	server?: readonly string[];
	/** How long create waits for the display to answer after starting the server. Default 30 s. */
	timeoutMs?: number;
}

/** The groups a desktop declares besides exec, files and processes. */
export const DESKTOP_GROUPS = ["screen", "input.pointer", "input.keys"] as const;

const DISPLAY = /^:\d{1,5}(\.\d{1,5})?$/;
/** How often create asks the daemon whether the display is up yet. */
const DISPLAY_POLL_MS = 100;
/** The longest a Node timer or AbortSignal.timeout holds. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The desktop options with their defaults, or a throw in words. */
export function desktopOf({ display = ":0", server, timeoutMs = 30_000 }: DesktopOptions): Required<DesktopOptions> {
	if (typeof display !== "string" || !DISPLAY.test(display)) throw new Error(`the desktop's display ${JSON.stringify(display)} must be a local X display, such as :0`);
	const argv = server ?? ["Xvfb", display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"];
	if (!Array.isArray(argv) || argv.length === 0 || !argv.every((arg) => typeof arg === "string" && !arg.includes("\0")) || argv[0] === "") {
		throw new Error("the desktop's server must be a program and its arguments, such as [\"Xvfb\", \":0\"]");
	}
	// AbortSignal.timeout and Node's timers hold at most 2^31 - 1 ms (a longer one throws or fires at once), so a longer
	// bound is refused here, before any computer exists, not in create after the computer is made.
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
		throw new Error(`the desktop's timeoutMs must be a whole number of milliseconds above 0 and at most ${MAX_TIMER_MS}, not ${timeoutMs}`);
	}
	return { display, server: [...argv], timeoutMs };
}

/**
 * Starts the desktop's X server through the daemon (process.start) and waits until hello declares the display: the
 * server ending first, or the bound passing, is a failure in words, with the server's own last words, under the
 * vendor's code. version is the client's, sent with each hello.
 */
export async function startDisplay(
	client: ComputerClient,
	desktop: Required<DesktopOptions>,
	{ version, vendor, signal }: { version: string; vendor: ComputerErrorCode; signal?: AbortSignal | undefined },
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
		if (Array.isArray(hello.value.groups) && hello.value.groups.includes("screen")) return ok(undefined);
		const waited = await client.call("process.wait", { id, timeoutMs: 0 }, { signal: either });
		if (waited.ok && !waited.value.running) {
			const read = await client.call("process.read", { id, stream: "stderr", offset: 0 }, { signal: either });
			const words = read.ok ? Buffer.from(read.value.data, "base64").toString("utf8").trim().split("\n").slice(-5).join("; ") : "";
			const how = waited.value.signal ? `signal ${waited.value.signal}` : `exit code ${waited.value.exitCode}`;
			return fail(vendor, `the X server (${server}) ended with ${how} before the display ${desktop.display} was up${words ? `: ${words}` : ""}`);
		}
		if (timedOut()) return late();
		if (signal?.aborted) return fail("aborted", "create was aborted while the display came up");
		await sleep(DISPLAY_POLL_MS, undefined, { signal: either }).catch(() => undefined);
		if (signal?.aborted) return fail("aborted", "create was aborted while the display came up");
	}
}
