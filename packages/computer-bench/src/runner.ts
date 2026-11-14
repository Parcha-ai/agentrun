// The runner: generic and policy-free. For every task × seed × arm it opens an episode (a computer claimed for the
// run, and the agent that will drive it), checks the computer's hello against the task's needs, sets the task up, runs
// the agent under its budget, runs the checks against the computer's real state BEFORE it is released, tears down,
// releases, then grades (the grader reads what the record kept, so no computer waits on a model). Arms see the same tasks and seeds (paired); an infra outcome is run again and never scored.
// What a computer or a harness is lives behind Backend; what a task is lives in its folder.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CheckResult, nodeLine, nodeMatches, type ObservedNode, runChecks, type Stage1, stage1Of } from "./checks.js";
import { combine, GRADER_STEPS, type GradeWhen, type GraderInput, type GraderVerdict, type Judge, wantsGrader } from "./grader.js";
import { type ComputerIdentity, ENTRY, imageType, type RunHeader, type RunRecord, type Step, type Store } from "./record.js";
import { Frames, frameSourceOf, tap } from "./tap.js";
import { type Call, type ResolvedTask, resolveTask, type Task, type UiQuery } from "./task.js";
import { fromBase64, type Hello, hasGroup, type Json, type JsonObject, type Wire, type WireResult } from "./wire.js";

export const BENCH_VERSION = "0.1.0";

/** One arm: what is compared. */
export interface Arm {
	id: string;
	harness: string;
	/** "code": code mode over one computer object; "tools": the per-step computer_* tools. */
	surface: "code" | "tools";
	model: string;
	/** The thinking level (serve's definition field `thinking`). */
	effort?: string;
	/** Anything else the backend passes to the harness as it is. */
	options?: Record<string, Json>;
}

/** How the agent's part of a run ended, as its driver says. */
export interface AgentResult {
	/** done: it stopped by itself. budget: a budget stopped it. error: it failed (scored as a fail). infra: something
	 *  under it failed (a model endpoint's 5xx, a lost runner): run again, never scored. refused: it could not start. */
	outcome: "done" | "budget" | "error" | "infra" | "refused";
	answer?: string;
	message?: string;
	cost_usd?: number;
	tokens?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	turns?: number;
	/** sha256 of what the agent was given. */
	given?: RunHeader["given"];
	/** Where its transcript is, when the backend keeps one (a serve run id, a file). */
	transcript?: string;
}

export interface AgentRequest {
	task: ResolvedTask;
	arm: Arm;
	instruction: string;
	budget: ResolvedTask["budget"];
	/** Ends at the wall budget, or when the step budget is spent, or when the bench run is stopped. */
	signal: AbortSignal;
	/** The agent's wire: route every one of the agent's computer calls through it (it records, budgets and grants).
	 *  A backend whose steps are recorded elsewhere (serve's journal) reports them with onStep instead. */
	tap(wire: Wire): Wire;
	onStep(step: Omit<Step, "n">): void;
}

/** One run's computer, claimed, and the agent that will drive it. */
export interface Episode {
	identity: Omit<ComputerIdentity, "hello">;
	/** The bench's own channel to the computer: hello, setup, frames, checks, teardown. It may hold groups the agent is
	 *  not given (exec on a phone). */
	bench: Wire;
	/** The groups the agent is given, from those the computer offers. Absent: all of them. */
	agentGroups?: readonly string[];
	agent(request: AgentRequest): Promise<AgentResult>;
	release(): Promise<void>;
}

export interface OpenRequest {
	task: ResolvedTask;
	arm: Arm;
	/** Labels for the claim, so a sweep finds what this bench run made. */
	labels: Record<string, string>;
	signal: AbortSignal;
}

/** Where computers and agents come from: a fake world in tests, serve live. */
export interface Backend {
	readonly id: string;
	open(request: OpenRequest): Promise<WireResult<Episode>>;
	/** Asked once before a bench run claims any computer: throws when the backend can't serve a bench at all. */
	preflight?(signal: AbortSignal): Promise<void>;
}

/** An error no retry mends (serve lacks a route): thrown by a backend with `fatal: true`, it stops the bench run. */
const isFatal = (error: unknown) => (error as { fatal?: boolean } | undefined)?.fatal === true;

export type Outcome = "pass" | "fail" | "budget" | "infra" | "refused";

