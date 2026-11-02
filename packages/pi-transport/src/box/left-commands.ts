import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { type Box, BoxError } from "./box.ts";
import { finish } from "./files.ts";

/**
 * Kills every command group `boxEnv` (`@parcha/pi-transport/hands`) wrote down in the box, and forgets it. A command's
 * group file is `<tmp>/.pi-transport/<id>.pid`, `<tmp>` the box's `TMPDIR` or `/tmp`, as `boxEnv` writes it; a test of
 * this package runs the two together, so the layout stays one.
 */
const LEFT_SCRIPT = [
	't=$TMPDIR; [ -n "$t" ] || t=/tmp; s=$t/.pi-transport; n=0',
	'for f in "$s"/*.pid; do [ -f "$f" ] || continue; g=$(cat "$f" 2>/dev/null); [ -n "$g" ] && kill -KILL "-$g" 2>/dev/null && n=$((n+1)); rm -f "$f"; done',
	'echo "$n"',
].join("; ");

const LEFT_TIMEOUT_MS = 15_000;

/**
 * Ends the commands a box still runs for a host that is gone: a process that started commands through `boxEnv` and died
 * leaves them running (ending a `docker exec` client does not end its program), and its environment is gone with it,
 * so no `cleanup` reaches them. The host that takes the box over calls this once before its first command, and gets
 * how many command groups it killed. Commands of another live environment on the same box are killed too: call it only
 * on a box no live environment uses.
 */
export async function endLeftCommands(box: Box, context: Context): Promise<Result<number, BoxError>> {
	const started = await box.exec(["sh", "-c", LEFT_SCRIPT], { timeoutMs: LEFT_TIMEOUT_MS }, context);
	if (!started.ok) return started;
	const finished = await finish(started.value);
	if (!finished.ok) return finished;
	if (finished.value.exitCode !== 0) {
		return err(
			new BoxError(
				"unknown",
				`ending the box's left commands failed: ${finished.value.stderr.trim().slice(0, 200)}`,
			),
		);
	}
	return ok(Number.parseInt(new TextDecoder().decode(finished.value.stdout).trim(), 10) || 0);
}
