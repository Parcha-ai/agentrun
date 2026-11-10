// A fake clock for tests whose waits are timers in this process: the provider's bounds, its fake's latencies and the
// test's own pauses. node:test's mock.timers takes setTimeout, setInterval and Date; the clock moves only once nothing
// else can run (promises, I/O callbacks and immediates go first), so every wait is reached in the order its time
// says, at no wall-clock cost and with no margin a busy host can miss. No production seam: the code under test reads
// the same global timers and Date it always does.
//
// What it cannot reach stays real, and a test that needs it says so: AbortSignal.timeout, node:timers/promises imported
// before the clock is taken, and other processes.
import { mock } from "node:test";

/** The clock's step, in ms: small enough that waits a few ms apart still fire in order. */
const STEP = 5;

/** Runs body on the fake clock, from now, until it settles; then the real timers are back. */
export async function onFakeTime(body) {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
	// The outcome is taken at once, so a failure is never an unhandled rejection while the clock still runs.
	let outcome;
	(async () => body())().then(
		(value) => (outcome = { value }),
		(error) => (outcome = { error }),
	);
	try {
		while (outcome === undefined) {
			// Everything that can run without time passing runs first.
			for (let turn = 0; turn < 3 && outcome === undefined; turn++) await new Promise((resolve) => setImmediate(resolve));
			if (outcome === undefined) mock.timers.tick(STEP);
		}
	} finally {
		mock.timers.reset();
	}
	if ("error" in outcome) throw outcome.error;
	return outcome.value;
}
