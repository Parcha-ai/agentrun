import { afterAll } from "vitest";
import { carriersOf, waitNotRunning } from "./box-env-support.ts";

/** A local box's programs carry `PI_TRANSPORT_BOX=<its id>`, and so does everything they start: a launcher's supervisor, its watchdog, the program. */
const BOX_VARIABLE = "PI_TRANSPORT_BOX";
/** The mark every process of one test file carries, in this process's environment and, through `env`, in the box of each case. */
export const RUN_VARIABLE = "PI_TRANSPORT_TEST_RUN";
const END_ROUNDS = 20;
const END_PAUSE_MS = 100;

/** End everything that carries the mark, round after round: a launcher's watchdog starts a new supervisor when one is killed alone, so one pass is not enough. */
async function endCarriers(name: string, value: string): Promise<void> {
	for (let round = 0; round < END_ROUNDS; round += 1) {
		const found = carriersOf(name, value);
		if (found.length === 0) return;
		for (const { pid } of found) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Gone already.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, END_PAUSE_MS));
	}
}

const describeCarriers = (left: readonly { pid: number; command: string }[]) =>
	left.map(({ pid, command }) => `${pid} ${command}`).join("; ");

/**
 * Mark this file's processes and fail the file if one outlives it. A launcher's supervisor loops until it is stopped, so a case that
 * launches and does not stop or destroy leaves it looping after the run: the file that left it is named, with the pid and command
 * of what it left, and what it left is ended. Call it once at the top of a file; make every box with the returned `env` in its spec,
 * since a box's commands get the box's environment in place of this process's.
 */
export function guardLeaks(): { readonly env: Readonly<Record<string, string>> } {
	const run = `${process.pid}-${Date.now()}`;
	process.env[RUN_VARIABLE] = run;
	afterAll(async () => {
		try {
			await waitNotRunning(() => carriersOf(RUN_VARIABLE, run).length > 0, "a process this file started", 8_000);
		} catch {
			const left = carriersOf(RUN_VARIABLE, run);
			await endCarriers(RUN_VARIABLE, run);
			throw new Error(`this file left processes behind: ${describeCarriers(left)}`);
		}
	}, 30_000);
	return { env: { [RUN_VARIABLE]: run } };
}

/**
 * After a box is destroyed, nothing that carries its marker may run. A launcher's supervisor and watchdog restart each other and the
 * program, so one that survives a destroy loops for as long as the machine is up. A case that leaves one fails here, named, with the
 * pid and command of what it left; what it left is ended.
 */
export async function assertNothingOfBox(boxId: string): Promise<void> {
	try {
		await waitNotRunning(() => carriersOf(BOX_VARIABLE, boxId).length > 0, `a process of box ${boxId}`, 8_000);
	} catch {
		const left = carriersOf(BOX_VARIABLE, boxId);
		await endCarriers(BOX_VARIABLE, boxId);
		throw new Error(`box ${boxId} was destroyed and left: ${describeCarriers(left)}`);
	}
}
