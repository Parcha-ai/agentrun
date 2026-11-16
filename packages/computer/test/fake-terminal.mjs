// A vendor whose one channel into a machine is a terminal, as a console WebSocket or a PTY session is, and the host a
// vendor writes over it with ptyPieces (src/hosted/pty-exec.ts). Each terminal is an interactive sh on a real pty on
// this machine, through util-linux's `script`: the pty's own line discipline echoes what is typed, turns \n into \r\n
// and merges stdout and stderr, and sh prints its prompt. Closing one kills `script`, which hangs up the pty.
import { spawn, spawnSync } from "node:child_process";
import { framedExec } from "../dist/hosted/framed-exec.js";
import { ptyPieces } from "../dist/hosted/pty-exec.js";

/** Whether this machine has util-linux's script (macOS's takes other flags). */
export const HAS_SCRIPT = spawnSync("script", ["--version"], { encoding: "utf8" }).stdout?.includes("util-linux") ?? false;

/** Opens terminals, their shells' TMPDIR `tmp` where given; stopAll() closes every one still open (a test's cleanup). */
export function fakeTerminals({ tmp } = {}) {
	const open = new Set();
	const close = async (child) => {
		open.delete(child);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	};
	return {
		/** One terminal: a sh on a fresh pty. */
		async open() {
			const child = spawn("script", ["-qfc", "sh", "/dev/null"], { stdio: ["pipe", "pipe", "ignore"], env: tmp === undefined ? process.env : { ...process.env, TMPDIR: tmp } });
			open.add(child);
			child.stdin.on("error", () => {});
			await new Promise((started, failed) => {
				child.once("spawn", started);
				child.once("error", failed);
			});
			return {
				send: (text) => new Promise((done, fail) => child.stdin.write(text, (error) => (error ? fail(error) : done()))),
				output: child.stdout,
				close: () => close(child),
			};
		},
		stopAll: () => Promise.all([...open].map(close)),
	};
}

/** The host's exec over terminals, as a vendor writes it: an open, handed to ptyPieces and framedExec. */
export const ptyExec = (terminals) => (_id, argv, ctx) => framedExec(ptyPieces(() => terminals.open()), argv, ctx);
