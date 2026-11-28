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
import { VOLUME_SUBPATH_ENGINE } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const real = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** The Docker Engine's major version, 0 when unknown; only read on a live run. */
const ENGINE = LIVE ? Number(/^(\d+)\./.exec(real("version", "--format", "{{.Server.Version}}").trim())?.[1] ?? 0) : 0;
/** How long the slowed `docker run` of the early case takes to make its container. */
const SLOW_SECONDS = 8;
/** How long each slowed `docker rm` of the slow-rm case takes before it runs: under the 30 s look-again window for one
 *  container, over it for the epoch file's five removed one after another. */
const RM_SECONDS = 8;
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

/** The docker a case's run finds first on PATH: it logs what a docker command is about to make to `log`, then runs the
 *  real docker. Its log, the real docker and the slowed create's and remove's seconds are written into it, not read from
 *  its environment: the provider starts docker with only the names docker reads (DOCKER_ENV_NAMES). */
const wrapperOf = ({ log, real: realDocker, slow, slowRm }) => `#!/usr/bin/env bash
if [ "\${1:-}" = "run" ] || [ "\${1:-}" = "create" ]; then
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--name" ]; then printf 'c %s\\n' "$arg" >> ${JSON.stringify(log)}; fi
    prev=$arg
  done
  # A slowed create: the container comes into being this long after the name is logged.
  sleep ${slow}
elif [ "\${1:-}" = "volume" ] && [ "\${2:-}" = "create" ]; then
  printf 'v %s\\n' "\${@: -1}" >> ${JSON.stringify(log)}
elif [ "\${1:-}" = "rm" ]; then
  # A slowed remove, as a loaded Docker host's: each docker rm takes this long more.
  sleep ${slowRm}
fi
exec ${JSON.stringify(realDocker)} "$@"
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

	/** Runs `file` as `node --test` does, cuts it off once one of its containers exists and it has logged at least `logged`
	 *  container names, and answers what is left and the names logged at the cut-off. */
	async function cutOff(file, how, logged = 1) {
		const log = join(dir, `${file}-${how}.log`);
		const early = how === "early";
		const bin = mkdtempSync(join(dir, `${file}-${how}-bin-`));
		writeFileSync(join(bin, "docker"), wrapperOf({ log, real: realDocker, slow: early ? SLOW_SECONDS : 0, slowRm: how === "slow-rm" ? RM_SECONDS : 0 }));
		chmodSync(join(bin, "docker"), 0o755);
		// DOCKER_NAME_LOG and REAL_DOCKER are the crash preload's, which runs in the file's own process.
		const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DOCKER_NAME_LOG: log, REAL_DOCKER: realDocker, AGENTRUN_COMPUTER_LIVE_DOCKER: "1" };
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
		let notYet = false;
		let atCut = [];
		while (!finished && Date.now() < bound) {
			const names = namesIn(log).containers;
			// Early: cut off as soon as a name is logged, while the slowed `docker run` has not made its container yet.
			if (early ? names.length > 0 : names.length >= logged && names.some(exists)) {
				seen = true;
				notYet = !names.some(exists);
				atCut = names;
				break;
			}
			await sleep(200);
		}
		for (const name of namesIn(log).containers) everything.containers.add(name);
		if (seen && how !== "crash") run.kill("SIGTERM");
		const exit = await Promise.race([ended, sleep(120_000, undefined, { ref: false }).then(() => undefined)]);
		if (exit === undefined) run.kill("SIGKILL");
		const made = namesIn(log);
		for (const name of made.containers) everything.containers.add(name);
		for (const name of made.volumes) everything.volumes.add(name);
		// `node --test` ends on the signal at once, and the file's own process, which got it from there, is still removing
		// what it made: look again for up to 30 s before calling what is there left behind.
		// A slowed create finishes after the cut-off: wait until it has, so a container made late is looked for.
		if (early) await sleep((SLOW_SECONDS + 6) * 1000);
		const gone = () => made.containers.every((name) => !exists(name)) && made.volumes.every((name) => !volumeExists(name));
		for (const until = Date.now() + 30_000; !gone() && Date.now() < until; ) await sleep(500);
		// A file that exits by itself may be over before a look finds its container: what it logged it made.
		return { notYet, seen: seen || (how === "crash" && made.containers.length > 0), atCut, exit, made, left: { containers: made.containers.filter(exists), volumes: made.volumes.filter(volumeExists) } };
	}

	for (const file of FILES) {
		// The volume file skips below the Docker Engine its subpath mount needs, and makes nothing there.
		const skip = file === "volume" && ENGINE < VOLUME_SUBPATH_ENGINE ? `Docker Engine <${VOLUME_SUBPATH_ENGINE} cannot mount a volume's subpath` : false;
		it(`${file}: after SIGTERM to node --test, none of its containers or volumes remains`, { skip }, async () => {
			const { seen, exit, made, left } = await cutOff(file, "sigterm");
			assert.equal(seen, true, `${file} made no container that existed within the bound (exit ${JSON.stringify(exit)}); it names ${JSON.stringify(made)}`);
			assert.notEqual(exit, undefined, `${file} did not end within 120 s of the SIGTERM`);
			assert.deepEqual(left, { containers: [], volumes: [] }, `left behind by ${file} (made ${JSON.stringify(made)})`);
		});
	}

	// The epoch file makes five computers at once. On a loaded host each docker rm takes seconds, and five of them one after
	// another outlast the window a single one fits in (CI run 46102077735 left three of the five). The cut waits for all
	// five names: cut off after fewer, the file never starts the rest, and that many slowed removals in a row fit the window.
	it(`epoch: with each docker rm slowed by ${RM_SECONDS} s, after SIGTERM to node --test none of its five containers remains`, async () => {
		const { seen, atCut, exit, made, left } = await cutOff("epoch", "slow-rm", 5);
		assert.equal(seen, true, `epoch did not log five container names, one of them made, within the bound (exit ${JSON.stringify(exit)}); it names ${JSON.stringify(made)}`);
		assert.equal(atCut.length, 5, `epoch had logged ${JSON.stringify(atCut)} at the cut-off, not its five computers`);
		assert.notEqual(exit, undefined, "epoch did not end within 120 s of the SIGTERM");
		assert.deepEqual(left, { containers: [], volumes: [] }, `left behind by epoch with a slow docker rm (made ${JSON.stringify(made)})`);
	});

	it("run-command: cut off before its container exists, the container made late is removed too", async () => {
		const { notYet, seen, exit, made, left } = await cutOff("run-command", "early");
		assert.equal(seen, true, `run-command logged no container name within the bound; it names ${JSON.stringify(made)}`);
		assert.equal(notYet, true, "the container existed at the cut-off, so the case did not cut off a create in progress");
		assert.notEqual(exit, undefined, "run-command did not end within 120 s of the SIGTERM");
		assert.deepEqual(left, { containers: [], volumes: [] }, `made after the cut-off and left behind (made ${JSON.stringify(made)})`);
	});

	for (const file of ["run-command", "provider"]) {
		it(`${file}: after its process exits outside a test, none of its containers or volumes remains`, async () => {
			const { seen, exit, made, left } = await cutOff(file, "crash");
			assert.equal(seen, true, `${file} made no container that existed within the bound (exit ${JSON.stringify(exit)}); it names ${JSON.stringify(made)}`);
			assert.notEqual(exit, undefined, `${file} did not end after its process exited`);
			assert.deepEqual(left, { containers: [], volumes: [] }, `left behind by ${file} (made ${JSON.stringify(made)})`);
		});
	}
});
