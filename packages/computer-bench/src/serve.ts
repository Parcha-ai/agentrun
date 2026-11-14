// The live backend: computers and agents from an AgentRun serve, over its HTTP API. A bench run's computer is a held
// computer (README.md, "What serve needs"): POST /agents/{agent_id}/runs with `hold: true` claims the run's computer and
// waits, its agent not started; the bench sets the task up through POST /runs/{run_id}/computer/call, starts the agent
// with POST /runs/{run_id}/start, reads the agent's steps and answer from the run's Timeline, checks the computer through
// the same call route once the agent is done (the run keeps its computer), then lets it go with
// POST /runs/{run_id}/computer/release. test/serve.test.mjs proves this on a fake serve, and on this repository's serve
// itself, whose preflight finds nothing missing. Where serve lacks a route, the bench stops once, before any computer is
// claimed, with an error that names each one. Nothing here names a vendor: the arm's options say which provider serves
// the kind, and what the agent definition holds besides.
import { randomBytes } from "node:crypto";
import { clip, type Step } from "./record.js";
import type { AgentResult, Arm, Backend, Episode, OpenRequest } from "./runner.js";
import type { Json, JsonObject, Wire, WireResult } from "./wire.js";

export interface ServeBackendOptions {
	/** serve's API root, such as http://127.0.0.1:8080/v2. */
	baseUrl: string;
	/** An API token of the server's owner. */
	token: string;
	/** How often a run and its Timeline are read. Default 2000 ms. */
	pollMs?: number;
	/** How long a held computer may take to come up. Default 10 minutes. */
	claimTimeoutMs?: number;
	/** How long the held computer waits with no call from the bench (serve's `hold_minutes`). Default: serve's own. */
	holdMinutes?: number;
	fetch?: typeof fetch;
}

/** Where a held computer is, as GET /runs/{run_id} says in `computer.held`. */
type HeldState = "starting" | "waiting" | "started" | "ended" | "released";

/** What GET /runs/{run_id} answers, as far as the bench reads it. */
interface RunView {
	run_id: string;
	status: string;
	computer?: { state?: string; provider?: string; why?: string; held?: { state?: HeldState; why?: string } };
	cost?: { usd?: number | null; so_far_usd?: number };
	result?: { final_answer?: string | null } | null;
	error?: { code?: string; message?: string } | null;
}

/** A Timeline row, as far as the bench reads it. */
interface TimelineRow {
	id: string;
	timestamp: string;
	kind: string;
	tool_name: string | null;
	tool_use_id: string | null;
	tool_status: "success" | "failed" | null;
	tool_input_preview: string | null;
	tool_result_preview: string | null;
	text: string | null;
	parent_tool_use_id?: string;
	/** On a tool_result row: each computer call the tool call made, in order, and how many past serve's bound it kept
	 *  none of. */
	computer_calls?: ComputerCall[];
	computer_calls_dropped?: number;
}

/** A computer call as serve's record keeps it (serve's computer-calls.ts): never a param's value or an answer's bytes.
 *  `at` (when it was sent) and `words` (the call in a line) are read where serve's record has them. */
interface ComputerCall {
	method: string;
	ok: boolean;
	ms: number;
	code?: string;
	steps?: { do: string; route?: string; verified?: boolean; error?: string }[];
	expect?: "met" | "unmet";
	at?: string | number;
	words?: string;
}

/** When a computer call was sent, from its record's `at` (an ISO time, or epoch milliseconds), where it has one. */
const sentAt = (at: unknown): number | undefined => {
	const t = typeof at === "string" ? Date.parse(at) : typeof at === "number" && at > 1e12 ? at : Number.NaN;
	return Number.isFinite(t) ? t : undefined;
};

/** The agent's step for one computer call of a tool call: its method, answer, time, its ui.act steps' routes and
 *  readbacks, and its expect, as the tap records a call it makes itself. */
