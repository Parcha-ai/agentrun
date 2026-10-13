import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:os";
import { PassThrough } from "node:stream";
import type { Context } from "@earendil-works/chord";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import { BoxError, type BoxExecOptions, type BoxProcess } from "./box.ts";

function signalExitCode(signal: NodeJS.Signals | null): number {
	return 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0));
}

/**
 * Adapt a spawned local process to a `BoxProcess`. `stop` is called once on timeout or abort and must end the
 * program, so the streams close and nothing keeps the caller waiting.
 */
export function adaptChild(
	child: ChildProcessWithoutNullStreams,
	stop: () => void,
	options: BoxExecOptions | undefined,
	context: Context,
): BoxProcess {
	const signal = context.abortSignal;
	const exit = new Promise<Result<number, BoxError>>((resolve) => {
		let timer: NodeJS.Timeout | undefined;
		const settle = (result: Result<number, BoxError>) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = () => {
			stop();
			settle(err(new BoxError("aborted", "the call was aborted")));
		};
		if (options?.timeoutMs !== undefined) {
			const timeoutMs = options.timeoutMs;
			timer = setTimeout(() => {
				stop();
				settle(err(new BoxError("timeout", `the program did not exit in ${timeoutMs} ms`)));
			}, timeoutMs);
		}
		child.once("error", (cause) => settle(err(new BoxError("spawn", cause.message, cause))));
		child.once("close", (code, ended) => settle(ok(code ?? signalExitCode(ended))));
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
	// A program that exits without reading its input closes the pipe; the exit code already reports it.
	child.stdin.on("error", () => {});
	// Node discards what an exited child wrote and nobody was reading yet. The pipes start now and hold it.
	const stdout = child.stdout.pipe(new PassThrough());
	const stderr = child.stderr.pipe(new PassThrough());
	return {
		stdin: {
			write: (bytes) =>
				new Promise<void>((resolve, reject) => {
					child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
				}),
			// A pipe the program already closed never finishes, so the wait is for the pipe's end either way.
			close: () =>
				new Promise<void>((resolve) => {
					if (child.stdin.destroyed) return resolve();
					child.stdin.once("close", () => resolve());
					child.stdin.end();
				}),
		},
		stdout,
		stderr,
		wait: () => exit,
	};
}
