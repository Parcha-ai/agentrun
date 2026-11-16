// exec over one terminal: a vendor whose one two-way channel into a machine is a shell on a pty (a console WebSocket, a
// PTY session). A terminal merges stdout and stderr, turns \n into \r\n and echoes its input, so a process run on it as
// is fails the exec pre-check. ptyPieces makes it framedExec's pieces instead: it sets the terminal raw with no echo,
// then runs the process on fifos under a sh that writes its stdout and stderr back as base64 lines with a marker, and
// an exit line, and decodes stdin from base64 the same way (head and base64, as the upload does). framedExec does the
// rest, and kills by pid over a second terminal. PROVIDERS.md, "Exec shapes that work", has a worked example.
import { randomBytes } from "node:crypto";
import type { HostCall } from "../host.js";
import type { ExecPieces, FramedEvent } from "./framed-exec.js";
import { boundOf } from "./process.js";
import { shellLine } from "./scripts.js";

/** One terminal in the machine: a shell on a pty, as the vendor opens it. */
export interface Terminal {
	/** Types text into the terminal, answered once the vendor took it. */
	send(text: string): Promise<void>;
	/** What the terminal prints, as it comes, until it closes: bytes, or text from a socket of text. */
	output: AsyncIterable<Uint8Array | string>;
	/** Closes the terminal; its shell, and what it still runs, hang up. */
	close(): Promise<void>;
}

/**
 * The sh the process runs under, after `t=<marker>` and `set -- <argv>`. Its output goes out one line per piece:
 * `<marker>o <base64>` for stdout, `<marker>e <base64>` for stderr, then `<marker>x <code>`. A lock (mkdir) keeps the
 * two streams' lines whole on the one terminal. Its stdin comes in as a length line and that much base64, until a
 * line "e". The process gets no terminal: its three streams are fifos.
 */
export const PTY_SCRIPT = [
	'd=$(mktemp -d) && mkfifo "$d/i" "$d/o" "$d/e" "$d/f" || exit 1',
	// The terminal may close as soon as the exit line is read: a hangup ends the sh, and its fifos go with it.
	`trap 'rm -rf "$d"' EXIT`,
	"trap 'exit 129' HUP",
	'frame() { while c=$(dd bs=65536 count=1 2>/dev/null | base64 | tr -d "\\n") && [ -n "$c" ]; do until mkdir "$d/l" 2>/dev/null; do sleep 0.01; done; printf "%s%s %s\\n" "$t" "$1" "$c"; rmdir "$d/l"; done; }',
	"exec 5<&0",
	'cat "$d/f" & w=$!',
	'exec 4>"$d/f"',
	'frame o <"$d/o" >&4 5<&- & a=$!',
	'frame e <"$d/e" >&4 5<&- & b=$!',
	'while read -r n <&5 && [ "$n" != e ]; do head -c "$n" <&5 | base64 -d; done >"$d/i" 4>&- & r=$!',
	'"$@" <"$d/i" >"$d/o" 2>"$d/e" 4>&- 5<&-',
	"c=$?",
	"wait $a $b",
	"kill $r 2>/dev/null",
	'printf "%sx %s\\n" "$t" "$c" >&4',
	"exec 4>&-",
	"wait $w",
].join("\n");

/** The lines of a terminal's output, \r cut from their ends; bytes read as Latin-1, so a prompt of any bytes is a line too. */
async function* linesOf(output: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
	let rest = "";
	for await (const chunk of output) {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1");
		rest += text;
		// A line of 87 KiB comes in many chunks: only the new one is searched.
		let at = rest.indexOf("\n", rest.length - text.length);
		while (at >= 0) {
			yield rest.slice(0, at).replace(/\r+$/, "");
			rest = rest.slice(at + 1);
			at = rest.indexOf("\n");
		}
	}
}

interface PtyProcess {
	terminal: Terminal;
	lines: AsyncGenerator<string>;
	marker: string;
}

/**
 * framedExec's pieces over terminals: each start opens one with `open`, types one short line that sets it raw with
 * no echo (where it is a terminal), prints a marker and reads the script, and answers once the marker comes back.
 * Hand them to framedExec, which kills by pid: `framedExec(ptyPieces(open), argv, ctx)`.
 */
export function ptyPieces(open: (ctx: HostCall) => Promise<Terminal>): ExecPieces<PtyProcess> {
	return {
		async start(argv, ctx) {
			const terminal = await open(ctx);
			const marker = randomBytes(8).toString("hex");
			const script = Buffer.from(`t=${marker}\nset -- ${shellLine(argv)}\n${PTY_SCRIPT}\n`, "utf8").toString("base64");
			const lines = linesOf(terminal.output);
			// The marker is typed in two halves, so the echo of this line is never it.
			const ready = `{ [ ! -t 0 ] || stty raw -echo; } && printf '%s%s\\n' ${marker.slice(0, 8)} ${marker.slice(8)} && exec sh -c "$(head -c ${script.length} | base64 -d)"\n`;
			const bound = boundOf(ctx.timeoutMs, ctx.signal, "the terminal's start");
			let seen = "";
			try {
				await Promise.race([terminal.send(ready), bound.promise]);
				for (;;) {
					const line = await Promise.race([lines.next(), bound.promise]);
					if (line.done) throw new Error(`the terminal closed before the process started: ${JSON.stringify(seen.slice(-200))}`);
					if (line.value.endsWith(marker)) break;
					seen += `${line.value}\n`;
				}
				await Promise.race([terminal.send(script), bound.promise]);
			} catch (error) {
				await terminal.close().catch(() => {});
				throw error;
			} finally {
				bound.clear();
			}
			return { terminal, lines, marker };
		},
		async *events({ terminal, lines, marker }): AsyncIterable<FramedEvent> {
			try {
				for await (const line of lines) {
					if (!line.startsWith(marker)) continue;
					const [kind, value] = [line[marker.length], line.slice(marker.length + 2)];
					if (kind === "o") yield { stream: "stdout", base64: value };
					else if (kind === "e") yield { stream: "stderr", base64: value };
					else if (kind === "x") {
						yield { exit: Number(value) };
						return;
					}
				}
			} finally {
				await terminal.close().catch(() => {});
			}
		},
		write({ terminal }, text) {
			const base64 = Buffer.from(text, "utf8").toString("base64");
			return terminal.send(`${base64.length}\n${base64}`);
		},
		end: ({ terminal }) => terminal.send("e\n"),
	};
}
