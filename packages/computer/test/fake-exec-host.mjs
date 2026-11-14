// A MachineHost with exec alone, for the exec pre-check's tests (exec-stream.test.mjs): every exec is a real process on
// this machine, on pipes, so the pre-check's sh, printf, cat, sleep and kill -0 run as they would in a vendor's box. The
// machine id is ignored. Options break exec the ways a vendor's can, each as one flag, so a test shows the pre-check
// catches it and says what is wrong:
//  - decodeUtf8: stdout is decoded as UTF-8 text and encoded again (a vendor SDK's onStdout(string));
//  - bufferOutput: stdout and stderr come only once the process has exited;
//  - holdStdin: writes are kept until end(), then given all at once;
//  - mergeStderr: stderr comes back on stdout;
//  - commandTimeoutMs: the process is killed once this many ms pass (a vendor's command timeout);
//  - exitCode: wait() answers this, whatever the process exited with;
//  - killDetaches: kill() lets go of the streams and leaves the process running;
//  - closeStdoutEarly: stdout ends after its first chunk, while the process still runs;
//  - slowWriteMs: each write() answers this many ms late.
import { spawn } from "node:child_process";

/** A stream fed by a process, read as an async iterable until it ends. */
function feed() {
	const queue = [];
	let ended = false;
	let wake;
	return {
		push(bytes) {
			if (ended) return;
			queue.push(bytes);
			wake?.();
		},
		end() {
			ended = true;
			wake?.();
		},
		iterable: {
			async *[Symbol.asyncIterator]() {
				for (;;) {
					if (queue.length > 0) yield queue.shift();
					else if (ended) return;
					else await new Promise((done) => (wake = done));
				}
			},
		},
	};
}

export function fakeExecHost(options = {}) {
	const { decodeUtf8 = false, bufferOutput = false, holdStdin = false, mergeStderr = false, commandTimeoutMs, exitCode, killDetaches = false, closeStdoutEarly = false, slowWriteMs = 0 } = options;
	const children = new Set();
	const host = {
		descriptor: { id: "fake-exec" },
		calls: [],
		async exec(id, argv, { stdin }) {
			host.calls.push({ id, argv, stdin });
			const child = spawn(argv[0], argv.slice(1), { stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
			children.add(child);
			const out = feed();
			const err = feed();
			const decoder = new TextDecoder();
			const held = { out: [], err: [] };
			const toOut = (chunk) => {
				const bytes = decodeUtf8 ? new Uint8Array(Buffer.from(decoder.decode(chunk, { stream: true }), "utf8")) : new Uint8Array(chunk);
				if (bufferOutput) held.out.push(bytes);
				else out.push(bytes);
				if (closeStdoutEarly) out.end();
			};
			const toErr = (chunk) => {
				if (mergeStderr) return toOut(chunk);
				if (bufferOutput) held.err.push(new Uint8Array(chunk));
				else err.push(new Uint8Array(chunk));
			};
			child.stdout.on("data", toOut);
			child.stderr.on("data", toErr);
			const timer = commandTimeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), commandTimeoutMs);
			const exited = new Promise((done) => {
				child.on("error", () => done(127));
				child.on("close", (code, signal) => {
					clearTimeout(timer);
					children.delete(child);
					for (const bytes of held.out) out.push(bytes);
					for (const bytes of held.err) err.push(bytes);
					out.end();
					err.end();
					done(exitCode ?? (code ?? (signal ? 137 : -1)));
				});
			});
			await new Promise((started, failed) => {
				child.once("spawn", started);
				child.once("error", failed);
			});
			const pending = [];
			return {
				ok: true,
				value: {
					stdout: out.iterable,
					stderr: err.iterable,
					async write(bytes) {
						if (slowWriteMs > 0) await new Promise((done) => setTimeout(done, slowWriteMs));
						if (holdStdin) pending.push(Buffer.from(bytes));
						else await new Promise((done, fail) => child.stdin.write(Buffer.from(bytes), (error) => (error ? fail(error) : done())));
					},
					async end() {
						if (pending.length > 0) child.stdin.write(Buffer.concat(pending.splice(0)));
						child.stdin.end();
					},
					wait: () => exited,
					async kill() {
						if (!killDetaches) child.kill("SIGKILL");
						out.end();
						err.end();
					},
				},
			};
		},
		/** Ends every process still running: a test's cleanup. */
		stopAll() {
			for (const child of children) child.kill("SIGKILL");
		},
	};
	return host;
}
