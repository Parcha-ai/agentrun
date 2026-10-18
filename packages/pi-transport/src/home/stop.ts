import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { finish } from "../box/files.ts";
import type { Place } from "./move.ts";

/** How a host stops the runner that may still run at a place before it starts another there. */
export type StopRunner = (place: Place, context: Context) => Promise<Result<void, Error>>;

/**
 * A shell function: `alive <pid>` succeeds while the process runs. A zombie nobody reaped yet is not running, and nor
 * is one gone from /proc by the time its state is read: its parent reaped it after `kill -0` saw it.
 */
export const ALIVE_SH = `alive() { kill -0 "$1" 2>/dev/null || return 1; s=$(sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -c1); [ -n "$s" ] && [ "$s" != Z ]; }`;

/**
 * `$1` the pid file, `$2` the store, `$3` the first signal (default TERM). A process that is gone, or a zombie nobody
 * reaped, is not running. A process whose command line does not name `--store <store>` is not this store's runner: its
 * id was given to another since.
 */
const STOP = `${ALIVE_SH}
p=$(cat "$1" 2>/dev/null) || exit 0
case "$p" in ''|*[!0-9]*) exit 0;; esac
alive "$p" || exit 0
if [ -r "/proc/$p/cmdline" ]; then args="$(tr '\\000' ' ' < "/proc/$p/cmdline")"; else args="$(ps -o args= -p "$p" 2>/dev/null) "; fi
case "$args" in *"--store $2 "*) ;; *) exit 0;; esac
kill -"\${3:-TERM}" "$p" 2>/dev/null
i=0
while alive "$p"; do
	i=$((i + 1))
	[ "$i" -eq 50 ] && kill -KILL "$p" 2>/dev/null
	[ "$i" -gt 100 ] && exit 3
	sleep 0.1
done
exit 0`;

/**
 * Stop the runner of `place`'s store that still runs in its box, if one does: the process `runMain` wrote to
 * `<store>.pid`, and only when its command line names this store. TERM first, KILL after 5 s; done once it is gone. A
 * call it had in flight is cut, and pi reports it to the model as interrupted: at most once. A host whose runners a
 * launcher keeps alive stops them through the launcher instead.
 */
export const stopRunner: StopRunner = (place, context) => endRunner(place, "TERM", context);

/**
 * Kill the runner of `place`'s store at once, as a crash would: the same runner `stopRunner` finds, sent KILL first.
 * Nothing closes in order: the store is as the last commit left it, and a call in flight is cut.
 */
export const killRunner: StopRunner = (place, context) => endRunner(place, "KILL", context);

async function endRunner(place: Place, signal: "TERM" | "KILL", context: Context): Promise<Result<void, Error>> {
	const started = await place.box.exec(
		["sh", "-c", STOP, "sh", `${place.store}.pid`, place.store, signal],
		{ timeoutMs: 60_000 },
		context,
	);
	if (!started.ok) return err(started.error);
	const done = await finish(started.value);
	if (!done.ok) return err(done.error);
	if (done.value.exitCode !== 0) {
		return err(new Error(`the runner of ${place.store} in ${place.box.id} did not stop in 10 s`));
	}
	return ok(undefined);
}
