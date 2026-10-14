import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { type Box, BoxError, type BoxProcess } from "../box/box.ts";
import { finish } from "../box/files.ts";

const DEFAULT_COUNT = 10;
const DEFAULT_TIMEOUT_MS = 60_000;
const ACK_PREFIX = "ack ";
const PID_PREFIX = "pid ";

/**
 * The writer: appends a record to a file, makes it durable, and only then says so. `sync FILE` is an fsync of that file on
 * GNU coreutils; where `sync` takes no file (BusyBox) it syncs everything, which is the same promise with more work. After
 * `$2` records it idles and waits to be killed. A failed append or sync ends it with a non-zero exit, never an acknowledgement.
 */
export const WRITER_SCRIPT = [
	'f=$1; n=$2; mkdir -p -- "$(dirname -- "$f")" && : > "$f" || exit 3; echo "pid $$"; i=0',
	'while [ "$i" -lt "$n" ]; do',
	// A record is acknowledged only when it was appended and one of the syncs succeeded; otherwise the writer stops.
	'  i=$((i + 1)); echo "record $i" >> "$f" || exit 4; { sync "$f" 2>/dev/null || sync; } || exit 5; echo "ack $i"',
	"done",
	"while :; do sleep 1; done",
].join("\n");

/** What `probeAcknowledgedWrites` asks of a box. */
export type AcknowledgedWritesOptions = {
	/** How many records the writer acknowledges before it is killed. Default 10. */
	readonly count?: number;
	/** A file in the box's workspace for the records. Default a name of its own; the file is removed at the end. */
	readonly path?: string;
	/** Give up on the writer after this long. Default 60 s. */
	readonly timeoutMs?: number;
};

/** What the probe found: records the writer was told were durable, and records still in the file after it was killed. */
export type AcknowledgedWrites = { readonly acknowledged: number; readonly kept: number };

type Ran = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

async function runToEnd(
	box: Box,
	script: string,
	args: readonly string[],
	context: Context,
): Promise<Result<Ran, BoxError>> {
	const started = await box.exec(["sh", "-c", script, "sh", ...args], undefined, context);
	if (!started.ok) return started;
	const finished = await finish(started.value);
	if (!finished.ok) return finished;
	return ok({
		exitCode: finished.value.exitCode,
		stdout: new TextDecoder().decode(finished.value.stdout),
		stderr: finished.value.stderr,
	});
}

const KILL_WAIT_MS = 10_000;

/** The writer's exit, or `undefined` when it has not ended within `ms`. */
async function endedWithin(writer: BoxProcess, ms: number): Promise<Result<number, BoxError> | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	try {
		return await Promise.race([writer.wait(), late]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Ten acknowledged writes, then a kill, then a read from a second process: does a write a program was told was durable
 * survive that program's death? A writer in the box appends records to a file in the workspace, makes each one durable
 * and prints an acknowledgement; after `count` acknowledgements it is killed with SIGKILL and a second `exec` counts the
 * records in the file. A runtime is fit to be a session's home only when `kept === acknowledged`. Needs `sh`, `sync`,
 * `sleep` and `kill`. It kills only the writer: the box and its disk stay up, so it says nothing about the death of the
 * box or a read from a second box. A mismatch is a result, not an error; the caller decides.
 */
export async function probeAcknowledgedWrites(
	box: Box,
	options: AcknowledgedWritesOptions | undefined,
	context: Context,
): Promise<Result<AcknowledgedWrites, BoxError>> {
	const count = options?.count ?? DEFAULT_COUNT;
	if (!Number.isInteger(count) || count < 1) return err(new BoxError("invalid", "count must be a positive integer"));
	const path =
		options?.path ?? `.pi-transport-probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const writer = await box.exec(["sh", "-c", WRITER_SCRIPT, "sh", path, String(count)], undefined, context);
	if (!writer.ok) return writer;
	void writer.value.stdin.close().catch(() => {});
	void (async () => {
		for await (const _ of writer.value.stderr) void _;
	})().catch(() => {});

	let pid: number | undefined;
	let acknowledged = 0;
	let timedOut = false;
	let streamEnded = false;
	// The deadline is raced against each read: a writer stuck in `sync` sends nothing, and a flag set by a timer would be
	// looked at only after the next chunk.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"deadline">((resolve) => {
		timer = setTimeout(() => resolve("deadline"), timeoutMs);
	});
	const lines = writer.value.stdout[Symbol.asyncIterator]();
	try {
		let pending = "";
		const decoder = new TextDecoder();
		reading: for (;;) {
			const next = await Promise.race([lines.next(), deadline]);
			if (next === "deadline") {
				timedOut = true;
				break;
			}
			if (next.done) {
				streamEnded = true;
				break;
			}
			pending += decoder.decode(next.value, { stream: true });
			for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
				const line = pending.slice(0, end);
				pending = pending.slice(end + 1);
				if (line.startsWith(PID_PREFIX)) pid = Number(line.slice(PID_PREFIX.length));
				if (line.startsWith(ACK_PREFIX)) acknowledged = Number(line.slice(ACK_PREFIX.length));
				if (acknowledged >= count) break reading;
			}
		}
	} finally {
		clearTimeout(timer);
		void Promise.resolve(lines.return?.()).catch(() => {});
	}
	if (pid === undefined || !Number.isInteger(pid)) {
		void writer.value.wait();
		return err(new BoxError("unknown", "the writer never said its pid"));
	}
	if (streamEnded && acknowledged < count) {
		// It stopped by itself: a failed append or sync, which it never acknowledges.
		const ended = await endedWithin(writer.value, KILL_WAIT_MS);
		const how = ended?.ok ? `exit ${ended.value}` : "no exit status";
		return err(new BoxError("unknown", `the writer stopped after ${acknowledged} of ${count} records (${how})`));
	}
	// The kill is a second exec: only the writer dies. The shell's sleep child may linger until the box is destroyed.
	const killed = await runToEnd(box, 'kill -9 "$1"', [String(pid)], context);
	if (timedOut && acknowledged < count) {
		void writer.value.wait();
		return err(
			new BoxError("timeout", `the writer acknowledged ${acknowledged} of ${count} records in ${timeoutMs} ms`),
		);
	}
	if (!killed.ok) return killed;
	if (killed.value.exitCode !== 0) {
		return err(
			new BoxError(
				"unknown",
				`the kill of the writer failed (exit ${killed.value.exitCode}): ${killed.value.stderr.trim().slice(0, 200)}`,
			),
		);
	}
	const ended = await endedWithin(writer.value, KILL_WAIT_MS);
	if (ended === undefined) return err(new BoxError("timeout", "the writer did not end after the kill"));
	const read = await runToEnd(box, 'cat -- "$1"; rm -f -- "$1"', [path], context);
	if (!read.ok) return read;
	const kept = read.value.stdout.split("\n").filter((line) => /^record [0-9]+$/.test(line)).length;
	return ok({ acknowledged, kept });
}