/** One line of results.jsonl: an attempt, as the report reads it. */
export interface Result {
	bench: string;
	run: string;
	task: string;
	version: number;
	sha256: string;
	split: string;
	seed: number;
	arm: string;
	attempt: number;
	outcome: Outcome;
	/** pass, fail and budget count; infra and refused don't. */
	scored: boolean;
	/** Whether this attempt was followed by another (infra). */
	rerun: boolean;
	/** Why it is infra or refused, in words. A task the computer can't do (a missing app, a failed capability probe) is
	 *  refused in phase preconditions, its why starting "skipped: ". */
	why?: string;
	phase?: "open" | "hello" | "preconditions" | "setup" | "agent" | "checks";
	stage1?: Stage1;
	checks?: { id: string; kind: string; status: string }[];
	grade?: { verdict: string; locus: string; by: string; confidence: string; judge: string };
	by?: "checks" | "grader";
	queue?: string;
	steps: number;
	cost_usd?: number;
	wall_s: number;
	routes: Record<string, number>;
	stale: number;
	noop: number;
	verified: number;
	acts: number;
	answer?: string;
}

export interface RunOptions {
	tasks: Task[];
	arms: Arm[];
	seeds: number[];
	backend: Backend;
	store: Store;
	judge?: Judge;
	grade?: GradeWhen;
	/** Attempts after an infra outcome. Default 2. */
	retries?: number;
	/** Episodes at once. Default 1. */
	parallel?: number;
	/** Frames after each act (the image before and after it). Default on where the computer has a screen, or a ui group
	 *  with ui.image on (the front window's image then). */
	frames?: boolean;
	/** "agent" (default) runs each arm's agent; "null" runs no agent; "oracle" runs the task's oracle on the bench's
	 *  channel. null and oracle prove the checks (fail on the untouched state, pass on a solved one) with no model. */
	mode?: "agent" | "null" | "oracle";
	signal?: AbortSignal;
	/** Each result, as it is written. */
	onResult?: (result: Result) => void;
	/** The bench run's id (default: a new one). */
	id?: string;
	/** The tasks found undoable (a precondition failed), by id, with why: each is refused without claiming a computer.
	 *  Filled as the run finds them; pass one map to several runs (verify's null and oracle passes) to share it. */
	skips?: Map<string, string>;
	/** Why a task × seed is refused before any computer is claimed (verify did not prove it: run --verified), or
	 *  undefined to run it. */
	refuse?: (task: string, seed: number) => string | undefined;
}

/** How long the ping after the agent's turn may take before the computer counts as not answering. */
const PING_MS = 15_000;

const sinceS = (t0: number) => Math.round((Date.now() - t0) / 100) / 10;

/** Why a hello can't run a task, or undefined when it can. */
export function helloMismatch(hello: Hello, task: Task, agentGroups: readonly string[], mode: "agent" | "null" | "oracle" = "agent"): string | undefined {
	const needs = task.spec.needs;
	if (hello.os !== needs.os) return `the task needs ${needs.os}; this computer is ${hello.os}`;
	const kinds: Record<string, string[]> = { desktop: ["desktop"], phone: ["android", "ios"], sandbox: ["linux"], browser: ["browser"] };
	if (!(kinds[needs.kind] ?? []).includes(hello.kind)) return `the task needs a ${needs.kind}; this computer is a ${hello.kind}`;
	if (needs.osVersion !== undefined && !(hello.osVersion ?? "").startsWith(needs.osVersion)) return `the task was written for ${needs.os} ${needs.osVersion}; this computer runs ${hello.osVersion ?? "an unknown version"}`;
	// A task names a group only when it can't be done without it (a drag needs input.pointer); the agent drives the rest
	// with whatever the computer offers it, so one suite compares code-mode, tools and vendor computer-tool agents.
	const missing = (needs.groups ?? []).filter((group) => !agentGroups.includes(group));
	if (missing.length > 0) {
		const offered = missing.filter((group) => hello.groups.includes(group));
		return offered.length === 0
			? `the task can't be done without ${missing.join(", ")}, which this computer does not have (it has ${hello.groups.join(", ") || "nothing"})`
			: `the task can't be done without ${missing.join(", ")}, which the agent is not given here (it has ${agentGroups.join(", ") || "nothing"})`;
	}
	const benchMissing = task.benchGroups.filter((group) => !hasGroup(hello.groups, group));
	if (benchMissing.length > 0) return `the task's setup and checks need ${benchMissing.join(", ")}, which this computer does not offer`;
	const oracleMissing = mode === "oracle" ? task.oracleGroups.filter((group) => !hasGroup(hello.groups, group)) : [];
	if (oracleMissing.length > 0) return `the task's oracle needs ${oracleMissing.join(", ")}, which this computer does not offer`;
	return undefined;
}

/** An entry of needs.apps in words: an id, or "one of a, b" for a list of alternatives. */
const appWords = (entry: string | string[]) => (typeof entry === "string" ? entry : `one of ${entry.join(", ")}`);

/**
 * The task's preconditions on this computer, read on the bench's channel after hello and before setup: every needs.apps
 * entry installed (apps.list; a list is alternatives, any one will do), then every capability probe passing. skipped:
 * the computer can't do the task (refused, never retried, remembered for the bench run). infra: a precondition could
 * not be read (a call the computer did not answer), so it is the computer's failure, run again.
 */
