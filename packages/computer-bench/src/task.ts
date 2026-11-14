// Tasks are data: a folder with task.json, and optionally rubric.md and files its calls inline ({{file:NAME}}). This
// module loads a task, checks it against the JSON Schema (schema/task.schema.json) and the rules a schema can't say,
// and resolves it for one seed: each param picked by the seed alone, every placeholder filled. Nothing here knows an OS
// or an app.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { groupOf, type Json, type JsonObject, PROTOCOL_METHODS } from "./wire.js";

export type Split = "dev" | "heldout";
export type ParamSpec = { pick: (string | number | boolean | Record<string, string | number | boolean>)[] } | { int: [number, number] };

export interface Call {
	method: string;
	params: JsonObject;
	why?: string;
	allow?: string[];
	exit?: number[];
}

export interface Match {
	equals?: string;
	contains?: string;
	matches?: string;
	oneOf?: string[];
	empty?: true;
	flags?: string;
	not?: boolean;
	trim?: boolean;
	caseless?: boolean;
}

export interface UiQuery {
	role?: string;
	name?: Match;
	value?: Match;
	flags?: string[];
}

interface CheckBase {
	id: string;
	why: string;
}
export type Check =
	| (CheckBase & { kind: "exec"; argv: string[]; timeoutMs?: number; exit?: number; stdout?: Match; stderr?: Match })
	| (CheckBase & { kind: "file"; path: string; exists?: boolean; text?: Match })
	| (CheckBase & { kind: "ui"; app?: string; find: UiQuery; min?: number; max?: number })
	| (CheckBase & { kind: "app"; front?: string; installed?: string })
	| (CheckBase & { kind: "answer"; text: Match });

export interface Budget {
	steps: number;
	usd: number;
	wall_s: number;
}

export interface Needs {
	os: string;
	kind: string;
	/** Groups the computer must have because the task can't be done without them; never which tools the agent uses. */
	groups?: string[];
	/** Each entry must be installed; a list is alternatives, any one will do. A precondition, read once per computer. */
	apps?: (string | string[])[];
	/** Probes (checks on the bench's channel) of what the computer must be able to do; the check's id names it. */
	capabilities?: Check[];
	osVersion?: string;
}

/** task.json as written. */
export interface TaskSpec {
	id: string;
	version: number;
	title: string;
	split: Split;
	source?: { suite: string; id: string; revision?: string; licence?: string; changes?: string };
	tags?: string[];
	needs: Needs;
	params?: Record<string, ParamSpec>;
	setup?: Call[];
	instruction: string;
	/** deny: done through the UI; the agent gets no shell or exec, and the oracle only the agent's groups. Default allow. */
	exec?: "allow" | "deny";
	budget: Budget;
	checks: Check[];
	sufficient?: boolean;
	rubric?: string;
	teardown?: Call[];
	oracle?: Call[];
}

/** A task loaded from its folder. */
export interface Task {
	spec: TaskSpec;
	dir: string;
	/** sha256 over the folder's files (names and bytes, in name order): what a result is compared at, with the version. */
	sha256: string;
	/** The rubric's text, unresolved, when the task has one. */
	rubric?: string;
	/** Every file of the folder by name, for {{file:NAME}}. */
	files: Record<string, string>;
	/** The groups the bench's own channel needs on every run: the capability probes', setup's, the checks' and teardown's. */
	benchGroups: string[];
	/** The groups the oracle needs besides, asked of a computer only when the oracle runs. */
	oracleGroups: string[];
}

/** A task resolved for one seed: what one run of it does. */
export interface ResolvedTask {
	task: Task;
	seed: number;
	nonce: string;
	params: Record<string, Json>;
	instruction: string;
	setup: Call[];
	checks: Check[];
	teardown: Call[];
	oracle: Call[];
	rubric?: string;
	budget: Budget;
	sufficient: boolean;
}

export class TaskError extends Error {
	constructor(
		readonly where: string,
		readonly problems: string[],
	) {
		super(`${where}: ${problems.join("; ")}`);
	}
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** The schema, beside dist/ and src/ in the package. */
export const SCHEMA_PATH = resolve(HERE, "../schema/task.schema.json");

let compiled: ReturnType<Ajv2020["compile"]> | undefined;
function schemaCheck(value: unknown): ErrorObject[] {
	if (!compiled) {
		const ajv = new Ajv2020({ allErrors: true, strict: false });
		compiled = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));
	}
	return compiled(value) ? [] : [...(compiled.errors ?? [])];
}

