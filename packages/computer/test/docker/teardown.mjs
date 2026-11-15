// A live-Docker test file imports this first (`import "./teardown.mjs";`): every container and volume its process makes
// is removed, by its exact name, once the process is gone, however it went: a normal end, process.exit, an uncaught error,
// a timeout's SIGTERM, or SIGKILL. The files' `after` hooks do the same on a normal end; they never run when the process
// is cut off, and a stopped `computer-*` container, or the egress proxy of an allowlist computer, stayed behind each time.
//
// A process that is killed, or is blocked in a synchronous docker call when the signal comes, cannot clean up after itself,
// so a watchdog does: a detached process that holds the names this one logs, waits for this process to be gone, and then
// removes each, a pass a second, until each is confirmed absent and nothing can still make it: a `docker run` the process
// started before it went can live on and create its container late, so the watchdog also waits for the docker children this
// process logged by pid (async calls) and for any running docker command that names the item (read from `ps`, which covers
// the sync calls, whose pid is unknown until they return). At least three passes, and 2 minutes at most.
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
const BOUND = 120000;
const alive = (pid) => {
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
};
const docker = (args) => {
	try {
		execFileSync("docker", args, { stdio: "ignore", timeout: 30000 });
		return true;
	} catch {
		return false;
	}
};
const entries = () => {
	try {
		return readFileSync(file, "utf8").split("\\n").filter(Boolean);
	} catch {
		return [];
	}
};
// Every process now running, as "pid args": a docker command that names an item may still be about to make it.
const processes = () => {
	try {
		return execFileSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8", timeout: 30000, maxBuffer: 1 << 26 }).split("\\n");
	} catch {
		return [];
	}
};
const isDocker = (word) => /(^|\\/)docker$/.test(word || "");
const naming = (name, lines) =>
	lines.some((line) => {
		const [pid, ...words] = line.trim().split(/\\s+/);
		if (Number(pid) === process.pid) return false;
		// The program is docker, or a script named docker that runs it.
		if (!isDocker(words[0]) && !isDocker(words[1])) return false;
		return words.includes(name) || words.includes("--name=" + name);
	});
const timer = setInterval(() => {
	if (alive(parent)) return;
	clearInterval(timer);
	const deadline = Date.now() + BOUND;
	let pass = 0;
	// An item is forgotten only once it is confirmed absent and nothing can still make it: no docker child the process
	// logged is alive, and no running docker command names it. Bounded, so the watchdog always ends.
	const sweep = () => {
		const lines = entries().reverse();
		const items = lines.filter((line) => line.startsWith("c ") || line.startsWith("v "));
		for (const line of items) {
			if (line.startsWith("c ")) docker(["rm", "--force", "--volumes", line.slice(2)]);
			else docker(["volume", "rm", "--force", line.slice(2)]);
		}
		const absent = items.every((line) => !docker(line.startsWith("c ") ? ["inspect", "--type", "container", line.slice(2)] : ["volume", "inspect", line.slice(2)]));
		const children = lines.filter((line) => line.startsWith("p ")).some((line) => alive(line.slice(2)));
		const running = processes();
		const making = items.some((line) => naming(line.slice(2), running));
		pass++;
		if ((pass >= 3 && absent && !children && !making) || Date.now() >= deadline) rmSync(file, { force: true });
		else setTimeout(sweep, 1000);
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
	if (!Array.isArray(args)) return false;
	if (args[0] === "run" || args[0] === "create") {
		const at = args.indexOf("--name");
		if (at !== -1) note("c", args[at + 1]);
		for (const arg of args) if (typeof arg === "string" && arg.startsWith("--name=")) note("c", arg.slice("--name=".length));
		return true;
	}
	if (args[0] === "volume" && args[1] === "create") {
		note("v", args.at(-1));
		return true;
	}
	return false;
}

/** Whether a command is Docker's: a program named docker, so a `run` of something else is never read as one. */
const isDocker = (command) => typeof command === "string" && /(^|\/)docker$/.test(command);

for (const name of ["execFile", "execFileSync", "spawn", "spawnSync"]) {
	const real = childProcess[name];
	childProcess[name] = function (command, ...rest) {
		// (file, args, options, callback): the args may be left out, and are then the options.
		const making = isDocker(command) && record(rest[0]);
		const result = real.call(this, command, ...rest);
		// An async call returns its child: the watchdog waits for it too, as it may make the item after this process is gone.
		if (making && typeof result?.pid === "number") appendFileSync(file, `p ${result.pid}\n`);
		return result;
	};
}
syncBuiltinESMExports();
