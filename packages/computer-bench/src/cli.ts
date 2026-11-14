#!/usr/bin/env node
// computer-bench's command line: validate suites, prove their checks (verify), run arms over them, and report. USAGE
// below says how. The fake backend runs the fake world with the fake agents (fake-right, fake-wrong, fake-null) as
// harnesses: a dry run at $0. Keys come from the environment, never from a flag: AGENTRUN_TOKEN for serve,
// ANTHROPIC_API_KEY or OPENROUTER_API_KEY for a judge.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { FAKE_AGENTS, fakeBackend } from "./fake-world.js";
import type { GradeWhen, Judge } from "./grader.js";
import { messagesJudge } from "./grader.js";
import { Store } from "./record.js";
import { buildReport, readResults, reportMarkdown } from "./report.js";
import type { Arm, Backend, Result } from "./runner.js";
import { runBench } from "./runner.js";
import type { Split, Task } from "./task.js";
import { loadSuite, TaskError } from "./task.js";
import { serveBackend } from "./serve.js";
import { proofMarkdown, verifySuite } from "./verify.js";

const USAGE = `usage:
  computer-bench validate <suite>...
  computer-bench verify --suite <dir> --out <dir> [--seeds 1,2] [--task id,...] [--split dev|heldout]
                        [--backend fake|serve --serve <url> --arms <arms.json>]
  computer-bench run --suite <dir> --arms <arms.json> --out <dir> [--seeds 1,2,3] [--task id,...] [--split dev|heldout]
                     [--backend fake|serve --serve <url>] [--mode agent|null|oracle] [--grade auto|always|never]
                     [--judge anthropic:<model>|openrouter:<model>] [--parallel N] [--retries N]
  computer-bench report <out> [--split dev|heldout]`;

class Usage extends Error {}

const OPTIONS = {
	suite: { type: "string", multiple: true },
	arms: { type: "string" },
	out: { type: "string" },
	seeds: { type: "string" },
	task: { type: "string" },
	split: { type: "string" },
	backend: { type: "string" },
	serve: { type: "string" },
	mode: { type: "string" },
	grade: { type: "string" },
	judge: { type: "string" },
	parallel: { type: "string" },
	retries: { type: "string" },
} as const;

function need(value: string | undefined, name: string): string {
	if (!value) throw new Usage(`--${name} is needed`);
	return value;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
	if (value === undefined) return undefined;
	if (!(allowed as readonly string[]).includes(value)) throw new Usage(`--${name} is one of ${allowed.join(", ")}`);
	return value as T;
}

function count(value: string | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw new Usage(`--${name} is a whole number`);
	return n;
}

function seedsOf(value: string | undefined): number[] {
	const seeds = (value ?? "1").split(",").map((one) => Number(one.trim()));
	if (seeds.some((seed) => !Number.isInteger(seed) || seed < 0)) throw new Usage("--seeds is a list of whole numbers, such as 1,2,3");
	return seeds;
}

/** The suites' tasks, narrowed by --task and --split. */
function tasksOf(suites: readonly string[], task: string | undefined, split: string | undefined): Task[] {
	const wanted = task ? new Set(task.split(",").map((one) => one.trim())) : undefined;
	const onSplit = oneOf<Split>(split, ["dev", "heldout"], "split");
	const tasks = suites.flatMap((suite) => loadSuite(suite)).filter((one) => (!wanted || wanted.has(one.spec.id)) && (!onSplit || one.spec.split === onSplit));
	const unknown = [...(wanted ?? [])].filter((id) => !tasks.some((one) => one.spec.id === id));
	if (unknown.length > 0) throw new Usage(`no task ${unknown.join(", ")} in ${suites.join(", ")}${onSplit ? ` on the ${onSplit} split` : ""}`);
	if (tasks.length === 0) throw new Usage("no tasks to run");
	return tasks;
}

