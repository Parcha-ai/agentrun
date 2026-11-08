// A fake docker program for the image tests (src/docker/image.ts): it answers `image inspect`, `build` and `pull` as the
// docker CLI does, keeps its images as files, and records each call. No Docker is reached; nothing is pulled or built.
// Marks are files in its state directory, made with mark(name, text) and removed with clear(name):
//   build-hold, pull-hold, inspect-hold   the step waits, once called, while the mark is there (at most a minute)
//   build-fail, pull-fail, inspect-fail   the step fails with exit 1, the mark's text on stderr
//   then-inspect-hold                     a build or pull that fails marks inspect-hold, so the inspect after it waits
//   podman-words                          a missing image is Podman's `image not known`, not Docker's `No such image`
//   build-race, pull-race                 another process tags the image first: it is there, and this step fails as
//                                         Docker 29's image store says it (`already exists`)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const dirs = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PROGRAM = `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const state = __STATE__;
const args = process.argv.slice(2);
appendFileSync(join(state, "calls.jsonl"), JSON.stringify(args) + "\\n");
const file = (name) => join(state, "images", encodeURIComponent(name) + ".json");
const marked = (name) => existsSync(join(state, name));
const held = (step, then) => {
	const bound = Date.now() + 60_000;
	const wait = () => (marked(step + "-hold") && Date.now() < bound ? setTimeout(wait, 20) : then());
	wait();
};
const failed = (step) => {
	if (!marked(step + "-fail")) return false;
	process.stderr.write(readFileSync(join(state, step + "-fail"), "utf8") + "\\n");
	process.exitCode = 1;
	if (step !== "inspect" && marked("then-inspect-hold")) writeFileSync(join(state, "inspect-hold"), "");
	return true;
};
const raced = (name, labels) => {
	if (!marked((args[0] === "build" ? "build" : "pull") + "-race")) return false;
	writeFileSync(file(name), JSON.stringify({ labels }));
	process.stderr.write('ERROR: failed to build: failed to solve: image "docker.io/library/' + name + '": already exists\\n');
	process.exitCode = 1;
	return true;
};
const missing = (name) => {
	process.stderr.write(marked("podman-words") ? "Error: " + name + ": image not known\\n" : "Error response from daemon: No such image: " + name + "\\n");
	process.exitCode = 1;
};
if (args[0] === "image" && args[1] === "inspect") {
	const name = args[args.length - 1];
	held("inspect", () => {
		if (failed("inspect")) return;
		if (!existsSync(file(name))) return missing(name);
		process.stdout.write(JSON.stringify(JSON.parse(readFileSync(file(name), "utf8")).labels) + "\\n");
	});
} else if (args[0] === "build") {
	const recipe = readFileSync(0, "utf8");
	const labels = {};
	let tag;
	for (let i = 1; i < args.length; i++) {
		if (args[i] === "--label") { const l = args[++i]; labels[l.slice(0, l.indexOf("="))] = l.slice(l.indexOf("=") + 1); }
		else if (args[i] === "--tag") tag = args[++i];
	}
	appendFileSync(join(state, "builds.jsonl"), JSON.stringify({ tag, labels, recipe, context: args[args.length - 1], pid: process.pid }) + "\\n");
	held("build", () => {
		if (raced(tag, labels)) return;
		if (failed("build")) return;
		writeFileSync(file(tag), JSON.stringify({ labels }));
		process.stdout.write("sha256:" + "0".repeat(64) + "\\n");
	});
} else if (args[0] === "pull") {
	const name = args[args.length - 1];
	appendFileSync(join(state, "pulls.jsonl"), JSON.stringify({ name, pid: process.pid }) + "\\n");
	held("pull", () => {
		if (raced(name, {})) return;
		if (failed("pull")) return;
		writeFileSync(file(name), JSON.stringify({ labels: {} }));
		process.stdout.write(name + "\\n");
	});
} else {
	process.stderr.write("the fake docker answers image inspect, build and pull, not " + args[0] + "\\n");
	process.exitCode = 125;
}
`;

const lines = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);

/**
 * A fake docker program in a fresh directory: `docker` is its path, for ensureImage's or the provider's docker option.
 * `keep(name, labels)` gives it an image; `calls()`, `builds()` and `pulls()` read what it was asked.
 */
export function fakeImageDocker(marks = {}) {
	const dir = mkdtempSync(join(tmpdir(), "computer-fake-image-"));
	dirs.push(dir);
	const state = join(dir, "state");
	mkdirSync(join(state, "images"), { recursive: true });
	const docker = join(dir, "docker");
	writeFileSync(docker, `#!${process.execPath}\n${PROGRAM.replace("__STATE__", JSON.stringify(state))}`, { mode: 0o755 });
	const mark = (name, text = "") => writeFileSync(join(state, name), text);
	for (const [name, text] of Object.entries(marks)) mark(name, text);
	return {
		docker,
		state,
		mark,
		clear: (name) => rmSync(join(state, name), { force: true }),
		keep: (name, labels) => writeFileSync(join(state, "images", `${encodeURIComponent(name)}.json`), JSON.stringify({ labels })),
		has: (name) => existsSync(join(state, "images", `${encodeURIComponent(name)}.json`)),
		calls: () => lines(join(state, "calls.jsonl")),
		builds: () => lines(join(state, "builds.jsonl")),
		pulls: () => lines(join(state, "pulls.jsonl")),
	};
}

/** Whether a process is still there. */
export const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** Waits until done() holds, at most ms, failing in words naming what. */
export async function until(done, what, ms = 20_000) {
	const end = Date.now() + ms;
	while (!(await done())) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
