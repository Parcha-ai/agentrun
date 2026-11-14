// The serve backend against a fake serve that keeps serve's held-computer contract (README.md, "What serve needs"): a run
// created with hold: true, its computer reached through /computer/call, its agent started by /start, its steps and
// answer read from its Timeline, the computer kept after the agent's end for the checks, and let go by /computer/release.
// The fake serve's computers are fake worlds and its agents the fake agents. Last, the preflight against this
// repository's own serve, which has every route the bench needs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { FAKE_AGENTS, FakeWorld } from "../dist/fake-world.js";
import { MissingRoute, resolveTask, runBench, serveBackend, Store, tap, verifySuite } from "../dist/index.js";
import { arm, fakeTasks, store, tmp } from "./support.mjs";

const TOKEN = "t0ken";

/** A fake serve: the routes the bench calls, over fake worlds. Like serve, it answers a route it lacks (`lacks`, as
 *  SERVE_CONTRACT names them) 404 "no route" or 405, an agent or run it doesn't have 404 not_found, and, once it has the
 *  agent, a runs body field it keeps none of (`keepsNo`) 422 not_allowed. Its OpenAPI document has RunCreate.hold unless
 *  it keeps no hold, and Run.computer.held unless `noHeld`, which leaves held out of its run reads too. */