function armsOf(path: string): Arm[] {
	const arms = JSON.parse(readFileSync(path, "utf8")) as Arm[];
	if (!Array.isArray(arms) || arms.length === 0) throw new Usage(`${path} holds no arms: it is a JSON list of {id, harness, surface, model}`);
	for (const arm of arms) {
		if (!arm.id || !arm.harness || !arm.model || (arm.surface !== "code" && arm.surface !== "tools")) throw new Usage(`${path}: an arm needs id, harness, model and surface code|tools: ${JSON.stringify(arm)}`);
	}
	if (new Set(arms.map((arm) => arm.id)).size !== arms.length) throw new Usage(`${path}: arm ids are not unique`);
	return arms;
}

/** fake: the fake world and the fake agents. serve: an AgentRun serve at --serve, with AGENTRUN_TOKEN from the
 *  environment (it needs the held-computer routes README.md lists). */
function backendOf(name: string | undefined, url: string | undefined): Backend {
	if ((name ?? "fake") === "fake") return fakeBackend({ agents: FAKE_AGENTS });
	if (name === "serve") {
		const token = process.env.AGENTRUN_TOKEN;
		if (!url) throw new Usage("--backend serve needs --serve <its API root, such as http://127.0.0.1:8080/v2>");
		if (!token) throw new Usage("--backend serve needs AGENTRUN_TOKEN in the environment");
		return serveBackend({ baseUrl: url.replace(/\/+$/, ""), token });
	}
	throw new Usage(`no backend ${name}: fake or serve`);
}

/** A judge by provider and model; its key from the environment, so it never sits in a command line or a log. */
function judgeOf(spec: string | undefined): Judge | undefined {
	if (!spec) return undefined;
	const at = spec.indexOf(":");
	const provider = spec.slice(0, at);
	const model = spec.slice(at + 1);
	if (at < 1 || !model) throw new Usage("--judge is anthropic:<model> or openrouter:<model>");
	if (provider === "anthropic") {
		const apiKey = process.env.ANTHROPIC_API_KEY;
		if (!apiKey) throw new Usage("--judge anthropic: needs ANTHROPIC_API_KEY in the environment");
		return messagesJudge({ model, endpoint: "https://api.anthropic.com/v1/messages", apiKey, auth: "x-api-key" });
	}
	if (provider === "openrouter") {
		const apiKey = process.env.OPENROUTER_API_KEY;
		if (!apiKey) throw new Usage("--judge openrouter: needs OPENROUTER_API_KEY in the environment");
		return messagesJudge({ model, endpoint: "https://openrouter.ai/api/v1/messages", apiKey, auth: "bearer" });
	}
	throw new Usage(`no judge provider ${provider}: anthropic or openrouter`);
}

/** Stops the run on the first SIGINT; results so far stay written. */
function interrupt(): AbortSignal {
	const controller = new AbortController();
	process.once("SIGINT", () => {
		process.stderr.write("stopping: the episodes running now end, release their computers and are written\n");
		controller.abort(new Error("stopped"));
	});
	return controller.signal;
}

const line = (result: Result) =>
	`${result.outcome.padEnd(7)} ${result.task} seed ${result.seed} ${result.arm} #${result.attempt}${result.why ? `: ${result.why}` : ""}${result.queue ? ` (queued: ${result.queue})` : ""}\n`;

function validate(paths: readonly string[]): number {
	if (paths.length === 0) throw new Usage("validate needs a suite folder");
	let bad = 0;
	for (const path of paths) {
		try {
			const tasks = loadSuite(path);
			const dev = tasks.filter((task) => task.spec.split === "dev").length;
			process.stdout.write(`${path}: ${tasks.length} tasks ok (${dev} dev, ${tasks.length - dev} heldout)\n`);
		} catch (error) {
			bad += 1;
			process.stdout.write(`${path}: ${error instanceof TaskError ? `${error.message}\n  ${error.problems.join("\n  ")}` : String(error)}\n`);
		}
	}
	return bad === 0 ? 0 : 1;
}