/** Ajv's errors, the deepest first and without the oneOf noise around them, in words. */
function schemaWords(errors: ErrorObject[]): string[] {
	const useful = errors.filter((e) => e.keyword !== "oneOf" && e.keyword !== "anyOf" && e.keyword !== "if");
	const kept = useful.length > 0 ? useful : errors;
	const named = (e: ErrorObject) => {
		const params = e.params as Record<string, unknown>;
		const name = params.additionalProperty ?? params.propertyName;
		return name === undefined ? "" : ` (${String(name)})`;
	};
	return [...new Set(kept.map((e) => `${e.instancePath || "/"} ${e.message ?? e.keyword}${named(e)}`))].slice(0, 12);
}

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?|file:[A-Za-z0-9._-]+)\s*\}\}/g;

/** Every placeholder in a JSON value's strings. */
function placeholders(value: unknown, into: Set<string> = new Set()): Set<string> {
	if (typeof value === "string") for (const match of value.matchAll(PLACEHOLDER)) into.add(match[1] as string);
	else if (Array.isArray(value)) for (const one of value) placeholders(one, into);
	else if (value && typeof value === "object") for (const one of Object.values(value)) placeholders(one, into);
	return into;
}

/** Reads the folder's files: task.json, the rubric and anything a call inlines. Folders inside are not read. */
function readFolder(dir: string): Record<string, string> {
	const files: Record<string, string> = {};
	for (const name of readdirSync(dir).sort()) {
		const path = join(dir, name);
		if (statSync(path).isFile()) files[name] = readFileSync(path, "utf8");
	}
	return files;
}

function folderSha(files: Record<string, string>): string {
	const hash = createHash("sha256");
	for (const name of Object.keys(files).sort()) hash.update(`${name}\0${files[name]}\0`);
	return hash.digest("hex");
}

const BUILTIN = new Set(["seed", "nonce"]);
/** The groups an exec-deny task's oracle may use: the agent's own, so the oracle proves the path the agent must take. */
const DENY_ORACLE_GROUPS: ReadonlySet<string> = new Set(["ui", "input", "screen", "apps"]);

