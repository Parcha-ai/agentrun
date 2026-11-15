// A live-Docker test file imports this first (`import "./teardown.mjs";`): every container and volume its process makes
// is removed, by its exact name, once the process is gone, however it went: a normal end, process.exit, an uncaught error,
// a timeout's SIGTERM, or SIGKILL. The files' `after` hooks do the same on a normal end; they never run when the process
// is cut off, and a stopped `computer-*` container, or the egress proxy of an allowlist computer, stayed behind each time.
//
// A process that is killed, or is blocked in a synchronous docker call when the signal comes, cannot clean up after itself,
// so a watchdog does: a detached process that holds the names this one logs, waits for this process to be gone, and then
// removes each, three passes a second apart (a `docker run` the process started before it went may still be finishing in
// Docker). It outlives this process by a few seconds.
//
// What it removes: the name after `--name` in each `docker run` and `docker create`, and the name `docker volume create`
// ends with, in the commands this process runs itself (execFile, execFileSync, spawn, spawnSync), logged before the
// command runs, so a run that is cut off is still named. Nothing is found by a label or a pattern: a container another
// process made is never in this list.
import childProcess, { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The watchdog's program: argv is the pid to wait for and the file that names what to remove, "c <name>" or "v <name>". */
const WATCHDOG = `
const { execFileSync } = require("node:child_process");
const { readFileSync, rmSync } = require("node:fs");
const [parent, file] = process.argv.slice(1);
const gone = () => {
	try {
		process.kill(Number(parent), 0);
		return false;
	} catch (error) {
		return error.code !== "EPERM";
	}
};
const quietly = (args) => {
	try {
		execFileSync("docker", args, { stdio: "ignore", timeout: 30000 });
	} catch {}
};
const timer = setInterval(() => {
	if (!gone()) return;
	clearInterval(timer);
	let lines = [];
	try {
		lines = readFileSync(file, "utf8").split("\\n").filter(Boolean).reverse();
	} catch {}
	let pass = 0;
	const sweep = () => {
		for (const line of lines) {
			if (line.startsWith("c ")) quietly(["rm", "--force", "--volumes", line.slice(2)]);
			else if (line.startsWith("v ")) quietly(["volume", "rm", "--force", line.slice(2)]);
		}
		if (++pass < 3) setTimeout(sweep, 1000);
		else rmSync(file, { force: true });
	};
	sweep();
}, 250);
`;

const file = join(tmpdir(), `agentrun-docker-test-${process.pid}-${randomBytes(4).toString("hex")}.names`);
let watching = false;

/** Logs a name, in the file the watchdog reads; the first one starts the watchdog. */
function note(kind, name) {
	if (typeof name !== "string" || name === "") return;
	appendFileSync(file, `${kind} ${name}\n`);
	if (watching) return;
	watching = true;
	spawn(process.execPath, ["-e", WATCHDOG, String(process.pid), file], { detached: true, stdio: "ignore" }).unref();
}

/** Logs the container or volume a docker command is about to make. */
function record(args) {
	if (!Array.isArray(args)) return;
	if (args[0] === "run" || args[0] === "create") {
		const at = args.indexOf("--name");
		if (at !== -1) note("c", args[at + 1]);
		for (const arg of args) if (typeof arg === "string" && arg.startsWith("--name=")) note("c", arg.slice("--name=".length));
	} else if (args[0] === "volume" && args[1] === "create") {
		note("v", args.at(-1));
	}
}

/** Whether a command is Docker's: a program named docker, so a `run` of something else is never read as one. */
const isDocker = (command) => typeof command === "string" && /(^|\/)docker$/.test(command);

for (const name of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
	const real = childProcess[name];
	childProcess[name] = function (command, ...rest) {
		// (file, args, options, callback): the args may be left out, and are then the options.
		if (isDocker(command)) record(rest[0]);
		return real.call(this, command, ...rest);
	};
}
syncBuiltinESMExports();
