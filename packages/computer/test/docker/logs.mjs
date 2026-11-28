// A container's stdout as a live test reads it. Docker copies a container's output to its log on its own time, so a line
// the container wrote before it answered a request can reach `docker logs` after the answer does. A test that reads the
// log once, as soon as its requests are answered, can miss a line it is right to expect. logsWith follows the log until
// the line it waits for is in it, for a bounded time.
//
// AGENTRUN_COMPUTER_TEST_LOG_LAG_MS makes that lag certain, for a red that does not wait on a busy host: a line counts as
// in the log only that many milliseconds after Docker's own timestamp for it.

import { spawn } from "node:child_process";

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

/**
 * Follows the container's stdout until pattern matches it, and gives all of it up to then. Fails in words, with what
 * the log held, when withinMs passes first or the log ends without it.
 */
export function logsWith(name, pattern, { withinMs = 30_000 } = {}) {
	return new Promise((resolve, reject) => {
		const follow = spawn("docker", ["logs", "--follow", "--timestamps", name], { stdio: ["ignore", "pipe", "ignore"] });
		let stamped = "";
		let finished = false;
		const finish = (error) => {
			if (finished) return;
			finished = true;
			clearInterval(tick);
			clearTimeout(limit);
			follow.kill();
			if (error) reject(error);
			else resolve(landed(stamped, Date.now()));
		};
		const check = () => {
			if (pattern.test(landed(stamped, Date.now()))) finish();
		};
		const tick = setInterval(check, 50);
		const limit = setTimeout(() => finish(new Error(`${name}'s log held no ${pattern} within ${withinMs} ms: ${JSON.stringify(landed(stamped, Date.now()))}`)), withinMs);
		follow.stdout.setEncoding("utf8");
		follow.stdout.on("data", (chunk) => {
			stamped += chunk;
			check();
		});
		follow.on("error", (error) => finish(error));
		follow.on("close", () => {
			check();
			finish(new Error(`${name}'s log ended with no ${pattern}: ${JSON.stringify(landed(stamped, Date.now()))}`));
		});
	});
}