export async function readPreconditions(wire: Wire, task: Task, hello: Hello, signal: AbortSignal): Promise<{ skipped: string } | { infra: string } | undefined> {
	const apps = task.spec.needs.apps ?? [];
	if (apps.length > 0) {
		if (!hello.groups.includes("apps")) return { skipped: `needs ${apps.map(appWords).join(", ")}, and this computer has no apps group to list its apps` };
		const listed = await wire.call("apps.list", {}, { signal });
		if (!listed.ok) return { infra: `apps.list failed: ${listed.error.code}: ${listed.error.message}` };
		const installed = new Set(((listed.value as { apps?: { id: string }[] }).apps ?? []).map((app) => app.id));
		const missing = apps.filter((entry) => (typeof entry === "string" ? !installed.has(entry) : !entry.some((id) => installed.has(id))));
		if (missing.length > 0) return { skipped: `needs ${missing.map(appWords).join(", ")}` };
	}
	for (const probe of task.spec.needs.capabilities ?? []) {
		const [result] = await runChecks([probe], { wire, signal });
		if (result?.status === "error") return { infra: `capability ${probe.id}: ${result.reason}` };
		if (result?.status === "fail") {
			const seen = result.output.trim().replace(/\s*\n\s*/g, "; ");
			return { skipped: `needs ${probe.id}: ${result.reason}${seen ? ` (${seen.slice(0, 300)})` : ""}` };
		}
	}
	return undefined;
}

/** The protocol client's words when the computer's end of the connection went (packages/computer client.ts): code
 *  gone, or a harness's tool failure that quotes them. Never the bench's own release or a run's stop. */
const STREAM_LOST = /the daemon's stream (ended|closed)/;

/**
 * Whether the record shows the agent's computer was lost in its turn before the bench stopped it: an agent call failed
 * with the connection-lost words, no agent call after it answered, and the bench had seen that failure before the stop.
 * `steps` is in the order the bench saw each answer (the tap's, and a driver's as it reports them), and `stopAt` is how
 * many it had seen when it stopped the agent: an order, not a clock, since a driver's step times are on its own clock
 * and a fast computer answers many calls in one millisecond. A call in flight at the stop is answered after it, and a
 * stop lets serve's computer go, so that failure is the stop's. With no `stopAt` (the driver stopped the run and did not
 * say when) nothing orders the loss first: undefined.
 */
export function lostBeforeStop(steps: readonly Step[], stopAt: number | undefined): Step["error"] | undefined {
	if (stopAt === undefined) return undefined;
	const seen = steps.slice(0, stopAt);
	const agent = steps.filter((step) => step.phase === "agent" && step.method !== "hello" && step.method !== "ping");
	const at = agent.findLastIndex((step) => !step.ok && STREAM_LOST.test(step.error?.message ?? ""));
	if (at < 0) return undefined;
	if (agent.slice(at + 1).some((step) => step.ok)) return undefined;
	const lost = agent[at] as Step;
	return seen.includes(lost) ? lost.error : undefined;
}

/** A ping on the bench's channel, short: why the computer did not answer, or undefined when it did. */
async function pingFails(wire: Wire, signal: AbortSignal): Promise<string | undefined> {
	try {
		const answered = await wire.call("ping", {}, { signal: AbortSignal.any([signal, AbortSignal.timeout(PING_MS)]) });
		return answered.ok ? undefined : `${answered.error.code}: ${answered.error.message}`;
	} catch (error) {
		if (isFatal(error)) throw error;
		return `no answer: ${(error as Error).message}`;
	}
}

/** The slots of a ui.act step that name an element. In a task's calls each may hold `{"find": <uiQuery>}` instead of a
 *  ref, since a task can't know a window's refs before it runs. */
const REF_SLOTS = ["press", "set", "perform", "click", "into", "scroll"] as const;

const isFind = (value: unknown): value is { find: UiQuery } => typeof value === "object" && value !== null && !Array.isArray(value) && "find" in value;

/**
 * A ui.act call's params with each `{"find": query}` put in as the ref of the first node that matches it, read by one
 * ui.observe (full) of the call's target. The act then runs against that observation's state, unless the call names
 * one. Params without a find come back as they are.
 */
export async function resolveFinds(wire: Wire, params: JsonObject, signal?: AbortSignal): Promise<WireResult<JsonObject>> {
	const steps = Array.isArray(params.steps) ? (params.steps as JsonObject[]) : [];
	if (!steps.some((step) => REF_SLOTS.some((slot) => isFind(step[slot])))) return { ok: true, value: params };
	const observed = await wire.call("ui.observe", { ...(params.target === undefined ? {} : { target: params.target }), full: true }, { signal });
	if (!observed.ok) return observed;
	const seen = observed.value as { state?: string; nodes?: ObservedNode[] };
	const resolved: JsonObject[] = [];
	for (const step of steps) {
		const copy: JsonObject = { ...step };
		for (const slot of REF_SLOTS) {
			const want = copy[slot];
			if (!isFind(want)) continue;
			const ref = (seen.nodes ?? []).find((node) => nodeMatches(node, want.find))?.ref;
			if (ref === undefined) return { ok: false, error: { code: "not_found", message: `no node of the window matches ${JSON.stringify(want.find)} (the step's ${slot})` } };
			copy[slot] = ref;
		}
		resolved.push(copy);
	}
	return { ok: true, value: { ...params, steps: resolved, ...(params.state === undefined && typeof seen.state === "string" ? { state: seen.state } : {}) } };
}

