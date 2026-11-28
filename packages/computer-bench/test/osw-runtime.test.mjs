// osw, the bench image's runtime for OSWorld tasks (image/osw/osw): `osw setup` and `osw eval` driven as the bench
// drives them, against a stand-in for OSWorld's code (fixtures/osworld-stub: its in-VM server, controllers, getters and
// metrics, stdlib only) and a loopback file host for the pinned downloads and golds.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { ROOT, tmp } from "./support.mjs";

const OSW = join(ROOT, "image", "osw", "osw");
const STUB = join(ROOT, "test", "fixtures", "osworld-stub");
const INFRA = 75;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const freePort = () =>
	new Promise((resolve, reject) => {
		const server = createTcpServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

const listening = (port) =>
	new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1");
		socket.on("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
	});

/** A box: the desktop user's HOME, the cache osw keeps, OSWorld's (stand-in) code, and the port its server takes. */
async function box(t) {
	const dir = tmp("osw-");
	const home = join(dir, "home");
	mkdirSync(home);
	const osworld = join(dir, "osworld");
	cpSync(STUB, osworld, { recursive: true });
	const port = await freePort();
	const env = { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1", OSW_OSWORLD: osworld, OSW_PORT: String(port), OSW_CACHE: join(dir, "cache"), OSW_HOME: home };
	const requests = () => (existsSync(join(home, "requests.log")) ? readFileSync(join(home, "requests.log"), "utf8").trim().split("\n") : []);
	t.after(async () => assert.equal(await listening(port), false, "no osw server is left listening"));
	return { dir, home, port, env, requests, cache: (id) => join(dir, "cache", id) };
}

/** Runs `python3 osw <command> <task.json>`; `onSpawn` gets the child (to signal it). */
function osw(b, command, task, onSpawn) {
	const file = join(b.dir, `${task.id}.${command}.json`);
	writeFileSync(file, JSON.stringify(task));
	return new Promise((resolve, reject) => {
		const child = spawn("python3", [OSW, command, file], { env: b.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		onSpawn?.(child);
	});
}

/** A loopback file host: each path's bytes, and how many times each was asked for. */
async function files(t, served) {
	const hits = {};
	const server = createServer((request, response) => {
		hits[request.url] = (hits[request.url] ?? 0) + 1;
		const body = served[request.url];
		if (body === undefined) return response.writeHead(404).end();
		response.writeHead(200, { "Content-Length": body.length }).end(body);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const base = `http://127.0.0.1:${server.address().port}`;
	return { url: (path) => `${base}${path}`, hits: (path) => hits[path] ?? 0 };
}

const rule = (rules) => ({ type: "rule", rules });

test("osw setup runs the task's config through SetupController against a server it starts on 127.0.0.1 as the desktop user, then stops the server; an app it launched stays up", async (t) => {
	const b = await box(t);
	const sleeper = ["python3", "-c", "import time; time.sleep(60)"];
	const task = { id: "setup-1", config: [{ type: "launch", parameters: { command: sleeper } }, { type: "execute", parameters: { command: ["echo", "ready"] } }], evaluator: { func: "score", result: rule({ score: 1 }) } };
	const ran = await osw(b, "setup", task);
	assert.equal(ran.code, 0, ran.stderr);
	assert.equal(await listening(b.port), false, "the server is stopped when osw setup returns");
	const log = b.requests();
	assert.equal(log[0], `listening 127.0.0.1 ${b.port} home=${b.home} cwd=${b.home}`);
	assert.deepEqual(
		log.slice(1).filter((line) => !line.startsWith("launched")),
		["GET /terminal", `POST /setup/launch ${JSON.stringify({ command: sleeper, shell: false })}`, `POST /execute ${JSON.stringify({ command: ["echo", "ready"] })}`],
	);
	const pid = Number(log.find((line) => line.startsWith("launched")).split(" ")[1]);
	assert.doesNotThrow(() => process.kill(pid, 0), "the launched app outlives the server");
	process.kill(pid, "SIGKILL");
});

test("a config step that fails ends osw setup as infra, its server stopped", async (t) => {
	const b = await box(t);
	const ran = await osw(b, "setup", { id: "setup-2", config: [{ type: "fail", parameters: {} }], evaluator: { func: "score", result: rule({ score: 1 }) } });
	assert.equal(ran.code, INFRA, ran.stderr);
	assert.match(ran.stderr, /Setup step 1 failed/);
});

test("conj: `or` passes when one metric is 1, `and` needs every one; each metric gets its own options", async (t) => {
	const b = await box(t);
	const evaluator = (conj, second) => ({ func: ["options_equal", "options_equal"], conj, result: [rule({ a: 1 }), rule({ b: 2 })], options: [{ a: 1 }, second] });
	const or = await osw(b, "eval", { id: "conj-or", evaluator: evaluator("or", { b: 3 }) });
	assert.equal(or.code, 0, or.stderr);
	const and = await osw(b, "eval", { id: "conj-and", evaluator: evaluator("and", { b: 3 }) });
	assert.equal(and.code, 1, and.stderr);
	assert.match(and.stdout, /score 0\b/);
	const both = await osw(b, "eval", { id: "conj-and-both", evaluator: evaluator("and", { b: 2 }) });
	assert.equal(both.code, 0, both.stderr);
	assert.match(both.stdout, /score 1\b/);
	const unset = await osw(b, "eval", { id: "conj-default", evaluator: { ...evaluator(undefined, { b: 3 }), conj: undefined } });
	assert.equal(unset.code, 1, "conj defaults to and");
});

test("postconfig's steps run in order, before the getters read the result", async (t) => {
	const b = await box(t);
	const result = join(b.home, "out.txt");
	writeFileSync(result, "done\n");
	const gold = Buffer.from("done\n");
	const host = await files(t, { "/gold.txt": gold });
	const task = {
		id: "post-1",
		evaluator: {
			postconfig: [
				{ type: "execute", parameters: { command: ["first"] } },
				{ type: "execute", parameters: { command: ["second"] } },
			],
			func: "compare_bytes",
			result: { type: "vm_file", path: result, dest: "out.txt" },
			expected: { type: "cloud_file", path: host.url("/gold.txt"), dest: "gold.txt", sha256: sha256(gold) },
		},
	};
	const ran = await osw(b, "eval", task);
	assert.equal(ran.code, 0, ran.stderr);
	assert.deepEqual(b.requests().slice(1), ["GET /terminal", `POST /execute ${JSON.stringify({ command: ["first"] })}`, `POST /execute ${JSON.stringify({ command: ["second"] })}`, `POST /file ${result}`]);
});

test("the gold is fetched by osw eval alone, checked against its pinned sha256, into a folder only its owner reads; a mismatched gold is infra", async (t) => {
	const b = await box(t);
	const result = join(b.home, "out.txt");
	writeFileSync(result, "done\n");
	const gold = Buffer.from("done\n");
	const host = await files(t, { "/gold.txt": gold });
	const task = (id, pinned) => ({
		id,
		evaluator: { func: "compare_bytes", result: { type: "vm_file", path: result, dest: "out.txt" }, expected: { type: "cloud_file", path: host.url("/gold.txt"), dest: "gold.txt", sha256: pinned } },
	});

	const setup = await osw(b, "setup", task("gold-1", sha256(gold)));
	assert.equal(setup.code, 0, setup.stderr);
	assert.equal(host.hits("/gold.txt"), 0, "setup fetches no gold");
	const checked = await osw(b, "eval", task("gold-1", sha256(gold)));
	assert.equal(checked.code, 0, checked.stderr);
	assert.equal(host.hits("/gold.txt"), 1);
	assert.equal(readFileSync(join(b.cache("gold-1"), "gold.txt"), "utf8"), "done\n");
	for (const dir of [join(b.dir, "cache"), b.cache("gold-1")]) assert.equal(statSync(dir).mode & 0o777, 0o700, `${dir} is its owner's alone`);

	const wrong = await osw(b, "eval", task("gold-2", sha256(Buffer.from("something else"))));
	assert.equal(wrong.code, INFRA, wrong.stderr);
	assert.match(wrong.stderr, /sha256/);
	assert.equal(existsSync(join(b.cache("gold-2"), "gold.txt")), false, "a mismatched gold is not kept");

	const unpinned = await osw(b, "eval", { id: "gold-3", evaluator: { ...task("gold-3", "x").evaluator, expected: { type: "cloud_file", path: host.url("/gold.txt"), dest: "gold.txt" } } });
	assert.equal(unpinned.code, 2, "a cloud file without a pinned sha256 is a bad task");
});

test("osw setup fetches the config's downloads checked against their pinned sha256 before SetupController uploads them", async (t) => {
	const b = await box(t);
	const input = Buffer.from("a,b\n1,2\n");
	const host = await files(t, { "/input.csv": input });
	const download = (pinned) => ({ type: "download", parameters: { files: [{ url: host.url("/input.csv"), path: join(b.home, "input.csv"), sha256: pinned }] } });
	const evaluator = { func: "score", result: rule({ score: 1 }) };

	const good = await osw(b, "setup", { id: "dl-1", config: [download(sha256(input))], evaluator });
	assert.equal(good.code, 0, good.stderr);
	assert.equal(readFileSync(join(b.home, "input.csv"), "utf8"), "a,b\n1,2\n");
	assert.equal(host.hits("/input.csv"), 1, "SetupController found it fetched");

	const bad = await osw(b, "setup", { id: "dl-2", config: [download(sha256(Buffer.from("other")))], evaluator });
	assert.equal(bad.code, INFRA, bad.stderr);
	assert.match(bad.stderr, /sha256/);
	assert.equal(b.requests().filter((line) => line.startsWith("POST /setup/upload")).length, 1, "the mismatched input is never uploaded");
});

test("a score below 1 exits 1; a missing result file scores 0, as OSWorld has it; a getter that crashes exits 75, infra; a task osw can't check exits 2", async (t) => {
	const b = await box(t);
	const half = await osw(b, "eval", { id: "half", evaluator: { func: "score", result: rule({ score: 0.5 }) } });
	assert.equal(half.code, 1, half.stderr);
	assert.match(half.stdout, /score 0\.5/);

	const missing = await osw(b, "eval", { id: "missing", evaluator: { func: "score", result: { type: "missing", path: "/nowhere" } } });
	assert.equal(missing.code, 1, missing.stderr);

	const crashed = await osw(b, "eval", { id: "crash", evaluator: { func: "score", result: { type: "crash" } } });
	assert.equal(crashed.code, INFRA, crashed.stderr);
	assert.match(crashed.stderr, /the getter crashed/);
	assert.equal(await listening(b.port), false);

	const infeasible = await osw(b, "eval", { id: "infeasible", evaluator: { func: "infeasible" } });
	assert.equal(infeasible.code, 2, infeasible.stderr);
	const unknown = await osw(b, "eval", { id: "unknown", evaluator: { func: "no_such_metric", result: rule({}) } });
	assert.equal(unknown.code, 2, unknown.stderr);
});

test("osw eval stopped by SIGTERM stops its server and exits 75", async (t) => {
	const b = await box(t);
	let child;
	const running = osw(b, "eval", { id: "slow", evaluator: { func: "score", result: { type: "slow" } } }, (spawned) => (child = spawned));
	const deadline = Date.now() + 30_000;
	while (!(await listening(b.port))) {
		assert.ok(Date.now() < deadline, "the server came up");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	// The server is up before the getters run: wait for the getter, past postconfig's /terminal probe.
	while (!b.requests().includes("GET /terminal")) await new Promise((resolve) => setTimeout(resolve, 100));
	child.kill("SIGTERM");
	const ran = await running;
	assert.equal(ran.code, INFRA, ran.stderr);
	assert.equal(await listening(b.port), false);
});