/** The rules the schema can't say: placeholders that name nothing, files that aren't there, ids twice, bad patterns. */
function ruleProblems(spec: TaskSpec, files: Record<string, string>): string[] {
	const problems: string[] = [];
	const params = spec.params ?? {};
	for (const [name, param] of Object.entries(params)) {
		if ("int" in param && param.int[0] > param.int[1]) problems.push(`param ${name}: int's first value is above its second`);
		if ("pick" in param) {
			const objects = param.pick.filter((one) => typeof one === "object");
			if (objects.length > 0 && objects.length !== param.pick.length) problems.push(`param ${name}: pick holds objects and scalars; use one or the other`);
			const fields = objects.map((one) => Object.keys(one).sort().join(","));
			if (new Set(fields).size > 1) problems.push(`param ${name}: every object it picks must have the same fields`);
		}
	}
	const used = placeholders({ setup: spec.setup, instruction: spec.instruction, checks: spec.checks, teardown: spec.teardown, oracle: spec.oracle });
	for (const name of spec.rubric && files[spec.rubric] ? placeholders(files[spec.rubric]) : []) used.add(name);
	const inlined = [...used].filter((name) => name.startsWith("file:")).map((name) => name.slice(5));
	for (const file of inlined) {
		if (files[file] === undefined) problems.push(`{{file:${file}}} names no file of the task's folder`);
		else for (const name of placeholders(files[file])) if (!name.startsWith("file:")) used.add(name);
	}
	for (const name of used) {
		if (name.startsWith("file:")) continue;
		const [head, field] = name.split(".") as [string, string | undefined];
		if (BUILTIN.has(head)) {
			if (field) problems.push(`{{${name}}}: ${head} has no fields`);
			continue;
		}
		const param = params[head];
		if (!param) {
			problems.push(`{{${name}}} names no param`);
			continue;
		}
		const objects = "pick" in param && param.pick.every((one) => typeof one === "object");
		if (field && !objects) problems.push(`{{${name}}}: ${head}'s values have no fields`);
		if (!field && objects) problems.push(`{{${name}}}: ${head}'s values are objects; name a field, such as {{${head}.${Object.keys(param.pick[0] as object)[0]}}}`);
		if (field && objects && !(field in (param.pick[0] as object))) problems.push(`{{${name}}}: ${head}'s values have no field ${field}`);
	}
	if (spec.rubric !== undefined && files[spec.rubric] === undefined) problems.push(`rubric ${spec.rubric} is not in the task's folder`);
	const ids = spec.checks.map((check) => check.id);
	for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`check id ${id} is used twice`);
	const matches = (match: Match | undefined, where: string) => {
		if (match?.matches === undefined) return;
		try {
			new RegExp(match.matches, match.flags);
		} catch (error) {
			problems.push(`${where}: ${(error as Error).message}`);
		}
	};
	// One set of rules for a check and a probe, which is written as a check.
	const checkRules = (check: Check, label: string) => {
		if (check.kind === "exec") {
			matches(check.stdout, `${label} stdout`);
			matches(check.stderr, `${label} stderr`);
		} else if (check.kind === "file") {
			matches(check.text, `${label} text`);
			if (check.exists === false && check.text) problems.push(`${label}: a file that must not exist has no text to match`);
		} else if (check.kind === "ui") {
			matches(check.find.name, `${label} find.name`);
			matches(check.find.value, `${label} find.value`);
			if (check.min !== undefined && check.max !== undefined && check.min > check.max) problems.push(`${label}: min is above max`);
		} else if (check.kind === "answer") matches(check.text, `${label} text`);
	};
	for (const check of spec.checks) checkRules(check, `check ${check.id}`);
	const capabilities = spec.needs.capabilities ?? [];
	const probeIds = capabilities.map((probe) => probe.id);
	for (const id of new Set(probeIds.filter((id, i) => probeIds.indexOf(id) !== i))) problems.push(`capability ${id} is probed twice`);
	for (const probe of capabilities) {
		if (probe.kind === "answer") problems.push(`capability ${probe.id} is an answer check: a probe reads the computer, never an agent's answer`);
		else checkRules(probe, `capability ${probe.id}`);
		// A probe's verdict is remembered for every seed of the bench run, so it can't depend on one.
		for (const name of placeholders(probe)) problems.push(`capability ${probe.id}: a probe is the same for every seed, so it holds no {{${name}}}`);
	}
	const calls = [...(spec.setup ?? []), ...(spec.teardown ?? []), ...(spec.oracle ?? [])];
	for (const call of calls) if (call.exit && call.method !== "exec.run") problems.push(`${call.method}: exit is for exec.run only`);
	for (const call of calls) {
		if (PROTOCOL_METHODS.has(call.method)) continue;
		const wire = call.method.startsWith("processes.") ? ` (the wire's are process.start, process.read, process.wait, ...: processes.start is code mode's name)` : "";
		problems.push(`${call.method} is not a method of the computer protocol${wire}`);
	}
	if (spec.exec === "deny") {
		(spec.oracle ?? []).forEach((call, i) => {
			const group = groupOf(call.method);
			if (call.method === "hello" || call.method === "ping" || (group !== undefined && DENY_ORACLE_GROUPS.has(group))) return;
			problems.push(`exec deny: the oracle's call ${i + 1}, ${call.method}, is the ${group ?? "daemon"} group's; an exec-deny oracle uses only ui, input, screen and apps (apps.install excluded), the path the agent must take`);
		});
	}
	if (spec.sufficient === false && spec.rubric === undefined && files["rubric.md"] === undefined) problems.push("a task whose checks are not sufficient needs a rubric for the grader");
	return problems;
}

/** The groups a check reads through. */
export function checkGroup(check: Check): string | undefined {
	switch (check.kind) {
		case "exec":
			return "exec";
		case "file":
			return "files";
		case "ui":
			return "ui";
		case "app":
			return "apps";
		case "answer":
			return undefined;
	}
}

/** Loads one task folder, or throws a TaskError listing every problem. */
export function loadTask(dir: string): Task {
	const where = resolve(dir);
	const files = readFolder(where);
	if (files["task.json"] === undefined) throw new TaskError(where, ["no task.json"]);
	let raw: unknown;
	try {
		raw = JSON.parse(files["task.json"]);
	} catch (error) {
		throw new TaskError(where, [`task.json is not JSON: ${(error as Error).message}`]);
	}
	const errors = schemaCheck(raw);
	if (errors.length > 0) throw new TaskError(where, schemaWords(errors));
	const spec = raw as TaskSpec;
	const rubricName = spec.rubric ?? (files["rubric.md"] !== undefined ? "rubric.md" : undefined);
	const problems = ruleProblems({ ...spec, rubric: rubricName }, files);
	if (problems.length > 0) throw new TaskError(where, problems);
	const groupsOf = (groups: (string | undefined)[]) => [...new Set(groups.filter((g): g is string => g !== undefined))].sort();
	const benchGroups = groupsOf([...[...(spec.setup ?? []), ...(spec.teardown ?? [])].map((call) => groupOf(call.method)), ...spec.checks.map(checkGroup), ...(spec.needs.capabilities ?? []).map(checkGroup)]);
	const oracleGroups = groupsOf((spec.oracle ?? []).map((call) => groupOf(call.method))).filter((group) => !benchGroups.includes(group));
	return { spec, dir: where, sha256: folderSha(files), rubric: rubricName ? files[rubricName] : undefined, files, benchGroups, oracleGroups };
}

