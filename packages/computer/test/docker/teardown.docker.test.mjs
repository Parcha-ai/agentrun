// A live-Docker test file that is cut off leaves nothing on the host (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only). Each case runs
// one of the other files in this directory as `node --test` does, with a `docker` first on PATH that logs the name of every
// container and volume the run makes before it runs the real docker, so the names are exact. Once a container of the run
// exists, the run is cut off: SIGTERM to `node --test`, as a timeout sends it, or process.exit in the file's own process,
// as a file that fails outside its tests ends. Neither reaches the file's `after` hook. Then each name the
// log holds is looked up by docker inspect, and every one must be gone; whatever is left is removed by that exact name.
// Needs `npm run build` and `npm run build:daemon` first, and the images each file names pulled.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const real = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const exists = (name) => {
	try {
		real("inspect", "--type", "container", name);
		return true;
	} catch {
		return false;
	}
};
const volumeExists = (name) => {
	try {
		real("volume", "inspect", name);
		return true;
	} catch {
		return false;
	}
};

/** Files that make a container early; the rest need an image built first, or make none in their first seconds. */
const FILES = [
	"provider",
	"epoch",
	"processes",
	"run-command",
	"files",
	"daemon-mode",
	"pid1-commands",
	"loopback-block",
	"e2b-commands",
	"daytona-commands",
	"volume",
	"egress",
	"conformance",
];

const WRAPPER = `#!/usr/bin/env bash
# Logs what a docker command is about to make, then runs the real docker.
if [ "\${1:-}" = "run" ] || [ "\${1:-}" = "create" ]; then
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--name" ]; then printf 'c %s\\n' "$arg" >> "\${DOCKER_NAME_LOG:?}"; fi
    prev=$arg
  done
elif [ "\${1:-}" = "volume" ] && [ "\${2:-}" = "create" ]; then
  printf 'v %s\\n' "\${@: -1}" >> "\${DOCKER_NAME_LOG:?}"
fi
exec "\${REAL_DOCKER:?}" "$@"
`;

/** A preload for the file's own process, not for `node --test` itself: process.exit once a container exists. */
const CRASH = `
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
if (process.env.NODE_TEST_CONTEXT) {
	const timer = setInterval(() => {
		let names = [];
		try {
			names = readFileSync(process.env.DOCKER_NAME_LOG, "utf8").split("\\n").filter((line) => line.startsWith("c ")).map((line) => line.slice(2));
		} catch {}
		for (const name of names) {
			try {
				execFileSync(process.env.REAL_DOCKER, ["inspect", "--type", "container", name], { stdio: "ignore" });
			} catch {
				continue;
			}
			clearInterval(timer);
			// What a file that fails outside its tests does: the process ends here, and no after hook runs.
			setTimeout(() => process.exit(1), 0);
			return;
		}
	}, 200);
}
`;

describe("a test file that is cut off leaves no container or volume it made", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "agentrun-teardown-"));
	const realDocker = execFileSync("which", ["docker"], { encoding: "utf8" }).trim();
	writeFileSync(join(dir, "docker"), WRAPPER);
	chmodSync(join(dir, "docker"), 0o755);
	writeFileSync(join(dir, "crash.mjs"), CRASH);
	/** Every container and volume any case's run made, by exact name, for the after hook to remove if a case failed. */
	const everything = { containers: new Set(), volumes: new Set() };

	after(() => {
		for (const name of everything.containers) {
			try {
				real("rm", "--force", "--volumes", name);
			} catch {
				// Already gone.
			}
		}
		for (const name of everything.volumes) {
			try {
				real("volume", "rm", "--force", name);
			} catch {
				// Already gone.
			}
		}
		rmSync(dir, { recursive: true, force: true });
	});

	const namesIn = (log) => {
		let text = "";
		try {
			text = readFileSync(log, "utf8");
		} catch {
			// Nothing made yet.
		}
		const lines = text.split("\n").filter(Boolean);
		return { containers: lines.filter((line) => line.startsWith("c ")).map((line) => line.slice(2)), volumes: lines.filter((line) => line.startsWith("v ")).map((line) => line.slice(2)) };
	};

	/** Runs `file` as `node --test` does, cuts it off once one of its containers exists, and answers what is left. */
	async function cutOff(file, how) {
		const log = join(dir, `${file}-${how}.log`);
		const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_NAME_LOG: log, REAL_DOCKER: realDocker, AGENTRUN_COMPUTER_LIVE_DOCKER: "1" };
		// This file runs under `node --test`: with its marker left in, the nested one runs the file as a child and skips it.
		delete env.NODE_TEST_CONTEXT;
		const flags = how === "crash" ? ["--import", join(dir, "crash.mjs")] : [];
		const run = spawn(process.execPath, [...flags, "--test", "--test-timeout=900000", join(HERE, `${file}.docker.test.mjs`)], { env, stdio: "ignore" });
		const ended = new Promise((resolve) => run.once("exit", (code, signal) => resolve({ code, signal })));
		let finished = false;
		ended.then(() => {
			finished = true;
		});
		const bound = Date.now() + 240_000;
		let seen = false;
		while (!finished && Date.now() < bound) {
			if (namesIn(log).containers.some(exists)) {
				seen = true;
				break;
			}
			await sleep(200);
		}
		for (const name of namesIn(log).containers) everything.containers.add(name);
		if (seen && how === "sigterm") run.kill("SIGTERM");
		const exit = await Promise.race([ended, sleep(120_000).then(() => undefined)]);
		if (exit === undefined) run.kill("SIGKILL");
		const made = namesIn(log);
		for (const name of made.containers) everything.containers.add(name);
		for (const name of made.volumes) everything.volumes.add(name);
		// `node --test` ends on the signal at once, and the file's own process, which got it from there, is still removing
		// what it made: look again for up to 30 s before calling what is there left behind.
		const gone = () => made.containers.every((name) => !exists(name)) && made.volumes.every((name) => !volumeExists(name));
		for (const until = Date.now() + 30_000; !gone() && Date.now() < until; ) await sleep(500);
		// A file that exits by itself may be over before a look finds its container: what it logged it made.
		return { seen: seen || (how === "crash" && made.containers.length > 0), exit, made, left: { containers: made.containers.filter(exists), volumes: made.volumes.filter(volumeExists) } };
	}

	for (const file of FILES) {
		it(`${file}: after SIGTERM to node --test, none of its containers or volumes remains`, async () => {
			const { seen, exit, made, left } = await cutOff(file, "sigterm");
			assert.equal(seen, true, `${file} made no container that existed within the bound (exit ${JSON.stringify(exit)}); it names ${JSON.stringify(made)}`);
			assert.notEqual(exit, undefined, `${file} did not end within 120 s of the SIGTERM`);
			assert.deepEqual(left, { containers: [], volumes: [] }, `left behind by ${file} (made ${JSON.stringify(made)})`);
		});
	}

	for (const file of ["run-command", "provider"]) {
		it(`${file}: after its process exits outside a test, none of its containers or volumes remains`, async () => {
			const { seen, exit, made, left } = await cutOff(file, "crash");
			assert.equal(seen, true, `${file} made no container that existed within the bound (exit ${JSON.stringify(exit)}); it names ${JSON.stringify(made)}`);
			assert.notEqual(exit, undefined, `${file} did not end after its process exited`);
			assert.deepEqual(left, { containers: [], volumes: [] }, `left behind by ${file} (made ${JSON.stringify(made)})`);
		});
	}
});
