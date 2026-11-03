import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { type Box, BoxError } from "./box.ts";
import { finish } from "./files.ts";

/**
 * Kills every command group `boxEnv` (`@parcha/pi-transport/hands`) wrote down in the box, as its own kill does: a group
 * file is `<tmp>/.pi-transport/<id>.pid`, `<tmp>` the box's `TMPDIR` or `/tmp`. A file still empty (its command's session
 * started and has not written its group yet) gets the tombstone `<id>.cancel` and is read once more: either the group
 * is seen here, or the session sees the tombstone and never runs its command. A group's file goes only once no live
 * process of the group is left (a zombie not counted); a group still alive after 5 s fails the call, its file kept. A
 * test of this package runs it against `boxEnv`'s own files, so the layout stays one.
 */
const LEFT_SCRIPT = [
	't=$TMPDIR; [ -n "$t" ] || t=/tmp; s=$t/.pi-transport; n=0',
	`live() { if [ ! -r /proc/self/stat ]; then kill -0 "-$1" 2>/dev/null; return; fi; cat /proc/[0-9]*/stat 2>/dev/null | awk -v g="$1" '{ sub(/^[0-9]+ \\(.*\\) /, ""); if ($1 != "Z" && $3 == g) n++ } END { exit n > 0 ? 0 : 1 }'; }`,
	'for f in "$s"/*.pid; do [ -f "$f" ] || continue; id=$(basename "$f" .pid); g=$(cat "$f" 2>/dev/null)',
	'if [ -z "$g" ]; then touch "$s/$id.cancel"; g=$(cat "$f" 2>/dev/null); fi; [ -n "$g" ] || continue',
	'kill -KILL "-$g" 2>/dev/null; i=0; while [ $i -lt 50 ] && live "$g"; do sleep 0.1; i=$((i+1)); done',
	'if live "$g"; then echo "the command group $g is still alive" >&2; exit 1; fi; rm -f "$f"; n=$((n+1)); done',
	'echo "$n"',
].join("\n");

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