async function verify(values: Record<string, unknown>): Promise<number> {
	const suites = values.suite as string[] | undefined;
	if (!suites?.length) throw new Usage("--suite is needed");
	const out = need(values.out as string | undefined, "out");
	const proofs = await verifySuite({
		tasks: tasksOf(suites, values.task as string | undefined, values.split as string | undefined),
		seeds: seedsOf(values.seeds as string | undefined),
		backend: backendOf(values.backend as string | undefined, values.serve as string | undefined),
		// On serve, a computer is claimed through a run of an agent: the first arm's, whose agent never starts.
		...(values.arms ? { arm: armsOf(values.arms as string)[0] } : {}),
		nullStore: new Store(join(out, "null")),
		oracleStore: new Store(join(out, "oracle")),
		parallel: count(values.parallel as string | undefined, "parallel"),
		signal: interrupt(),
	});
	const markdown = proofMarkdown(proofs);
	writeFileSync(join(out, "verify.md"), markdown);
	writeFileSync(join(out, "verify.json"), `${JSON.stringify(proofs, null, 2)}\n`);
	process.stdout.write(markdown);
	return proofs.every((proof) => proof.untouched === "fails" && (proof.solved === "passes" || proof.solved === "no oracle")) ? 0 : 1;
}

async function run(values: Record<string, unknown>): Promise<number> {
	const suites = values.suite as string[] | undefined;
	if (!suites?.length) throw new Usage("--suite is needed");
	const out = need(values.out as string | undefined, "out");
	const results = await runBench({
		tasks: tasksOf(suites, values.task as string | undefined, values.split as string | undefined),
		arms: armsOf(need(values.arms as string | undefined, "arms")),
		seeds: seedsOf(values.seeds as string | undefined),
		backend: backendOf(values.backend as string | undefined, values.serve as string | undefined),
		store: new Store(out),
		judge: judgeOf(values.judge as string | undefined),
		grade: oneOf<GradeWhen>(values.grade as string | undefined, ["auto", "always", "never"], "grade"),
		mode: oneOf(values.mode as string | undefined, ["agent", "null", "oracle"] as const, "mode"),
		parallel: count(values.parallel as string | undefined, "parallel"),
		retries: count(values.retries as string | undefined, "retries"),
		onResult: (result) => process.stderr.write(line(result)),
		signal: interrupt(),
	});
	const scored = results.filter((result) => result.scored && !result.rerun);
	process.stdout.write(`${results.length} attempts, ${scored.length} scored, ${scored.filter((result) => result.outcome === "pass").length} passed; results in ${join(out, "results.jsonl")}\n`);
	return 0;
}

function report(values: Record<string, unknown>, positionals: readonly string[]): number {
	const out = positionals[0];
	if (!out) throw new Usage("report needs the run's out folder");
	const { results, labels, bench } = readResults(out);
	const split = oneOf<Split>(values.split as string | undefined, ["dev", "heldout"], "split");
	const built = buildReport(results, labels, { split, bench });
	const markdown = reportMarkdown(built);
	const suffix = split ? `-${split}` : "";
	writeFileSync(join(out, `report${suffix}.md`), markdown);
	writeFileSync(join(out, `report${suffix}.json`), `${JSON.stringify(built, null, 2)}\n`);
	process.stdout.write(markdown);
	return 0;
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	const { values, positionals } = parseArgs({ args: [...rest], options: OPTIONS, allowPositionals: true, strict: true });
	switch (command) {
		case "validate":
			return validate(positionals);
		case "verify":
			return verify(values);
		case "run":
			return run(values);
		case "report":
			return report(values, positionals);
		default:
			throw new Usage(command ? `no command ${command}` : "a command is needed");
	}
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		if (error instanceof Usage || (error as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
			process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
			process.exitCode = 2;
			return;
		}
		// A fatal error (serve lacks a route) says all it means in its message; a stack would bury it.
		const fatal = (error as { fatal?: boolean }).fatal === true;
		process.stderr.write(`${error instanceof Error ? (fatal ? error.message : (error.stack ?? error.message)) : String(error)}\n`);
		process.exitCode = 1;
	},
);