async function fakeServe({ holdPolls = 1, endAs, cost = 0.01, refuseRuns = 0, lacks = [], lackStatus = 404, keepsNo = [], noHeld = false } = {}) {
	const agents = new Map();
	const runs = new Map();
	const requests = [];
	let refused = 0;
	const fake = { pending: undefined };
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
		const url = new URL(req.url, "http://x");
		requests.push(`${req.method} ${url.pathname}`);
		const send = (status, value) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(value === undefined ? "" : JSON.stringify(value));
		};
		if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: { code: "unauthorized" } });
		const parts = url.pathname.replace(/^\/v2/, "").split("/").filter(Boolean);
		const route = `${req.method} /${(parts[0] === "agents" || parts[0] === "runs") && parts.length > 1 ? [parts[0], parts[0] === "agents" ? "{agent_id}" : "{run_id}", ...parts.slice(2)].join("/") : parts.join("/")}`;
		if (lacks.includes(route)) {
			return lackStatus === 405
				? send(405, { error: { code: "method_not_allowed", message: `${req.method} is not a method of ${url.pathname}` } })
				: send(404, { error: { code: "not_found", message: `no route ${url.pathname}` } });
		}
		if (req.method === "GET" && parts.join("/") === "openapi.json") {
			return send(200, { components: { schemas: { RunCreate: { properties: keepsNo.includes("hold") ? {} : { hold: { type: "boolean" } } }, Run: { properties: { computer: { properties: noHeld ? {} : { held: { type: "object" } } } } } } } });
		}
		if (req.method === "POST" && parts.join("/") === "agents") {
			const { definition } = body;
			if (agents.has(definition.id)) return send(409, { error: { code: "conflict", message: "exists" } });
			agents.set(definition.id, definition);
			return send(201, { agent_id: definition.id });
		}
		if (req.method === "POST" && parts[0] === "agents" && parts[2] === "runs") {
			if (!agents.has(parts[1])) return send(404, { error: { code: "not_found", message: `no agent ${parts[1]}` } });
			const kept = keepsNo.filter((field) => field in body);
			if (kept.length > 0) {
				const fields = kept.map((field) => ({ field, reason: "not_allowed", message: `The body keeps no field ${field}.` }));
				return send(422, { error: { code: "input_invalid", message: fields.map((one) => one.message).join(" "), fields } });
			}
			if (refused < refuseRuns) {
				refused += 1;
				return send(503, { error: { code: "computer_unavailable", message: "no phone free" } });
			}
			assert.equal(body.hold, true);
			const definition = agents.get(parts[1]);
			const id = `run_${runs.size + 1}`;
			const world = new FakeWorld();
			runs.set(id, { id, definition, body, task: fake.pending, world, status: "working", computer: "starting", held: "starting", polls: 0, timeline: [], cost: undefined, answer: undefined });
			return send(202, { run_id: id, status: "working", computer: { state: "starting", ...(noHeld ? {} : { held: { state: "starting", minutes: 30 } }) } });
		}
		const run = runs.get(parts[1]);
		if (parts[0] !== "runs") return send(404, { error: { code: "not_found", message: `no route ${url.pathname}` } });
		if (!run) return send(404, { error: { code: "not_found", message: `no run ${parts[1]}` } });
		const final = () => ["completed", "failed", "cancelled"].includes(run.status);
		const view = () => ({
			run_id: run.id,
			status: run.status,
			computer: { state: run.computer, provider: "fake-vendor", ...(noHeld ? {} : { held: { state: run.held, minutes: 30 } }) },
			cost: { usd: run.cost ?? null },
			result: run.status === "completed" ? { final_answer: run.answer ?? null } : null,
			error: run.error ?? null,
		});
		const letGo = (status) => {
			run.held = "released";
			run.computer = "ended";
			run.world.released = true;
			if (!final()) run.status = status;
		};
		const rest = parts.slice(2).join("/");
		if (req.method === "GET" && rest === "") {
			run.polls += 1;
			if (run.held === "starting" && run.polls >= holdPolls) [run.held, run.computer] = ["waiting", "ready"];
			return send(200, view());
		}
		if (req.method === "POST" && rest === "computer/call") {
			if (run.held === "released") return send(409, { error: { code: "computer_not_live", message: `run ${run.id}'s computer was let go` } });
			return send(200, await run.world.call(body.method, body.params));
		}
		if (req.method === "POST" && rest === "start") {
			if (run.held !== "waiting") return send(409, { error: { code: "computer_not_live", message: "not waiting" } });
			run.held = "started";
			const agent = FAKE_AGENTS[run.definition.harness];
			const row = (fields) => run.timeline.push({ id: `r${run.timeline.length + 1}`, seq: run.timeline.length + 1, timestamp: new Date().toISOString(), tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, text: null, ...fields });
			// The agent's calls as serve's Timeline shows them: a tool_use row and its tool_result row each.
			const recorded = tap(run.world, {
				phase: "agent",
				store: new Store(tmp()),
				t0: Date.now(),
				next: () => run.timeline.length + 1,
				onStep: (step) => {
					const use = `call-${step.n}`;
					row({ kind: "tool_use", tool_name: step.method, tool_use_id: use, tool_input_preview: JSON.stringify(step.params) });
					row({ kind: "tool_result", tool_name: step.method, tool_use_id: use, tool_status: step.ok ? "success" : "failed", tool_result_preview: step.ok ? "ok" : (step.error?.message ?? "") });
				},
			});
			agent(recorded, { task: run.task, signal: new AbortController().signal }).then((result) => {
				run.answer = result.answer;
				run.cost = cost;
				if (result.answer !== undefined) row({ kind: "final_answer", text: result.answer });
				if (endAs) {
					run.error = { code: endAs, message: "the model's endpoint went away" };
					letGo("failed");
				} else run.held = "ended";
			});
			return send(200, { held: { state: "started" } });
		}
		if (req.method === "GET" && rest === "timeline") {
			const after = Number(url.searchParams.get("after") ?? 0);
			const rows = run.timeline.filter((one) => one.seq > after);
			return send(200, { run_id: run.id, rows, next_after: rows.at(-1)?.seq ?? after, has_more: false });
		}
		if (req.method === "POST" && rest === "cancel") {
			letGo("cancelled");
			return send(200, view());
		}
		if (req.method === "POST" && rest === "computer/release") {
			if (run.held === "released" || final()) return send(404, { error: { code: "not_found", message: `run ${run.id}'s computer was already let go` } });
			const status = run.held === "ended" ? "completed" : "cancelled";
			letGo(status);
			return send(200, { held: { state: "released" } });
		}
		return send(404, { error: { code: "not_found", message: `no route ${url.pathname}` } });
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}/v2`;
	const released = (run) => run.held === "released";
	return { baseUrl, runs, agents, requests, released, fake, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The fake agents read the resolved task: a test backend hands it to the fake serve before each claim. */
function withTask(backend, serve) {
	return {
		id: backend.id,
		open: (request) => {
			serve.fake.pending = { params: request.task.params, nonce: request.task.nonce, task: { spec: request.task.task.spec } };
			return backend.open(request);
		},
	};
}

test("serve: a held run is set up, driven, checked before release, and released, with its steps and answer from the Timeline", async () => {
	const serve = await fakeServe({ holdPolls: 2 });
	try {
		const s = store();
		const backend = withTask(serveBackend({ baseUrl: serve.baseUrl, token: TOKEN, pollMs: 5, holdMinutes: 15 }), serve);
		const right = { ...arm("fake-right"), options: { provider: "fake-vendor", definition: { tools: ["computer"] } } };
		const results = await runBench({ tasks: fakeTasks("fake.notes.new-note", "fake.settings.device-name"), arms: [right, arm("fake-wrong")], seeds: [1], backend, store: s, grade: "never" });
		assert.deepEqual(
			results.map((result) => [result.task, result.arm, result.outcome]),
			[
				["fake.notes.new-note", "fake-right", "pass"],
				["fake.notes.new-note", "fake-wrong", "fail"],
				["fake.settings.device-name", "fake-right", "pass"],
				["fake.settings.device-name", "fake-wrong", "fail"],
			],
		);
		const [first] = results;
		assert.equal(first.steps, 4, "the agent's four calls, read from the Timeline's tool rows");
		assert.deepEqual(first.routes, {}, "a Timeline tool row says no ui.act route");
		assert.equal(first.cost_usd, 0.01);
		assert.equal(results[2].answer !== undefined, true, "the answer, from the Timeline's final answer before the release");
		for (const run of serve.runs.values()) {
			assert.equal(serve.released(run), true);
			assert.equal(run.status, "completed", "released after the agent's end, the run ends as its agent did");
			assert.deepEqual([run.body.max_cost_usd, run.body.hold, run.body.hold_minutes], [0.1, true, 15]);
			assert.deepEqual(Object.keys(run.body).sort(), ["hold", "hold_minutes", "input", "max_cost_usd"]);
		}
		const definition = [...serve.agents.values()].find((one) => one.harness === "fake-right");
		assert.deepEqual(definition.computer, { kind: "desktop", provider: "fake-vendor" });
		assert.deepEqual(definition.tools, ["computer"], "the arm's definition fields are passed as they are");
		assert.equal(definition.max_tool_calls, undefined, "the step budget is the agent's own only on pi");
		assert.equal(serve.agents.size, 2, "one agent per arm and kind, made once");
		const order = serve.requests.filter((line) => /run_1\/(computer\/call|start|computer\/release)$/.test(line)).map((line) => line.split("/run_1/")[1]);
		const start = order.indexOf("start");
		const release = order.lastIndexOf("computer/release");
		assert.ok(start > 0 && order.slice(0, start).every((one) => one === "computer/call"), "hello and setup go before the agent starts");
		assert.ok(order.slice(start + 1, release).includes("computer/call"), "the checks go after the agent and before release");
		assert.equal(release, order.length - 1);
	} finally {
		await serve.close();
	}
});

test("serve: a pi arm's agent holds the task's step budget as its max_tool_calls, one agent per budget", async () => {
	const serve = await fakeServe();
	try {
		const backend = serveBackend({ baseUrl: serve.baseUrl, token: TOKEN, pollMs: 5 });
		const [task] = fakeTasks("fake.settings.dark-theme");
		const resolved = { task, params: {}, nonce: "abc123", seed: 1, instruction: "Turn the dark theme on.", budget: { steps: 7, usd: 0.1, wall_s: 60 }, checks: [] };
		const opened = await backend.open({ task: resolved, arm: { id: "pi-a", harness: "pi", surface: "code", model: "m" }, labels: { "agentrun.bench": "b1" }, signal: AbortSignal.timeout(10_000) });
		assert.equal(opened.ok, true);
		const [definition] = serve.agents.values();
		assert.deepEqual([definition.id, definition.max_tool_calls], ["b1-pi-a-desktop-s7", 7]);
		await opened.value.release();
		assert.equal(serve.runs.get("run_1").status, "cancelled", "released before its start, the run never ran its agent");
		await opened.value.release();
	} finally {
		await serve.close();
	}
});

test("serve: a computer that can't be had is infra and run again; a run that fails for the platform is infra", async () => {
	const serve = await fakeServe({ refuseRuns: 1 });
	try {
		const backend = withTask(serveBackend({ baseUrl: serve.baseUrl, token: TOKEN, pollMs: 5 }), serve);
		const results = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("fake-right")], seeds: [1], backend, store: store(), grade: "never" });
		assert.deepEqual(
			results.map((result) => [result.outcome, result.rerun]),
			[
				["infra", true],
				["pass", false],
			],
		);
		assert.match(results[0].why, /computer_unavailable: no phone free/);
	} finally {
		await serve.close();
	}
	const broken = await fakeServe({ endAs: "model_unavailable" });
	try {
		const backend = withTask(serveBackend({ baseUrl: broken.baseUrl, token: TOKEN, pollMs: 5 }), broken);
		const results = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("fake-right")], seeds: [1], backend, store: store(), grade: "never", retries: 0 });
		assert.equal(results[0].outcome, "infra");
		assert.match(results[0].why, /model_unavailable/);
		for (const run of broken.runs.values()) assert.equal(broken.released(run), true);
	} finally {
		await broken.close();
	}
});

test("serve: verify claims held computers through the arm's agent and never starts it", async () => {
	const serve = await fakeServe();
	try {
		const backend = serveBackend({ baseUrl: serve.baseUrl, token: TOKEN, pollMs: 5 });
		const out = tmp();
		const proofs = await verifySuite({ tasks: fakeTasks("fake.settings.dark-theme", "fake.files.write"), seeds: [1], backend, arm: arm("fake-right"), nullStore: new Store(`${out}/null`), oracleStore: new Store(`${out}/oracle`) });
		assert.deepEqual(
			proofs.map((proof) => [proof.task, proof.untouched, proof.solved]),
			[
				["fake.settings.dark-theme", "fails", "passes"],
				["fake.files.write", "fails", "passes"],
			],
		);
		assert.ok(!serve.requests.some((line) => /\/run_\d+\/start$/.test(line)), "no claimed run's agent started");
		for (const run of serve.runs.values()) assert.deepEqual([serve.released(run), run.status], [true, "cancelled"]);
	} finally {
		await serve.close();
	}
});

const ROUTES = {
	call: "POST /runs/{run_id}/computer/call",
	start: "POST /runs/{run_id}/start",
	timeline: "GET /runs/{run_id}/timeline",
	release: "POST /runs/{run_id}/computer/release",
	run: "GET /runs/{run_id}",
	runs: "POST /agents/{agent_id}/runs",
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("serve before the held computer: the bench stops once, before any claim, with one error that names each missing route", async () => {
	// No hold on a run's create, no computer.held on its read, and no call, start or release.
	const serve = await fakeServe({ lacks: [ROUTES.call, ROUTES.start, ROUTES.release], keepsNo: ["hold", "hold_minutes"], noHeld: true });
	try {
		const s = store();
		const backend = serveBackend({ baseUrl: serve.baseUrl, token: TOKEN, pollMs: 5 });
		await assert.rejects(runBench({ tasks: fakeTasks("fake.notes.new-note"), arms: [arm("fake-right")], seeds: [1], backend, store: s, grade: "never" }), (error) => {
			assert.ok(error instanceof MissingRoute);
			assert.equal(error.code, "missing_route");
			assert.deepEqual(
				error.gaps.map((gap) => [gap.route, gap.what]),
				[
					[ROUTES.call, undefined],
					[ROUTES.start, undefined],
					[ROUTES.release, undefined],
					[ROUTES.runs, "its body's hold"],
					[ROUTES.run, "its answer's computer.held"],
				],
			);
			assert.match(error.message, new RegExp(`^serve at ${escape(serve.baseUrl)} lacks 5 things the bench needs:\n`));
			assert.match(error.message, /POST \/agents\/\{agent_id\}\/runs, its body's hold: the bench claims .*item 1\)\. It answered an OpenAPI document whose RunCreate has no hold/);
			assert.match(error.message, /POST \/runs\/\{run_id\}\/start: the bench starts the held run's agent .*item 1\)\. It answered 404 not_found: no route \/v2\/runs\/computer-bench-preflight-[0-9a-f]+\/start/);
			return true;
		});
		assert.equal(serve.agents.size, 0, "no agent saved");
		assert.equal(serve.runs.size, 0, "no computer claimed");
		assert.equal(existsSync(join(s.dir, "bench.json")), false, "no bench run begun");
	} finally {
		await serve.close();
	}
});

test("serve lacking one route: the preflight names it alone, whether serve answers 404 no route or 405", async () => {
	for (const [route, lackStatus] of [
		[ROUTES.call, 404],
		[ROUTES.start, 405],
		[ROUTES.timeline, 404],
		[ROUTES.release, 405],
		[ROUTES.run, 404],
		["GET /openapi.json", 404],
	]) {
		const serve = await fakeServe({ lacks: [route], lackStatus });
		try {
			const backend = serveBackend({ baseUrl: serve.baseUrl, token: TOKEN, pollMs: 5 });
			await assert.rejects(backend.preflight(AbortSignal.timeout(10_000)), (error) => {
				assert.deepEqual(
					error.gaps.map((gap) => gap.route),
					[route],
				);
				assert.match(error.message, new RegExp(`^serve at ${escape(serve.baseUrl)} lacks ${escape(route)}: the bench .* It answered ${lackStatus}`));
				return true;
			});
		} finally {
			await serve.close();
		}
	}
	// serve with every route: the preflight passes, and its probes made no agent and no run.
	const whole = await fakeServe();
	try {
		await serveBackend({ baseUrl: whole.baseUrl, token: TOKEN }).preflight(AbortSignal.timeout(10_000));
		assert.equal(whole.agents.size + whole.runs.size, 0);
	} finally {
		await whole.close();
	}
});

test("without a preflight, the first missing route still stops the bench once, its run released where serve can", async () => {
	// withTask's backend has no preflight: each route is met where the episode first needs it.
	for (const [route, released] of [
		[ROUTES.call, true],
		[ROUTES.start, true],
		[ROUTES.timeline, true],
		[ROUTES.release, false],
	]) {
		const serve = await fakeServe({ lacks: [route] });
		try {
			const backend = withTask(serveBackend({ baseUrl: serve.baseUrl, token: TOKEN, pollMs: 5 }), serve);
			await assert.rejects(runBench({ tasks: fakeTasks("fake.notes.new-note", "fake.settings.device-name"), arms: [arm("fake-right")], seeds: [1], backend, store: store(), grade: "never" }), (error) => {
				assert.ok(error instanceof MissingRoute, String(error));
				assert.match(error.message, new RegExp(`lacks ${escape(route)}: `));
				return true;
			});
			assert.equal(serve.runs.size, 1, `${route}: one claim, not run again and no next task`);
			assert.equal(serve.released(serve.runs.get("run_1")), released, route);
		} finally {
			await serve.close();
		}
	}
	// A run create that keeps no hold, and a run read with no computer.held, are named too.
	const unheld = await fakeServe({ keepsNo: ["hold"] });
	try {
		const backend = withTask(serveBackend({ baseUrl: unheld.baseUrl, token: TOKEN, pollMs: 5 }), unheld);
		await assert.rejects(runBench({ tasks: fakeTasks("fake.notes.new-note"), arms: [arm("fake-right")], seeds: [1], backend, store: store(), grade: "never" }), /lacks POST \/agents\/\{agent_id\}\/runs, its body's hold: .* It answered 422 input_invalid: The body keeps no field hold\./);
	} finally {
		await unheld.close();
	}
	const blind = await fakeServe({ noHeld: true });
	try {
		const backend = withTask(serveBackend({ baseUrl: blind.baseUrl, token: TOKEN, pollMs: 5 }), blind);
		await assert.rejects(runBench({ tasks: fakeTasks("fake.notes.new-note"), arms: [arm("fake-right")], seeds: [1], backend, store: store(), grade: "never" }), /lacks GET \/runs\/\{run_id\}, its answer's computer\.held: the bench reads where the hold is.* It answered 200 without one/);
		assert.equal(blind.runs.get("run_1").status, "cancelled");
	} finally {
		await blind.close();
	}
});

test("this repository's serve has every route the bench needs: the preflight finds nothing missing", async (t) => {
	const { startServe } = await import("@parcha/agentrun-serve");
	const server = await startServe({ data: join(tmp("cb-serve-"), "agents"), port: 0, drainTimeout: "5s" });
	t.after(() => server.close());
	await serveBackend({ baseUrl: server.baseUrl, token: server.token }).preflight(AbortSignal.timeout(30_000));
});

test("this repository's serve saves an arm's agent: its effort is the definition's thinking", async (t) => {
	const { startServe } = await import("@parcha/agentrun-serve");
	const server = await startServe({ data: join(tmp("cb-serve-"), "agents"), port: 0, drainTimeout: "5s" });
	t.after(() => server.close());
	const [task] = fakeTasks("fake.settings.dark-theme");
	const thinking = { ...arm("thinking"), harness: "pi", model: "anthropic/claude-sonnet-5-5", effort: "high", options: { provider: "docker" } };
	// This serve has no model key, so the run is refused after its agent is saved; the agent is what is read. Where a key
	// is set and the run holds a computer, it is let go at once.
	const opened = await serveBackend({ baseUrl: server.baseUrl, token: server.token }).open({ task: resolveTask(task, 1), arm: thinking, labels: { "agentrun.bench": "cb-effort" }, signal: AbortSignal.timeout(30_000) });
	if (opened.ok) await opened.value.release();
	const saved = await fetch(`${server.baseUrl}/agents/cb-effort-thinking-desktop-s${task.spec.budget.steps}`, { headers: { authorization: `Bearer ${server.token}` } });
	assert.equal(saved.status, 200, await saved.clone().text());
	const agent = await saved.json();
	assert.equal((agent.definition ?? agent).thinking, "high");
});
