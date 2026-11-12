// The live backend: computers and agents from an AgentRun serve, over its HTTP API. A bench run needs three things of
// serve that it does not do yet (README.md, "What serve needs"): a run that claims its computer and holds it, without
// starting its agent, until the bench has set the task up; a bench channel to that computer, for setup, checks and
// teardown; and a release the bench calls once the checks have read the computer. This file is written against that
// contract, and test/serve.test.mjs proves it on a fake serve that keeps it. Nothing here names a vendor: the arm's
// options say which provider serves the kind, and what the agent definition holds besides.
import type { AgentResult, Arm, Backend, Episode, OpenRequest } from "./runner.js";
import type { Step } from "./record.js";
import type { Json, JsonObject, Wire, WireResult } from "./wire.js";

export interface ServeBackendOptions {
	/** serve's API root, such as http://127.0.0.1:8080/v2. */
	baseUrl: string;
	/** An API token of the server's owner. */
	token: string;
	/** How often a run's status and journal are read. Default 2000 ms. */
	pollMs?: number;
	/** How long a held computer may take to come up. Default 10 minutes. */
	claimTimeoutMs?: number;
	fetch?: typeof fetch;
}

/** What GET /runs/{run_id} answers, as far as the bench reads it. */
interface RunView {
	run_id: string;
	status: string;
	/** The computer's state: `held` once claimed and set aside for the bench, then `ready`, `ended`, `failed`. */
	computer?: { state?: string; provider?: string; groups?: string[]; agent_groups?: string[]; why?: string };
	cost?: { usd?: number | null };
	/** The agent's final answer: the text of its last turn. */
	answer?: string | null;
	error?: { code?: string; message?: string } | null;
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
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
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

	/** One agent per bench run, arm and kind, made once: its definition is the arm's, and a new bench run makes new ones,
	 *  so an arm's definition is never edited under runs that used it. */
	const agentFor = (bench: string, arm: Arm, kind: string): Promise<string> => {
		const id = `${bench}-${arm.id}-${kind}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
		let made = agents.get(id);
		if (!made) {
			const definition = {
				id,
				name: `computer-bench ${arm.id} (${kind})`,
				instructions: "Do the task you are given with your computer, then stop. When it asks a question, end with the answer alone.",
				harness: arm.harness,
				model: arm.model,
				...(arm.effort ? { effort: arm.effort } : {}),
				computer: { kind, ...(typeof arm.options?.provider === "string" ? { provider: arm.options.provider } : {}) },
				approvals: "never",
				skills: [],
				tools: [],
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

	return {
		id: `serve:${options.baseUrl}`,
		async open(request: OpenRequest): Promise<WireResult<Episode>> {
			const { task, arm, signal } = request;
			let agentId: string;
			try {
				agentId = await agentFor(request.labels["agentrun.bench"] ?? "bench", arm, task.task.spec.needs.kind);
			} catch (error) {
				return { ok: false, error: { code: (error as { code?: string }).code ?? "serve", message: (error as Error).message } };
			}
			const started = await api(
				"POST",
				`/agents/${agentId}/runs`,
				{ input: { content: task.instruction }, max_cost_usd: task.budget.usd, max_tool_calls: task.budget.steps, labels: request.labels, hold: "bench" },
				signal,
			);
			if (started.status >= 300) {
				const error = errorOf(started.value);
				const refused = started.status === 422 || error.code === "agent_not_runnable";
				return { ok: false, error: { code: refused ? "refused" : (error.code ?? `http_${started.status}`), message: error.message ?? `POST runs answered ${started.status}` } };
			}
			const runId = String(started.value?.run_id);
			// The claim: the computer comes up held, the agent not started.
			const deadline = Date.now() + (options.claimTimeoutMs ?? 600_000);
			let view = started.value as unknown as RunView;
			while (view.computer?.state !== "held") {
				if (TERMINAL.has(view.status) || view.computer?.state === "failed" || Date.now() > deadline || signal.aborted) {
					await api("POST", `/runs/${runId}/cancel`, {});
					await api("POST", `/runs/${runId}/computer/release`, {});
					return { ok: false, error: { code: view.error?.code ?? "computer_unavailable", message: view.computer?.why ?? view.error?.message ?? `the run's computer did not come up held (status ${view.status}, computer ${view.computer?.state ?? "none"})` } };
				}
				await sleep(pollMs, signal);
				const got = await api("GET", `/runs/${runId}`);
				if (got.status === 200) view = got.value as unknown as RunView;
			}
			const bench: Wire = {
				async call(method: string, params: JsonObject, callOptions: { signal?: AbortSignal } = {}): Promise<WireResult> {
					const answered = await api("POST", `/runs/${runId}/computer/call`, { method, params }, callOptions.signal);
					if (answered.status !== 200) return { ok: false, error: { code: answered.status === 410 ? "gone" : (errorOf(answered.value).code ?? `http_${answered.status}`), message: errorOf(answered.value).message ?? `computer/call answered ${answered.status}` } };
					return answered.value as unknown as WireResult;
				},
			};
			return {
				ok: true,
				value: {
					identity: { provider: view.computer?.provider ?? "serve", ref: runId },
					bench,
					...(view.computer?.agent_groups ? { agentGroups: view.computer.agent_groups } : {}),
					agent: (agentRequest) => drive(runId, agentRequest),
					async release() {
						const released = await api("POST", `/runs/${runId}/computer/release`, {});
						if (released.status >= 300 && released.status !== 404) throw new Error(`release answered ${released.status}: ${errorOf(released.value).message ?? ""}`);
					},
				},
			};
		},
	};

	/** Starts the held run's agent and follows it to its end: its steps from the journal, under the step budget. */
	async function drive(runId: string, request: Parameters<Episode["agent"]>[0]): Promise<AgentResult> {
		const go = await api("POST", `/runs/${runId}/start`, {});
		if (go.status >= 300) return { outcome: "infra", message: `start answered ${go.status}: ${errorOf(go.value).message ?? ""}` };
		let after: string | undefined;
		let steps = 0;
		let stopped: "budget" | "signal" | undefined;
		let view: RunView = { run_id: runId, status: "working" };
		const readSteps = async () => {
			for (let page = 0; page < 100; page += 1) {
				const got = await api("GET", `/runs/${runId}/journal?kind=agentrun.computer.step${after ? `&after=${encodeURIComponent(after)}` : ""}`);
				if (got.status !== 200) return;
				const entries = (got.value?.entries ?? []) as { id: string; data: Omit<Step, "n"> }[];
				for (const entry of entries) {
					steps += 1;
					request.onStep({ ...entry.data, phase: "agent" });
				}
				after = (got.value?.next_after as string | undefined) ?? entries.at(-1)?.id ?? after;
				if (!got.value?.has_more) return;
			}
		};
		while (!TERMINAL.has(view.status)) {
			await sleep(pollMs, request.signal);
			await readSteps();
			if (!stopped && (request.signal.aborted || steps > request.budget.steps)) {
				stopped = request.signal.aborted ? "signal" : "budget";
				await api("POST", `/runs/${runId}/cancel`, {});
			}
			const got = await api("GET", `/runs/${runId}`);
			if (got.status === 200) view = got.value as unknown as RunView;
			// A run paused at its cap waits on a person: for the bench, the money budget is spent.
			if (view.status === "input_required" && !stopped) {
				stopped = "budget";
				await api("POST", `/runs/${runId}/cancel`, {});
			}
		}
		await readSteps();
		const cost_usd = view.cost?.usd ?? undefined;
		const common = { ...(cost_usd === undefined || cost_usd === null ? {} : { cost_usd }), ...(view.answer ? { answer: view.answer } : {}), transcript: `serve run ${runId}` };
		if (stopped === "budget") return { ...common, outcome: "budget", message: steps > request.budget.steps ? `the task's budget of ${request.budget.steps} computer calls is spent` : "the run paused at its cap" };
		if (stopped === "signal") return { ...common, outcome: "budget", message: String((request.signal.reason as Error | undefined)?.message ?? "stopped") };
		if (view.status === "completed") return { ...common, outcome: "done" };
		const code = view.error?.code ?? "";
		return { ...common, outcome: INFRA_CODES.has(code) ? "infra" : "error", message: `the run ended ${view.status}${code ? ` (${code})` : ""}: ${view.error?.message ?? ""}` };
	}
}