/**
 * Why a ui.act's answer means its steps did not all happen, or undefined when they did. A step counts when it answers
 * verified: true (a readback saw its effect). A step whose effect comes later (a Save that shows "Saved" a moment after
 * its press) answers verified: false, and only the act's expect can see it: so an act whose expect was met and whose
 * window changed is done, unverified steps and all. Without that, verified: false is unconfirmed, and a setup or an
 * oracle that relies on it has not done its job.
 */
export function actShortfall(value: unknown): string | undefined {
	const v = (value ?? {}) as { steps?: { route?: string; verified?: boolean; error?: { kind?: string; message?: string } }[]; expect?: string; changed?: boolean };
	const steps = v.steps ?? [];
	const refused = steps.findIndex((one) => one.error !== undefined);
	if (refused >= 0) return `its step ${refused + 1} was refused: ${steps[refused]?.error?.kind}: ${steps[refused]?.error?.message}`;
	if (v.expect === "unmet") return "its expect did not hold in time";
	if (v.expect === "met" && v.changed === true) return undefined;
	const unverified = steps.findIndex((one) => one.verified !== true);
	if (unverified >= 0) return `its step ${unverified + 1} ran by the ${steps[unverified]?.route ?? "unknown"} route but was not verified (no readback saw its effect)`;
	return undefined;
}

