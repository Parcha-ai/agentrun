// The serve backend against a fake serve that keeps the contract README.md proposes: a run held for the bench, its
// computer reached through /computer/call, its agent started by /start, its steps read from the journal, and its
// computer released by the bench. The fake serve's computers are fake worlds and its agents the fake agents.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { FAKE_AGENTS, FakeWorld } from "../dist/fake-world.js";
import { runBench, serveBackend, Store, tap, verifySuite } from "../dist/index.js";
import { arm, fakeTasks, store, tmp } from "./support.mjs";

const TOKEN = "t0ken";

/** A fake serve: the routes the bench calls, over fake worlds. */
async function fakeServe({ holdPolls = 1, endAs, cost = 0.01, refuseRuns = 0 } = {}) {
	const agents = new Map();
	const runs = new Map();
	const requests = [];
	let refused = 0;
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
		if (req.method === "POST" && parts.join("/") === "agents") {
			const { definition } = body;
			if (agents.has(definition.id)) return send(409, { error: { code: "conflict", message: "exists" } });
			agents.set(definition.id, definition);
			return send(201, { agent_id: definition.id });
		}
		if (req.method === "POST" && parts[0] === "agents" && parts[2] === "runs") {
			if (refused < refuseRuns) {
				refused += 1;
				return send(503, { error: { code: "computer_unavailable", message: "no phone free" } });
			}
			assert.equal(body.hold, "bench");
			const definition = agents.get(parts[1]);
			const id = `run_${runs.size + 1}`;
			const world = new FakeWorld();
			runs.set(id, { id, definition, body, world, status: "working", computer: "starting", polls: 0, journal: [], released: false, cost: undefined, answer: undefined });
			return send(201, { run_id: id, status: "working", computer: { state: "starting" } });
		}
		const run = runs.get(parts[1]);
		if (parts[0] !== "runs" || !run) return send(404, { error: { code: "not_found" } });
		const view = () => ({ run_id: run.id, status: run.status, computer: { state: run.computer, provider: "fake-vendor" }, cost: { usd: run.cost ?? null }, answer: run.answer ?? null, error: run.error ?? null });
		const rest = parts.slice(2).join("/");
		if (req.method === "GET" && rest === "") {
			run.polls += 1;
			if (run.computer === "starting" && run.polls >= holdPolls) run.computer = "held";
			return send(200, view());
		}
		if (req.method === "POST" && rest === "computer/call") {
			if (run.released) return send(410, { error: { code: "gone", message: "released" } });
			return send(200, await run.world.call(body.method, body.params));
		}
		if (req.method === "POST" && rest === "start") {
			run.computer = "ready";
			const agent = FAKE_AGENTS[run.definition.harness];
			const recorded = tap(run.world, { phase: "agent", store: new Store(tmp()), t0: Date.now(), next: () => run.journal.length + 1, onStep: (step) => run.journal.push({ id: `j${run.journal.length + 1}`, kind: "agentrun.computer.step", data: step }) });
			// The fake agents read the resolved task: withTask below sends it in a label for this fake serve alone.
			agent(recorded, { task: JSON.parse(run.body.labels["test.task"]), signal: new AbortController().signal }).then((result) => {
				run.answer = result.answer;
				run.cost = cost;
				if (endAs) {
					run.status = "failed";
					run.error = { code: endAs, message: "the model's endpoint went away" };
				} else run.status = "completed";
			});
			return send(200, { status: "working" });
		}
		if (req.method === "GET" && rest === "journal") {
			const after = url.searchParams.get("after");
			const from = after ? run.journal.findIndex((entry) => entry.id === after) + 1 : 0;
			const entries = run.journal.slice(from);
			return send(200, { entries, has_more: false, next_after: entries.at(-1)?.id ?? after });
		}
		if (req.method === "POST" && rest === "cancel") {
			if (run.status === "working") run.status = "cancelled";
			return send(200, view());
		}
		if (req.method === "POST" && rest === "computer/release") {
			if (run.released) return send(404, { error: { code: "not_found" } });
			run.released = true;
			run.world.released = true;
			run.computer = "ended";
			if (run.status === "working") run.status = "cancelled";
			return send(200, {});
		}
		return send(404, { error: { code: "not_found", message: `${req.method} ${url.pathname}` } });
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}/v2`;
	return { baseUrl, runs, agents, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** The fake agents read the resolved task; a test backend hands it over through a label the fake serve reads. */
function withTask(backend) {
	return { id: backend.id, open: (request) => backend.open({ ...request, labels: { ...request.labels, "test.task": JSON.stringify({ params: request.task.params, nonce: request.task.nonce, task: { spec: request.task.task.spec } }) } }) };
}

test("serve: a held run is set up, driven, checked before release, and released, with its steps from the journal", async () => {
	const serve = await fakeServe({ holdPolls: 2 });
	try {
		const s = store();
		const backend = withTask(serveBackend({ baseUrl: serve.baseUrl, token: TOKEN, pollMs: 5 }));
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
		assert.equal(first.steps, 4, "the agent's four calls, read from the journal");
		assert.deepEqual(first.routes, { semantic: 4 });
		assert.equal(first.cost_usd, 0.01);
		assert.equal(results[2].answer !== undefined, true);
		for (const run of serve.runs.values()) {
			assert.equal(run.released, true);
			assert.equal(run.body.max_cost_usd, 0.1);
			assert.match(run.body.labels["agentrun.bench.run"], /^fake\./);
		}
		const definition = [...serve.agents.values()].find((one) => one.harness === "fake-right");
		assert.deepEqual(definition.computer, { kind: "desktop", provider: "fake-vendor" });
		assert.deepEqual(definition.tools, ["computer"], "the arm's definition fields are passed as they are");
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

test("serve: a computer that can't be had is infra and run again; a run that fails for the platform is infra", async () => {
	const serve = await fakeServe({ refuseRuns: 1 });
	try {
		const backend = withTask(serveBackend({ baseUrl: serve.baseUrl, token: TOKEN, pollMs: 5 }));
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
		const backend = withTask(serveBackend({ baseUrl: broken.baseUrl, token: TOKEN, pollMs: 5 }));
		const results = await runBench({ tasks: fakeTasks("fake.settings.dark-theme"), arms: [arm("fake-right")], seeds: [1], backend, store: store(), grade: "never", retries: 0 });
		assert.equal(results[0].outcome, "infra");
		assert.match(results[0].why, /model_unavailable/);
		for (const run of broken.runs.values()) assert.equal(run.released, true);
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
		assert.ok(!serve.requests.some((line) => line.endsWith("/start")));
		for (const run of serve.runs.values()) assert.equal(run.released, true);
	} finally {
		await serve.close();
	}
});