/** A suite: every folder under `dir` that holds a task.json, at any depth, in path order. Ids must be unique. */
export function loadSuite(dir: string): Task[] {
	const tasks: Task[] = [];
	const problems: string[] = [];
	const walk = (at: string) => {
		if (existsSync(join(at, "task.json"))) {
			try {
				tasks.push(loadTask(at));
			} catch (error) {
				problems.push(error instanceof TaskError ? error.message : String(error));
			}
			return;
		}
		for (const name of readdirSync(at).sort()) {
			const path = join(at, name);
			if (statSync(path).isDirectory()) walk(path);
		}
	};
	walk(resolve(dir));
	const ids = tasks.map((task) => task.spec.id);
	for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) problems.push(`task id ${id} is in two folders`);
	if (problems.length > 0) throw new TaskError(resolve(dir), problems);
	return tasks;
}

/** A number from 0 to 1, fixed by its key alone. */
function unit(key: string): number {
	return createHash("sha256").update(key).digest().readUInt32BE(0) / 2 ** 32;
}

/** The value a seed picks for a param: from the task id, the seed and the param's name, so adding a param moves none
 *  of the others, and every arm gets the same value (paired seeds). */
export function pickParam(taskId: string, seed: number, name: string, spec: ParamSpec): Json {
	const at = unit(`${taskId}\0${seed}\0${name}`);
	if ("pick" in spec) return spec.pick[Math.floor(at * spec.pick.length)] as Json;
	const [low, high] = spec.int;
	return low + Math.floor(at * (high - low + 1));
}

export const nonceOf = (taskId: string, seed: number): string => createHash("sha256").update(`${taskId}\0${seed}\0nonce`).digest("hex").slice(0, 6);

/** Fills a string's placeholders. The result is always a string: an argv word, a path or a text to match. */
function fill(text: string, values: (name: string) => Json): string {
	return text.replace(PLACEHOLDER, (_, name: string) => String(values(name)));
}

function fillAll<T>(value: T, values: (name: string) => Json): T {
	if (typeof value === "string") return fill(value, values) as T;
	if (Array.isArray(value)) return value.map((one) => fillAll(one, values)) as T;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, fillAll(one, values)])) as T;
	return value;
}

/** The task for one seed. */
export function resolveTask(task: Task, seed: number): ResolvedTask {
	const { spec } = task;
	const params: Record<string, Json> = {};
	for (const [name, param] of Object.entries(spec.params ?? {})) params[name] = pickParam(spec.id, seed, name, param);
	const nonce = nonceOf(spec.id, seed);
	const plain = (name: string): Json => {
		if (name === "seed") return seed;
		if (name === "nonce") return nonce;
		const [head, field] = name.split(".") as [string, string | undefined];
		const value = params[head];
		if (value === undefined) throw new TaskError(task.dir, [`{{${name}}} names no param`]);
		return field ? ((value as JsonObject)[field] as Json) : value;
	};
	const values = (name: string): Json => {
		if (!name.startsWith("file:")) return plain(name);
		const text = task.files[name.slice(5)];
		if (text === undefined) throw new TaskError(task.dir, [`{{${name}}} names no file`]);
		return fill(text, (inner) => (inner.startsWith("file:") ? `{{${inner}}}` : plain(inner)));
	};
	return {
		task,
		seed,
		nonce,
		params,
		instruction: fill(spec.instruction, values),
		setup: fillAll(spec.setup ?? [], values),
		checks: fillAll(spec.checks, values),
		teardown: fillAll(spec.teardown ?? [], values),
		oracle: fillAll(spec.oracle ?? [], values),
		rubric: task.rubric === undefined ? undefined : fill(task.rubric, values),
		budget: spec.budget,
		sufficient: spec.sufficient ?? true,
	};
}