/** Runs setup, teardown or oracle calls, in order. The first that fails ends them, with why. */
async function runCalls(wire: Wire, calls: readonly Call[], signal: AbortSignal): Promise<string | undefined> {
	for (const call of calls) {
		let params = call.params as JsonObject;
		if (call.method === "ui.act") {
			const found = await resolveFinds(wire, params, signal);
			if (!found.ok) {
				if (call.allow?.includes(found.error.code)) continue;
				return `ui.act could not find its elements: ${found.error.code}: ${found.error.message}`;
			}
			params = found.value;
		}
		const result = await wire.call(call.method, params, { signal });
		if (!result.ok) {
			if (call.allow?.includes(result.error.code)) continue;
			return `${call.method} failed: ${result.error.code}: ${result.error.message}`;
		}
		if (call.method === "ui.act") {
			const short = actShortfall(result.value);
			if (short) return `ui.act: ${short}`;
		}
		if (call.method === "exec.run") {
			const value = result.value as { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
			if (value.timedOut) return `exec.run ${JSON.stringify((call.params as { argv?: unknown }).argv)} timed out`;
			if (!(call.exit ?? [0]).includes(value.exitCode ?? -1)) return `exec.run ${JSON.stringify((call.params as { argv?: unknown }).argv)} exited ${value.exitCode}: ${(fromBase64(value.stderr) || fromBase64(value.stdout)).trim().slice(0, 400)}`;
		}
	}
	return undefined;
}

/** The end state's tree, as outline lines, through ui.observe (full). Undefined where there is no ui group. */
async function readTree(wire: Wire, hello: Hello, signal: AbortSignal): Promise<string | undefined> {
	if (!hello.groups.includes("ui")) return undefined;
	const observed = await wire.call("ui.observe", { full: true }, { signal });
	if (!observed.ok) return `(ui.observe failed: ${observed.error.code}: ${observed.error.message})`;
	const value = observed.value as { app?: { id?: string; name?: string }; window?: { title?: string }; state?: string; nodes?: ObservedNode[]; truncated?: boolean };
	const nodes = value.nodes ?? [];
	const head = `state ${value.state ?? "?"} · ${value.app?.id ?? "?"} · ${JSON.stringify(value.window?.title ?? "")}`;
	const lines = nodes.slice(0, 400).map(nodeLine);
	return [head, ...lines, ...(nodes.length > 400 || value.truncated ? [`… ${nodes.length - Math.min(nodes.length, 400)} more`] : [])].join("\n");
}

/** A run's tallies from its agent steps. */
function tally(steps: readonly Step[]) {
	const agent = steps.filter((step) => step.phase === "agent" && step.method !== "hello" && step.method !== "ping");
	const routes: Record<string, number> = {};
	let acts = 0;
	let noop = 0;
	let verified = 0;
	let stale = 0;
	for (const step of agent) {
		stale += step.stale ?? 0;
		if (step.method === "ui.act") {
			acts += 1;
			for (const route of step.routes ?? []) routes[route] = (routes[route] ?? 0) + 1;
			verified += step.verified ?? 0;
		} else if (step.method === "input.actions") {
			acts += 1;
			routes.input = (routes.input ?? 0) + 1;
		}
		if ((step.method === "ui.act" || step.method === "input.actions") && step.ok && step.changed === false) noop += 1;
	}
	return { steps: agent.length, routes, acts, noop, verified, stale };
}

/** A run whose checks ran and whose computer is released, waiting for its verdict. */
interface Checked {
	ctx: { record: RunRecord; end: (result: Omit<Result, "bench" | "run" | "task" | "version" | "sha256" | "split" | "seed" | "arm" | "attempt" | "scored" | "rerun">) => Result; resolved: ResolvedTask; arm: Arm };
	common: Pick<Result, "steps" | "routes" | "acts" | "noop" | "verified" | "stale" | "cost_usd" | "wall_s" | "answer">;
	/** A check that could not run ended the run as infra, so stage 1 here has passed or failed. */
	stage1: "pass" | "fail";
	checks: CheckResult[];
	input: GraderInput;
	/** A budget stopped the agent. */
	budget: boolean;
	/** It spent more than the task's usd budget: the steps and wall budgets cut an agent off, so what it left counts,
	 *  but money is spent before anyone can stop it, and a success bought over budget is not one. */
	overspent: boolean;
	/** Whether a grader may run: an agent's run, not a null or oracle proof. */
	graded: boolean;
}

/** Everything one attempt does. Returns its result; the caller decides on a re-run. */
async function attempt(options: RunOptions, bench: string, resolved: ResolvedTask, arm: Arm, n: number, signal: AbortSignal): Promise<Result> {
	const done = await onComputer(options, bench, resolved, arm, n, signal);
	return "ctx" in done ? grade(options, done, signal) : done;
}

/** The part of an attempt that holds a computer: open, hello, setup, the agent, the checks, teardown and release. */
async function onComputer(options: RunOptions, bench: string, resolved: ResolvedTask, arm: Arm, n: number, signal: AbortSignal): Promise<Result | Checked> {
	const { store } = options;
	const task = resolved.task;
	const run = `${task.spec.id}.s${resolved.seed}.${arm.id}.a${n}.${randomBytes(3).toString("hex")}`.replace(/[^A-Za-z0-9._-]/g, "-");
	const record: RunRecord = store.record(run);
	const steps: Step[] = [];
	let counter = 0;
	const t0 = Date.now();
	const onStep = (step: Step) => {
		steps.push(step);
		record.entry(ENTRY.step, step);
	};
	const base = { bench, run, task: task.spec.id, version: task.spec.version, sha256: task.sha256, split: task.spec.split, seed: resolved.seed, arm: arm.id, attempt: n };
	const empty = { steps: 0, wall_s: 0, routes: {}, stale: 0, noop: 0, verified: 0, acts: 0 };
	const end = (result: Omit<Result, keyof typeof base | "scored" | "rerun">): Result => {
		const full: Result = { ...base, ...result, scored: result.outcome === "pass" || result.outcome === "fail" || result.outcome === "budget", rerun: false };
		record.entry(ENTRY.verdict, full);
		return full;
	};
	const opened = await options.backend.open({ task: resolved, arm, labels: { "agentrun.bench": bench, "agentrun.bench.run": run }, signal });
	if (!opened.ok) return end({ ...empty, outcome: opened.error.code === "refused" ? "refused" : "infra", phase: "open", why: `the computer could not be had: ${opened.error.code}: ${opened.error.message}` });
	const episode = opened.value;
	const tapped = (phase: Step["phase"]) => tap(episode.bench, { phase, store, t0, onStep, next: () => ++counter });
	const benchWire = tapped("setup");
	// Teardown runs once setup has begun (never on a computer the task was refused for).
	let touched = false;
	try {
		const greeted = await episode.bench.call("hello", { client: `computer-bench/${BENCH_VERSION}` }, { signal });
		if (!greeted.ok) return end({ ...empty, outcome: "infra", phase: "hello", why: `hello failed: ${greeted.error.code}: ${greeted.error.message}` });
		const hello = greeted.value as Hello;
		const agentGroups = episode.agentGroups ?? hello.groups;
		const header: RunHeader = {
			bench: { version: BENCH_VERSION, run: bench },
			task: { id: task.spec.id, version: task.spec.version, sha256: task.sha256, split: task.spec.split, seed: resolved.seed, nonce: resolved.nonce, params: resolved.params, instruction: resolved.instruction, ...(task.spec.source ? { source: `${task.spec.source.suite}:${task.spec.source.id}` } : {}) },
			arm: { id: arm.id, harness: arm.harness, surface: arm.surface, model: arm.model, ...(arm.effort ? { effort: arm.effort } : {}) },
			attempt: n,
			budget: resolved.budget,
			computer: { ...episode.identity, hello },
			started_at: new Date(t0).toISOString(),
		};
		record.entry(ENTRY.run, header);
		const mismatch = helloMismatch(hello, task, agentGroups, options.mode ?? "agent");
		if (mismatch) return end({ ...empty, outcome: "refused", phase: "hello", why: mismatch });
		const unmet = await readPreconditions(tapped("precondition"), task, hello, signal);
		if (unmet && "infra" in unmet) return end({ ...empty, outcome: "infra", phase: "preconditions", why: `the preconditions could not be read: ${unmet.infra}` });
		if (unmet) {
			const why = `skipped: ${unmet.skipped}`;
			options.skips?.set(task.spec.id, why);
			return end({ ...empty, outcome: "refused", phase: "preconditions", why });
		}
		touched = true;
		const setupFailed = await runCalls(benchWire, resolved.setup, signal);
		if (setupFailed) return end({ ...empty, outcome: "infra", phase: "setup", why: `setup: ${setupFailed}` });

		// The agent, under its budget.
		const frameSource = frameSourceOf(hello);
		const frames = (options.frames ?? true) && frameSource ? new Frames(tapped("frame"), store, frameSource) : undefined;
		if (frames) await frames.take(signal);
		const stop = new AbortController();
		let spent: "steps" | "wall" | undefined;
		// When the bench stopped the agent, as how many steps it had seen by then: what a loss is ordered against.
		let stopAt: number | undefined;
		const wall = setTimeout(() => {
			spent ??= "wall";
			stopAt ??= steps.length;
			stop.abort(new Error("the task's wall budget is spent"));
		}, resolved.budget.wall_s * 1000);
		const agentSignal = AbortSignal.any([signal, stop.signal]);
		const agentStart = Date.now();
		let agent: AgentResult;
		const mode = options.mode ?? "agent";
		try {
			if (mode === "agent") {
				agent = await episode.agent({
					task: resolved,
					arm,
					instruction: resolved.instruction,
					budget: resolved.budget,
					signal: agentSignal,
					tap: (wire) =>
						tap(wire, {
							phase: "agent",
							store,
							t0,
							onStep,
							next: () => ++counter,
							steps: resolved.budget.steps,
							grant: agentGroups,
							frames,
							onSpent: () => {
								spent ??= "steps";
								stopAt ??= steps.length;
								stop.abort(new Error("the task's step budget is spent"));
							},
						}),
					onStep: (step) => onStep({ ...step, n: ++counter }),
				});
			} else if (mode === "oracle") {
				const failed = await runCalls(tapped("oracle"), resolved.oracle, agentSignal);
				agent = failed ? { outcome: "error", message: `oracle: ${failed}` } : { outcome: "done" };
			} else agent = { outcome: "done" };
		} catch (error) {
			if (isFatal(error)) throw error;
			agent = spent ? { outcome: "budget", message: (error as Error).message } : { outcome: "infra", message: `the agent's driver threw: ${(error as Error).message}` };
		} finally {
			clearTimeout(wall);
		}
		// Stopped by the bench: its own budget stop, or the driver's (serve cancels a run past its budget, and a cancel lets
		// the run's computer go, so a computer gone after it is the stop's doing, not a death).
		const stoppedByBench = spent !== undefined || agent.outcome === "budget";
		if (spent && agent.outcome !== "infra") agent = { ...agent, outcome: "budget", message: agent.message ?? `the ${spent} budget is spent` };
		const overspent = agent.cost_usd !== undefined && agent.cost_usd > resolved.budget.usd;
		if (overspent && agent.outcome === "done") agent = { ...agent, outcome: "budget", message: `it spent $${agent.cost_usd?.toFixed(2)} of a $${resolved.budget.usd} budget` };
		const agentWall = sinceS(agentStart);
		if (signal.aborted) return end({ ...empty, outcome: "infra", phase: "agent", why: "the bench run was stopped" });
		const tallies = tally(steps);
		const common = { ...tallies, cost_usd: agent.cost_usd, wall_s: agentWall, ...(agent.answer === undefined ? {} : { answer: agent.answer }) };
		if (agent.outcome === "infra" || agent.outcome === "refused") return end({ ...common, outcome: agent.outcome, phase: "agent", why: agent.message ?? `the agent's run ended ${agent.outcome}` });

		// Is the computer still there? Decided from its own signals, never a grader's: a ping on the bench's channel. One
		// that fails after the agent ended by itself is a death in its turn. After the bench stopped it, the stop may have
		// let the computer go, so it is a death only when the record shows the connection lost first.
		const silent = await pingFails(tapped("ping"), signal);
		if (silent) {
			const lost = stoppedByBench ? lostBeforeStop(steps, stopAt) : undefined;
			if (!stoppedByBench || lost) {
				const first = lost ? `its calls failed (${lost.code}: ${lost.message}) before the ${spent === "wall" ? "wall" : "step"} budget stopped it; ` : "";
				return end({ ...common, outcome: "infra", phase: "agent", why: `the computer stopped answering during the agent's turn: ${first}ping: ${silent}` });
			}
		}

		// Stage 1, on the computer as the agent left it, before anything else touches it.
		const checks: CheckResult[] = await runChecks(resolved.checks, { wire: tapped("check"), answer: agent.answer, signal });
		const stage1 = stage1Of(checks);
		record.entry(ENTRY.checks, { stage1, checks });
		const observeWire = tapped("observe");
		const tree = await readTree(observeWire, hello, signal);
		if (frames) await frames.take(signal);
		if (stage1 === "error") {
			const why = `a check could not run: ${checks.find((one) => one.status === "error")?.reason}`;
			const brief = checks.map(({ id, kind, status }) => ({ id, kind, status }));
			// A run stopped for its budget is scored as budget, whatever its checks could read: a stop may let the computer
			// go (serve's cancel), so a check that can't run then is no platform failure to run again.
			if (agent.outcome === "budget") return end({ ...common, outcome: "budget", phase: "checks", stage1, checks: brief, why: `${agent.message ?? "the budget is spent"}; ${why}` });
			return end({ ...common, outcome: "infra", phase: "checks", stage1, checks: brief, why });
		}
		const input: GraderInput = {
			task: { id: task.spec.id, title: task.spec.title, instruction: resolved.instruction, rubric: resolved.rubric, sufficient: resolved.sufficient },
			checks,
			stage1,
			steps: steps.filter((step) => step.phase === "agent").slice(-GRADER_STEPS),
			totalSteps: tallies.steps,
			tree,
			images: lastImages(steps, frames, store, 3),
			agent: { outcome: agent.outcome, answer: agent.answer, message: agent.message, cost_usd: agent.cost_usd, wall_s: agentWall },
		};
		return { ctx: { record, end, resolved, arm }, common, stage1, checks, input, budget: agent.outcome === "budget", overspent, graded: mode === "agent" };
	} finally {
		// Teardown and release, whatever happened above; a failure here is recorded, never scored.
		if (touched) {
			const teardownFailed = await runCalls(tapped("teardown"), resolved.teardown, AbortSignal.timeout(120_000)).catch((error: Error) => error.message);
			if (teardownFailed) record.entry(ENTRY.cleanup, { teardown: teardownFailed });
		}
		await episode.release().catch((error: Error) => {
			record.entry(ENTRY.cleanup, { release: error.message });
			if (isFatal(error)) throw error;
		});
	}
}

/** Stage 2 when it is wanted, then the verdict: after the computer is released, from what the record kept. */
async function grade(options: RunOptions, run: Checked, signal: AbortSignal): Promise<Result> {
	const { record, end, resolved, arm } = run.ctx;
	const { stage1, checks } = run;
	let verdict: GraderVerdict | undefined;
	let gradeError: string | undefined;
	if (options.judge && run.graded && wantsGrader(options.grade ?? "auto", stage1, resolved.sufficient)) {
		try {
			verdict = await options.judge.grade(run.input, signal);
			record.entry(ENTRY.grade, { judge: options.judge.id, ...verdict });
		} catch (error) {
			gradeError = (error as Error).message;
			record.entry(ENTRY.grade, { judge: options.judge.id, error: gradeError });
		}
	}
	const combined = combine(stage1, resolved.sufficient, verdict);
	const outcome: Outcome = run.overspent ? "budget" : combined.final === "pass" ? "pass" : run.budget ? "budget" : "fail";
	const queue = combined.queue ?? (gradeError ? `the grader failed: ${gradeError}` : undefined);
	const result = end({
		...run.common,
		outcome,
		stage1,
		checks: checks.map(({ id, kind, status }) => ({ id, kind, status })),
		by: combined.by,
		// An agent (or an oracle) that failed by its own account says why; the checks still decide.
		...(run.input.agent.outcome === "error" && run.input.agent.message ? { why: run.input.agent.message } : {}),
		...(verdict && options.judge ? { grade: { verdict: verdict.verdict, locus: verdict.locus, by: combined.by, confidence: verdict.confidence, judge: options.judge.id } } : {}),
		...(queue ? { queue } : {}),
	});
	if (queue) options.store.append("human-queue.jsonl", { run: result.run, task: result.task, seed: resolved.seed, arm: arm.id, reason: queue, stage1, checks: checks.map(({ id, status, reason }) => ({ id, status, reason })), grade: verdict, record: record.path });
	return result;
}

/** The last `n` distinct images the run saw: frames, and images the agent fetched, oldest first. */
function lastImages(steps: readonly Step[], frames: Frames | undefined, store: Store, n: number): GraderInput["images"] {
	// Every image in the order the run met it; an image met again moves to its latest place.
	const order: { sha: string; label: string }[] = [];
	const meet = (sha: string | undefined, label: string) => {
		if (!sha) return;
		const at = order.findIndex((one) => one.sha === sha);
		if (at >= 0) order.splice(at, 1);
		order.push({ sha, label });
	};
	for (const step of steps.filter((one) => one.phase === "agent")) {
		meet(step.image?.got, `what the agent saw at n${step.n} ${step.method}`);
		meet(step.image?.post, `after n${step.n} ${step.method}`);
	}
	meet(frames?.last, "the end state, after the agent stopped");
	const last = order.at(-1);
	if (last && !last.label.startsWith("the end state")) last.label = `${last.label} (the end state)`;
	const images: GraderInput["images"] = [];
	for (const { sha, label } of order.slice(-n)) {
		const bytes = readBlob(store, sha);
		const media = imageType(bytes);
		if (media) images.push({ sha256: sha, label, bytes, media });
	}
	return images;
}

function readBlob(store: Store, sha: string): Buffer {
	try {
		return readFileSync(store.blobPath(sha));
	} catch {
		return Buffer.alloc(0);
	}
}

/** The jobs in the order they run: seed, then task, then arm, so every arm sees a task under the same conditions. */
export function jobsOf(tasks: readonly Task[], arms: readonly Arm[], seeds: readonly number[]): { task: Task; arm: Arm; seed: number }[] {
	const jobs: { task: Task; arm: Arm; seed: number }[] = [];
	for (const seed of seeds) for (const task of tasks) for (const arm of arms) jobs.push({ task, arm, seed });
	return jobs;
}

/** Runs a bench: every job, with infra re-runs, `parallel` at a time. Returns every attempt's result. */
export async function runBench(options: RunOptions): Promise<Result[]> {
	const bench = options.id ?? `bench-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
	const signal = options.signal ?? new AbortController().signal;
	const ids = options.arms.map((arm) => arm.id);
	if (new Set(ids).size !== ids.length) throw new Error("two arms have the same id");
	// One bench run per folder: results.jsonl is appended to, and a report pools every row in it.
	if (existsSync(join(options.store.dir, "results.jsonl"))) throw new Error(`${options.store.dir} already holds a bench run's results: give each run a folder of its own, so no report pools two`);
	await options.backend.preflight?.(signal);
	options.store.write(
		"bench.json",
		`${JSON.stringify(
			{
				bench,
				version: BENCH_VERSION,
				backend: options.backend.id,
				mode: options.mode ?? "agent",
				judge: options.judge?.id ?? null,
				grade: options.grade ?? "auto",
				seeds: options.seeds,
				arms: options.arms,
				tasks: options.tasks.map((task) => ({ id: task.spec.id, version: task.spec.version, sha256: task.sha256, split: task.spec.split })),
				started_at: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
	);
	const jobs = jobsOf(options.tasks, options.arms, options.seeds);
	const results: Result[] = [];
	const retries = options.retries ?? 2;
	const run = { ...options, skips: options.skips ?? new Map<string, string>() };
	let next = 0;
	let fatal: unknown;
	const worker = async () => {
		while (next < jobs.length && !signal.aborted && fatal === undefined) {
			const job = jobs[next++] as (typeof jobs)[number];
			const resolved = resolveTask(job.task, job.seed);
			const unrun = (n: number, outcome: "infra" | "refused", why: string, phase?: Result["phase"]): Result => ({ bench, run: "-", task: job.task.spec.id, version: job.task.spec.version, sha256: job.task.sha256, split: job.task.spec.split, seed: job.seed, arm: job.arm.id, attempt: n, outcome, scored: false, rerun: false, why, ...(phase ? { phase } : {}), steps: 0, wall_s: 0, routes: {}, stale: 0, noop: 0, verified: 0, acts: 0 });
			for (let n = 1; n <= retries + 1; n += 1) {
				// A pair verify did not prove, or a task already found undoable: refused before any computer is claimed.
				const refused = run.refuse?.(job.task.spec.id, job.seed);
				const skipped = run.skips.get(job.task.spec.id);
				const result =
					refused !== undefined
						? unrun(n, "refused", refused, "open")
						: skipped !== undefined
							? unrun(n, "refused", skipped, "preconditions")
							: await attempt(run, bench, resolved, job.arm, n, signal).catch((error: Error): Result | undefined => {
									if (isFatal(error)) {
										fatal ??= error;
										return undefined;
									}
									return unrun(n, "infra", `the runner threw: ${error.message}`);
								});
				// A fatal error stops this worker, and the others before their next job.
				if (!result) return;
				const again = result.outcome === "infra" && n <= retries && !signal.aborted;
				const kept = { ...result, rerun: again };
				results.push(kept);
				options.store.append("results.jsonl", kept);
				options.onResult?.(kept);
				if (!again) break;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, options.parallel ?? 1) }, worker));
	if (fatal !== undefined) throw fatal;
	return results;
}
