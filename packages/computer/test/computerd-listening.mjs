// Waits for a computerd init a test started to take connections on its socket, on the system's word, not a clock.
import { existsSync, watch } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";

/**
 * Resolves once a connection to `socket` is taken; rejects, with what `stderr()` read, if `init` (its ChildProcess) ends
 * first. The directory is watched before the first look, so a socket made in between is still seen. A socket is bound
 * before it listens, so one there may still refuse: the connect is tried again at once until init takes it (computerd
 * takes any number of connections, and its own start dials the socket so).
 */
export function computerdListening(socket, init, stderr) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let dialing = false;
		const watcher = watch(dirname(socket), () => dial());
		const ended = () => done(new Error(`computerd's init ended before it listened at ${socket}: ${stderr()}`));
		function done(error) {
			if (settled) return;
			settled = true;
			watcher.close();
			init.off("exit", ended);
			if (error) reject(error);
			else resolve();
		}
		function dial() {
			if (settled || dialing || !existsSync(socket)) return;
			dialing = true;
			const probe = connect(socket);
			probe.once("connect", () => (probe.destroy(), done()));
			probe.once("error", (error) => {
				dialing = false;
				if (error.code === "ECONNREFUSED") setImmediate(dial);
				else done(error);
			});
		}
		init.once("exit", ended);
		if (init.exitCode !== null || init.signalCode !== null) ended();
		else dial();
	});
}