function stepOfCall(call: ComputerCall, at: number, t0: number, turn: number, tool: string, preview: string | null | undefined): Omit<Step, "n"> {
	const steps = call.steps ?? [];
	const stale = steps.filter((one) => one.error === "stale").length + (call.code === "stale" ? 1 : 0);
	return {
		phase: "agent",
		method: call.method,
		params: { tool, ...(preview === undefined ? {} : { preview }) },
		t_ms: Math.max(0, at - t0),
		ms: Math.max(0, call.ms),
		ok: call.ok,
		...(call.ok ? {} : { error: { code: call.code ?? "error", message: clip(call.words ?? call.code ?? "", 300) } }),
		...(call.method === "ui.act" ? { routes: steps.map((one) => (typeof one.route === "string" ? one.route : "error")), verified: steps.filter((one) => one.verified === true).length, ran: steps.filter((one) => typeof one.route === "string").length } : {}),
		...(call.expect ? { expect: call.expect } : {}),
		...(stale > 0 ? { stale } : {}),
		...(call.ok && call.words ? { note: clip(call.words, 400) } : {}),
		turn,
		tool,
	};
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
	});

/** A run's failures that are the platform's, not the agent's: run again, never scored. */
const INFRA_CODES = new Set(["computer_unavailable", "provider_error", "model_unavailable", "upstream_error", "internal", "runner_lost"]);

