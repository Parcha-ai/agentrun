// Waits for a computerd init a test started to make its socket, on the filesystem's word, not a clock.
import { existsSync, watch } from "node:fs";
import { dirname } from "node:path";

/**
 * Resolves once `socket` is there; rejects, with what `stderr()` read, if `init` (its ChildProcess) ends first. The
 * directory is watched before the first look, so a socket made in between is still seen.
 */
export function computerdListening(socket, init, stderr) {
	return new Promise((resolve, reject) => {
		const watcher = watch(dirname(socket), () => existsSync(socket) && done());
		const ended = () => done(new Error(`computerd's init ended before it listened at ${socket}: ${stderr()}`));
		function done(error) {
			watcher.close();
			init.off("exit", ended);
			if (error) reject(error);
			else resolve();
		}
		init.once("exit", ended);
		if (existsSync(socket)) done();
		else if (init.exitCode !== null || init.signalCode !== null) ended();
	});
}
