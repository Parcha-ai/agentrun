// A runner's outbox under a burst of commits, killed from outside at any point: each commit's entry, then its lines.
import { openOutbox } from "../src/home/outbox.ts";

const [path, linesSync] = process.argv.slice(2);
const outbox = openOutbox(path, { head: 1, linesSync });
for (let commit = 1; ; commit += 1) {
	outbox.entry(commit, [{ type: "submission", value: { id: String(commit), pad: "x".repeat(200) } }]);
	outbox.lines(commit, [{ channel: "durable", kind: "pi.user", commit, order: 0, data: { n: commit } }]);
	if (commit === 20) process.stdout.write("ready\n");
	// No pause: the parent's kill lands anywhere between a write and the next.
	if (commit % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
}