/** For a dry run's record: the requests the serve backend would make, in words. */
export const SERVE_CONTRACT: readonly { method: string; path: string; body?: Json; answers: string; today: boolean }[] = [
	{ method: "POST", path: "/agents", body: { definition: "{id, name, instructions, harness, model, effort?, computer {kind, provider?}, approvals, skills, tools, ...arm.options.definition}" }, answers: "the saved agent", today: true },
	{ method: "POST", path: "/agents/{agent_id}/runs", body: { input: "{content}", max_cost_usd: "budget.usd", max_tool_calls: "budget.steps", labels: "{agentrun.bench, agentrun.bench.run}", hold: "bench" }, answers: "{run_id, status, computer {state}}; with hold, the agent waits for /start", today: false },
	{ method: "GET", path: "/runs/{run_id}", answers: "{status, computer {state held|ready|ended|failed, provider, agent_groups, why}, cost {usd}, answer, error {code, message}}", today: false },
	{ method: "POST", path: "/runs/{run_id}/computer/call", body: { method: "a protocol method", params: "its params" }, answers: "{ok, value} | {ok: false, error {code, message}}: the bench's channel, every group the computer has", today: false },
	{ method: "POST", path: "/runs/{run_id}/start", answers: "the held run's agent starts", today: false },
	{ method: "GET", path: "/runs/{run_id}/journal?kind=agentrun.computer.step&after=", answers: "{entries [{id, kind, at, data: Step}], has_more, next_after}: the agent's computer calls", today: false },
	{ method: "POST", path: "/runs/{run_id}/cancel", answers: "the run stops", today: true },
	{ method: "POST", path: "/runs/{run_id}/computer/release", answers: "the held computer is released (404 when it already was)", today: false },
];
