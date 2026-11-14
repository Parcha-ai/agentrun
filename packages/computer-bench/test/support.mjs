// What the tests share: the package's folders, a fresh store per test, a run's record read back, and the fake suite.
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSuite, Store } from "../dist/index.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SUITES = join(ROOT, "suites");
export const FAKE = join(SUITES, "fake");

export const tmp = (prefix = "cb-") => mkdtempSync(join(tmpdir(), prefix));
export const store = () => new Store(tmp());

/** The fake suite's tasks, or those of the ids given, in that order. */
export function fakeTasks(...ids) {
	const all = loadSuite(FAKE);
	return ids.length === 0 ? all : ids.map((id) => all.find((task) => task.spec.id === id) ?? assertNever(id));
}

function assertNever(id) {
	throw new Error(`no fake task ${id}`);
}

/** An arm. Its surface is "tools" unless given: a test's own agent calls the computer one method at a time. */
export const arm = (harness, id = harness, surface = "tools") => ({ id, harness, surface, model: "fake" });

/** A task with some of its spec's fields changed (exec, budget), its folder and hash as they were. */
export const withSpec = (task, change) => ({ ...task, spec: { ...task.spec, ...change } });

export const jsonl = (path) =>
	readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

/** Every entry of a run's record, by the run id a result names. */
export const recordOf = (s, run) => jsonl(join(s.runs, `${run}.jsonl`));

export const runFiles = (s) => readdirSync(s.runs);