export function serveBackend(options: ServeBackendOptions): Backend {
	const call = options.fetch ?? fetch;
	const pollMs = options.pollMs ?? 2000;
	const api = async (method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; value: Record<string, unknown> | undefined }> => {
		const response = await call(`${options.baseUrl}${path}`, {
			method,
			headers: { authorization: `Bearer ${options.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			redirect: "error",
			// A call waits as long as serve lets the computer run it (two minutes), and a take of its row on top.
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(240_000)]) : AbortSignal.timeout(240_000),
		});
		const text = await response.text();
		let value: Record<string, unknown> | undefined;
		try {
			value = text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>);
		} catch {
			value = { error: { message: text.slice(0, 300) } };
		}
		return { status: response.status, value };
	};
	const errorOf = (value: Record<string, unknown> | undefined) => (value?.error ?? {}) as { code?: string; message?: string };
	const agents = new Map<string, Promise<string>>();

	/** One agent per bench run, arm, kind and exec (and step budget, on pi), made once: its definition is the arm's, and a
	 *  new bench run makes new ones, so an arm's definition is never edited under runs that used it. Its computer has the
	 *  arm's surface ("code" or "tools"), and for a task that denies exec, `exec: false` (its id ends -ui). On pi the step
	 *  budget is the agent's own `max_tool_calls` (serve holds it on pi alone), a backstop: on every harness the bench
	 *  counts the computer calls on the Timeline's tool rows and stops the run past the budget. */
	const agentFor = (bench: string, arm: Arm, kind: string, steps: number, exec: "allow" | "deny"): Promise<string> => {
		const id = `${bench}-${arm.id}-${kind}-${arm.surface}${exec === "deny" ? "-ui" : ""}${arm.harness === "pi" ? `-s${steps}` : ""}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
		let made = agents.get(id);
		if (!made) {
			const definition = {
				id,
				name: `computer-bench ${arm.id} (${kind})`,
				instructions: "Do the task you are given with your computer, then stop. When it asks a question, end with the answer alone.",
				harness: arm.harness,
				model: arm.model,
				...(arm.effort ? { thinking: arm.effort } : {}),
				computer: { kind, ...(typeof arm.options?.provider === "string" ? { provider: arm.options.provider } : {}), surface: arm.surface, ...(exec === "deny" ? { exec: false } : {}) },
				approvals: "never",
				skills: [],
				tools: [],
				...(arm.harness === "pi" ? { max_tool_calls: steps } : {}),
				...((arm.options?.definition as JsonObject | undefined) ?? {}),
			};
			made = api("POST", "/agents", { definition }).then(({ status, value }) => {
				if (status >= 300) throw Object.assign(new Error(`the agent ${id} was not saved: ${status} ${errorOf(value).message ?? ""}`), { code: "refused" });
				return id;
			});
			made.catch(() => agents.delete(id));
			agents.set(id, made);
		}
		return made;
	};

	/** Run `runId` read, or a MissingRoute when serve lacks the read or its held field. */
	const readRun = async (runId: string): Promise<RunView | undefined> => {
		const got = await api("GET", `/runs/${runId}`);
		const gap = gapOf(ROUTE.run, got.status, got.value) ?? (got.status === 200 && (got.value?.computer as RunView["computer"])?.held === undefined ? { route: ROUTE.run, what: "its answer's computer.held", answered: "200 without one" } : undefined);
		if (gap) {
			await api("POST", `/runs/${runId}/cancel`, {});
			throw new MissingRoute(options.baseUrl, [gap]);
		}
		return got.status === 200 ? (got.value as unknown as RunView) : undefined;
	};

	return {
		id: `serve:${options.baseUrl}`,
		async open(request: OpenRequest): Promise<WireResult<Episode>> {
			const { task, arm, signal } = request;
			let agentId: string;
			try {
				agentId = await agentFor(request.labels["agentrun.bench"] ?? "bench", arm, task.task.spec.needs.kind, task.budget.steps, task.task.spec.exec ?? "allow");
			} catch (error) {
				return { ok: false, error: { code: (error as { code?: string }).code ?? "serve", message: (error as Error).message } };
			}
			const started = await api("POST", `/agents/${agentId}/runs`, runBody(task.instruction, task.budget.usd, options.holdMinutes), signal);
			const runsGap = gapOf(ROUTE.runs, started.status, started.value);
			if (runsGap) throw new MissingRoute(options.baseUrl, [runsGap]);
			if (started.status >= 300) {
				const error = errorOf(started.value);
				const refused = started.status === 422 || error.code === "agent_not_runnable";
				return { ok: false, error: { code: refused ? "refused" : (error.code ?? `http_${started.status}`), message: error.message ?? `POST runs answered ${started.status}` } };
			}
			const runId = String(started.value?.run_id);
			// The claim: the computer comes up held, the agent not started.
			const deadline = Date.now() + (options.claimTimeoutMs ?? 600_000);
			let view = started.value as unknown as RunView;
			while (view.computer?.held?.state !== "waiting") {
				const held = view.computer?.held?.state;
				if (TERMINAL.has(view.status) || view.computer?.state === "failed" || held === "released" || held === "started" || held === "ended" || Date.now() > deadline || signal.aborted) {
					await api("POST", `/runs/${runId}/computer/release`, {});
					await api("POST", `/runs/${runId}/cancel`, {});
					return { ok: false, error: { code: view.error?.code ?? "computer_unavailable", message: view.computer?.why ?? view.error?.message ?? `the run's computer did not come up held (status ${view.status}, computer ${view.computer?.state ?? "none"}, held ${held ?? "none"})` } };
				}
				await sleep(pollMs, signal);
				view = (await readRun(runId)) ?? view;
			}
			const bench: Wire = {
				async call(method: string, params: JsonObject, callOptions: { signal?: AbortSignal } = {}): Promise<WireResult> {
					const answered = await api("POST", `/runs/${runId}/computer/call`, { method, params }, callOptions.signal);
					const gap = gapOf(ROUTE.call, answered.status, answered.value);
					if (gap) throw new MissingRoute(options.baseUrl, [gap]);
					// 409 computer_not_live: the run let its computer go (its end, the hold's lapse).
					if (answered.status !== 200) return { ok: false, error: { code: answered.status === 409 ? "gone" : (errorOf(answered.value).code ?? `http_${answered.status}`), message: errorOf(answered.value).message ?? `computer/call answered ${answered.status}` } };
					return answered.value as unknown as WireResult;
				},
			};
			return {
				ok: true,
				value: {
					identity: { provider: view.computer?.provider ?? "serve", ref: runId },
					agentId,
					bench,
					agent: (agentRequest) => drive(runId, agentRequest),
					async release() {
						const released = await api("POST", `/runs/${runId}/computer/release`, {});
						const gap = gapOf(ROUTE.release, released.status, released.value);
						if (gap) throw new MissingRoute(options.baseUrl, [gap]);
						// 404 not_found: it was let go already (the run's end, a stop past the budget, the hold's lapse).
						if (released.status >= 300 && released.status !== 404) throw new Error(`release answered ${released.status}: ${errorOf(released.value).message ?? ""}`);
					},
				},
			};
		},

		/** Each route the bench needs that serve may lack, asked once before any computer is claimed, of a run nobody has:
		 *  serve that has the route answers 404 for the run, serve that lacks it "no route". Its OpenAPI document says
		 *  whether a run's create takes `hold` and its read has `computer.held`. Every gap goes in one error. */
		async preflight(signal: AbortSignal): Promise<void> {
			const nobody = `computer-bench-preflight-${randomBytes(4).toString("hex")}`;
			const probe = async (route: string, method: string, path: string, body?: unknown) => {
				const answered = await api(method, path, body, signal);
				return gapOf(route, answered.status, answered.value);
			};
			const contract = async (): Promise<ServeGap[]> => {
				const got = await api("GET", "/openapi.json", undefined, signal);
				if (got.status !== 200) return [{ route: ROUTE.openapi, answered: answeredOf(got.status, got.value) }];
				const schemas = ((got.value?.components ?? {}) as { schemas?: Record<string, { properties?: Record<string, { properties?: Record<string, unknown> }> }> }).schemas ?? {};
				return [
					...(schemas.RunCreate?.properties?.hold ? [] : [{ route: ROUTE.runs, what: "its body's hold", answered: "an OpenAPI document whose RunCreate has no hold" }]),
					...(schemas.Run?.properties?.computer?.properties?.held ? [] : [{ route: ROUTE.run, what: "its answer's computer.held", answered: "an OpenAPI document whose Run.computer has no held" }]),
				];
			};
			const gaps = await Promise.all([
				probe(ROUTE.runs, "POST", `/agents/${nobody}/runs`, runBody("preflight", 0.01, options.holdMinutes)),
				probe(ROUTE.run, "GET", `/runs/${nobody}`),
				probe(ROUTE.timeline, "GET", `/runs/${nobody}/timeline`),
				probe(ROUTE.call, "POST", `/runs/${nobody}/computer/call`, { method: "hello", params: {} }),
				probe(ROUTE.start, "POST", `/runs/${nobody}/start`, {}),
				probe(ROUTE.release, "POST", `/runs/${nobody}/computer/release`, {}),
			]);
			const missing = [...gaps.filter((gap): gap is ServeGap => gap !== undefined), ...(await contract())];
			if (missing.length > 0) throw new MissingRoute(options.baseUrl, missing);
		},
	};

	/** Starts the held run's agent and follows it until it is done and the run keeps its computer for the checks: its
	 *  steps (the computer calls on the Timeline's tool rows, under the step budget), its tool calls (its turns), and its
	 *  answer (the Timeline's final answer). A tool call that made no computer call is a turn, not a step. */
	async function drive(runId: string, request: Parameters<Episode["agent"]>[0]): Promise<AgentResult> {
		const go = await api("POST", `/runs/${runId}/start`, {});
		const startGap = gapOf(ROUTE.start, go.status, go.value);
		if (startGap) throw new MissingRoute(options.baseUrl, [startGap]);
		if (go.status >= 300) return { outcome: "infra", message: `start answered ${go.status}: ${errorOf(go.value).message ?? ""}` };
		const t0 = Date.now();
		let after: number | undefined;
		const uses = new Map<string, { at: number; name: string; input: string | null }>();
		const done = new Set<string>();
		let computerCalls = 0;
		let answer: string | undefined;
		let stopped: "budget" | "signal" | undefined;
		let view: RunView = { run_id: runId, status: "working" };
		const readTimeline = async () => {
			for (let page = 0; page < 100; page += 1) {
				const got = await api("GET", `/runs/${runId}/timeline${after === undefined ? "" : `?after=${after}`}`);
				const gap = gapOf(ROUTE.timeline, got.status, got.value);
				if (gap) {
					await api("POST", `/runs/${runId}/cancel`, {});
					throw new MissingRoute(options.baseUrl, [gap]);
				}
				if (got.status !== 200) return;
				for (const row of (got.value?.rows ?? []) as TimelineRow[]) {
					// The run's own conversation: a subagent's rows are not the agent's computer calls.
					if (row.parent_tool_use_id) continue;
					if (row.kind === "final_answer" && row.text !== null) answer = row.text;
					if (row.kind === "tool_use" && row.tool_use_id && !uses.has(row.tool_use_id)) uses.set(row.tool_use_id, { at: Date.parse(row.timestamp), name: row.tool_name ?? "", input: row.tool_input_preview });
					if (row.kind !== "tool_result" || !row.tool_use_id || row.tool_status === null || done.has(row.tool_use_id)) continue;
					done.add(row.tool_use_id);
					const turn = done.size;
					const use = uses.get(row.tool_use_id);
					const at = Date.parse(row.timestamp);
					const start = use?.at ?? at;
					const tool = row.tool_name ?? use?.name ?? "";
					const preview = use?.input ?? row.tool_input_preview ?? null;
					const calls = row.computer_calls ?? [];
					const dropped = row.computer_calls_dropped ?? 0;
					if (calls.length === 0 && dropped === 0) {
						request.onStep({
							phase: "tool",
							method: tool,
							params: { preview },
							t_ms: Math.max(0, start - t0),
							ms: Math.max(0, at - start),
							ok: row.tool_status === "success",
							...(row.tool_status === "failed" ? { error: { code: "tool_failed", message: row.tool_result_preview ?? "" } } : {}),
							turn,
							tool,
						});
						continue;
					}
					// Each computer call is a step, at its own time where serve's record says, else after the one before it.
					let next = start;
					calls.forEach((call, i) => {
						const sent = sentAt(call.at) ?? next;
						request.onStep(stepOfCall(call, sent, t0, turn, tool, i === 0 ? preview : undefined));
						next = sent + Math.max(0, call.ms);
						if (call.method !== "hello" && call.method !== "ping") computerCalls += 1;
					});
					// Calls past serve's bound are steps too, though their method and answer were not kept.
					for (let i = 0; i < dropped; i += 1) request.onStep({ phase: "agent", method: "unrecorded", params: { tool }, t_ms: Math.max(0, next - t0), ms: 0, ok: true, note: "a computer call past serve's record bound: its method and answer were not kept", turn, tool });
					computerCalls += dropped;
				}
				const next = got.value?.next_after;
				if (typeof next === "number") after = next;
				if (!got.value?.has_more) return;
			}
		};
		/** The agent is done and the run keeps its computer (`ended`), or the run let it go (its end, a stop). */
		const over = () => TERMINAL.has(view.status) || view.computer?.held?.state === "ended" || view.computer?.held?.state === "released";
		while (!over()) {
			await sleep(pollMs, request.signal);
			await readTimeline();
			if (!stopped && (request.signal.aborted || computerCalls > request.budget.steps)) {
				stopped = request.signal.aborted ? "signal" : "budget";
				await api("POST", `/runs/${runId}/cancel`, {});
			}
			view = (await readRun(runId)) ?? view;
			// A run paused at its cap waits on a person: for the bench, the money budget is spent.
			if (view.status === "input_required" && !stopped) {
				stopped = "budget";
				await api("POST", `/runs/${runId}/cancel`, {});
			}
		}
		await readTimeline();
		const usd = view.cost?.usd ?? view.cost?.so_far_usd;
		const final = answer ?? view.result?.final_answer ?? undefined;
		const common = { ...(typeof usd === "number" ? { cost_usd: usd } : {}), ...(final ? { answer: final } : {}), tool_calls: done.size, transcript: `serve run ${runId}` };
		if (stopped === "budget") return { ...common, outcome: "budget", message: computerCalls > request.budget.steps ? `the task's budget of ${request.budget.steps} computer calls is spent` : "the run paused at its cap" };
		if (stopped === "signal") return { ...common, outcome: "budget", message: String((request.signal.reason as Error | undefined)?.message ?? "stopped") };
		if (view.computer?.held?.state === "ended" || view.status === "completed") return { ...common, outcome: "done" };
		const code = view.error?.code ?? "";
		const lost = view.computer?.held?.why === "lost";
		return { ...common, outcome: INFRA_CODES.has(code) || lost ? "infra" : "error", message: `the run ended ${view.status}${code ? ` (${code})` : ""}${lost ? ", its held computer lost with its runner" : ""}: ${view.error?.message ?? ""}` };
	}
}

/** POST /agents/{agent_id}/runs' body: the task, its money budget as the run's cap, and the hold. */
const runBody = (content: string, usd: number, holdMinutes: number | undefined) => ({ input: { content }, max_cost_usd: usd, hold: true, ...(holdMinutes === undefined ? {} : { hold_minutes: holdMinutes }) });

/** For a dry run's record, and for the error that names a missing route: the requests the serve backend makes, what it
 *  needs each for, and the item of README.md's "What serve needs" that asks for it (0: serve has it without a hold). */
export const SERVE_CONTRACT: readonly { method: string; path: string; body?: Json; answers: string; need: string; item: number }[] = [
	{ method: "GET", path: "/openapi.json", answers: "serve's OpenAPI document", need: "reads whether a run's create takes hold and its read has computer.held", item: 0 },
	{ method: "POST", path: "/agents", body: { definition: "{id, name, instructions, harness, model, thinking (arm.effort)?, computer {kind, provider?, surface (arm.surface), exec: false (a task's exec deny)?}, approvals, skills, tools, max_tool_calls (pi: budget.steps), ...arm.options.definition}" }, answers: "the saved agent", need: "saves an agent per arm, kind and exec (and step budget, on pi)", item: 0 },
	{ method: "POST", path: "/agents/{agent_id}/runs", body: { input: "{content}", max_cost_usd: "budget.usd", hold: true, hold_minutes: "options.holdMinutes?" }, answers: "{run_id, status, computer {state, held {state}}}; with hold, the agent waits for /start", need: "claims a run's computer and holds it, its agent not started", item: 1 },
	{ method: "GET", path: "/runs/{run_id}", answers: "{status, computer {state, provider, why, held {state starting|waiting|started|ended|released, why}}, cost {usd, so_far_usd}, result {final_answer}, error {code, message}}", need: "reads where the hold is, and how the run ended", item: 5 },
	{ method: "POST", path: "/runs/{run_id}/computer/call", body: { method: "a protocol method", params: "its params" }, answers: "{ok, value} | {ok: false, error {code, message}}: the computer's answer, verbatim", need: "reaches the held computer through it, for setup, frames, checks and teardown", item: 2 },
	{ method: "POST", path: "/runs/{run_id}/start", answers: "{held {state: started}}", need: "starts the held run's agent once the task is set up", item: 1 },
	{ method: "GET", path: "/runs/{run_id}/timeline?after=", answers: "{rows [{kind tool_use|tool_result|final_answer, tool_name, tool_use_id, tool_status, tool_input_preview, text, computer_calls [{method, ok, ms, code?, steps?, expect?, at?, words?}]?, computer_calls_dropped?}], next_after, has_more}", need: "reads the agent's tool calls, the computer calls each made, and its final answer", item: 4 },
	{ method: "POST", path: "/runs/{run_id}/cancel", answers: "the run stops", need: "stops a run past its budget", item: 0 },
	{ method: "POST", path: "/runs/{run_id}/computer/release", answers: "{held {state: released}}; 404 not_found, not 'no route', once let go", need: "releases the computer once the checks have read it", item: 3 },
];

/** A route as the contract names it: method and path, its query left out. */
const routeOf = (entry: (typeof SERVE_CONTRACT)[number]) => `${entry.method} ${entry.path.split("?")[0]}`;

/** One thing the bench needs that serve does not do: a route, or a part of one (`what`), and what serve answered. */
export interface ServeGap {
	route: string;
	what?: string;
	answered: string;
}

/** serve lacks a route, or a part of one, that the bench needs. No retry mends it, so the bench run stops on it
 *  (`fatal`), once, with each gap named. */
export class MissingRoute extends Error {
	readonly code = "missing_route";
	readonly fatal = true;
	constructor(
		readonly baseUrl: string,
		readonly gaps: readonly ServeGap[],
	) {
		const line = (gap: ServeGap) => {
			const entry = SERVE_CONTRACT.find((one) => routeOf(one) === gap.route);
			const where = entry?.item ? ` (README.md, "What serve needs", item ${entry.item})` : "";
			return `${gap.route}${gap.what ? `, ${gap.what}` : ""}: the bench ${entry?.need ?? "needs it"}${where}. It answered ${gap.answered}`;
		};
		super(
			gaps.length === 1
				? `serve at ${baseUrl} lacks ${line(gaps[0] as ServeGap)}`
				: `serve at ${baseUrl} lacks ${gaps.length} things the bench needs:\n${gaps.map((gap) => `  ${line(gap)}`).join("\n")}`,
		);
		this.name = "MissingRoute";
	}
}

/** What serve answered, in a line. */
const answeredOf = (status: number, value: Record<string, unknown> | undefined) => {
	const error = (value?.error ?? {}) as { code?: string; message?: string };
	return `${status}${error.code ? ` ${error.code}` : ""}${error.message ? `: ${error.message}` : ""}`;
};

/** Whether serve's answer says it lacks `route`: 405, or 404 "no route" (a 404 for a run or agent it doesn't have is
 *  not one), or a 422 that names body fields it keeps none of (serve's words for those: "The body keeps no field X."). */
export function gapOf(route: string, status: number, value: Record<string, unknown> | undefined): ServeGap | undefined {
	const error = (value?.error ?? {}) as { message?: string; fields?: { field?: string; reason?: string; message?: string }[] };
	if (status === 405 || (status === 404 && /^no route\b/.test(error.message ?? ""))) return { route, answered: answeredOf(status, value) };
	const fields = status === 422 ? (error.fields ?? []).filter((one) => one.reason === "not_allowed" && /^The body keeps no field /.test(one.message ?? "")).map((one) => String(one.field)) : [];
	if (fields.length > 0) return { route, what: `its body's ${fields.join(", ")}`, answered: answeredOf(status, value) };
	return undefined;
}

/** The contract's routes by their use, as gapOf and MissingRoute name them. */
const ROUTE = {
	openapi: "GET /openapi.json",
	runs: "POST /agents/{agent_id}/runs",
	run: "GET /runs/{run_id}",
	timeline: "GET /runs/{run_id}/timeline",
	call: "POST /runs/{run_id}/computer/call",
	start: "POST /runs/{run_id}/start",
	release: "POST /runs/{run_id}/computer/release",
} as const;
