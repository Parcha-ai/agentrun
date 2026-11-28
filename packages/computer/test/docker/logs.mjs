// A container's stdout as a live test reads it. Docker copies a container's output to its log on its own time, so a line
// the container wrote before it answered a request can reach `docker logs` after the answer does. A test that reads the
// log once, as soon as its requests are answered, can miss a line it is right to expect.
//
// AGENTRUN_COMPUTER_TEST_LOG_LAG_MS makes that lag certain, for a red that does not wait on a busy host: a line counts as
// in the log only that many milliseconds after Docker's own timestamp for it.

import { execFileSync } from "node:child_process";

const LAG_MS = Number(process.env.AGENTRUN_COMPUTER_TEST_LOG_LAG_MS ?? 0);

/** The lines of a `docker logs --timestamps` text that a log lagging lagMs holds at the time now, without their stamps. */
function landed(stamped, now, lagMs = LAG_MS) {
	const lines = [];
	for (const line of stamped.split("\n")) {
		const space = line.indexOf(" ");
		if (space < 0) continue;
		if (Date.parse(line.slice(0, space)) + lagMs <= now) lines.push(line.slice(space + 1));
	}
	return lines.join("\n");
}

/** The container's stdout as its log holds it now: one read. */
export function logsNow(name) {
	return landed(execFileSync("docker", ["logs", "--timestamps", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), Date.now());
}
