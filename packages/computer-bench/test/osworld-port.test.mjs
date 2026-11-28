// The OSWorld loader (scripts/port-osworld.mjs): OSWorld task JSONs in, computer-bench tasks out that run OSWorld's own
// setup and evaluator through osw, every file they download or compare with pinned to a revision and a sha256, and
// each task the bench desktop can't run refused with its reason. And the exec check's `infra` exit codes, which the
// generated checks use for osw's 75: a check that could not run is infra, run again, never a fail.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { FakeWorld, fakeBackend } from "../dist/fake-world.js";
import { loadSuite, loadTask, resolveTask, runBench, runChecks, Store, stage1Of, TaskError } from "../dist/index.js";
import { arm, ROOT, tmp } from "./support.mjs";

const OSW = join(ROOT, "image", "osw", "osw.py");
const FIXTURE = join(ROOT, "test", "fixtures", "osworld-port");
const OSWORLD = join(FIXTURE, "osworld");
const DATASET = "e28460ae734cb1b33901d232cef8747c20ccd677";
const CACHE = "https://huggingface.co/datasets/xlangai/ubuntu_osworld_file_cache/resolve/";
const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
// Imported in each test, so the check tests below run, and fail on their own, without it.
const loader = () => import("../scripts/port-osworld.mjs");

/** A new folder under the system's temp folder, removed when the test ends. */
function scratch(t, prefix) {
	const dir = tmp(prefix);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function portFixture(sums = json(join(FIXTURE, "sums.json"))) {
	const { portAll, treeOf } = await loader();
	return portAll({ osworld: OSWORLD, trees: new Map([[DATASET, treeOf(json(join(FIXTURE, "tree.json")))]]), sums });
}

test("the loader writes each portable fixture's task.json as expected, and the suite it writes loads", async (t) => {
	const { writeSuite, INFEASIBLE_RUBRIC } = await loader();
	const out = scratch(t, "osw-port-");
	const written = writeSuite(await portFixture(), out);
	assert.deepEqual([...written].sort(), ["chrome-bb5e4c0d", "gimp-dbbf4b99", "gimp-fbb548ca", "libreoffice-calc-1273e544"]);
	for (const folder of written) {
		assert.equal(read(join(out, folder, "task.json")), read(join(FIXTURE, "expected", folder, "task.json")), `${folder}/task.json`);
	}
	assert.equal(read(join(out, "gimp-fbb548ca", "rubric.md")), INFEASIBLE_RUBRIC, "the infeasible task gets the shared rubric");
	const tasks = loadSuite(out);
	assert.deepEqual(tasks.map((task) => task.spec.id).sort(), ["osworld-verified.chrome.bb5e4c0d", "osworld-verified.gimp.dbbf4b99", "osworld-verified.gimp.fbb548ca", "osworld-verified.libreoffice-calc.1273e544"]);
	// osworld.json reaches osw whole: the setup and the check inline it as one argv word, unchanged by the fill.
	const calc = resolveTask(tasks.find((task) => task.spec.id.endsWith("1273e544")), 1);
	const inlined = read(join(out, "libreoffice-calc-1273e544", "osworld.json"));
	assert.deepEqual(calc.setup[0].params.argv.slice(3), ["sh", inlined]);
	assert.deepEqual(calc.checks[0].argv.slice(3), ["sh", inlined]);
});

test("each fixture the bench desktop can't run is refused with its reason, and PORT.md lists it", async (t) => {
	const { writeSuite } = await loader();
	const results = await portFixture();
	const refused = Object.fromEntries(results.filter((one) => one.reasons).map((one) => [`${one.domain}/${one.uuid.slice(0, 8)}`, one.reasons]));
	assert.deepEqual(refused, {
		"chrome/7b6c7e24": ["opens or reads a live host: www.amazon.com"],
		"os/a4d98375": ["the check reads GNOME-only state (gsettings)"],
		"vs_code/7aeae0e2": ["the check reads the accessibility tree over GNOME's AT-SPI (accessibility_tree)"],
	});
	const out = scratch(t, "osw-port-");
	writeSuite(results, out);
	const port = read(join(out, "PORT.md"));
	assert.match(port, /\| `chrome\/7b6c7e24-c58a-49fc-a5bb-d57b80e5b4c3` \| opens or reads a live host: www\.amazon\.com \|/);
	assert.match(port, /\| `os\/a4d98375-215b-4a4d-aee9-3d4370fccc41` \| the check reads GNOME-only state \(gsettings\) \|/);
	assert.match(port, /\| `vs_code\/7aeae0e2-70ee-4705-821d-1bba5d5b2ddd` \| the check reads the accessibility tree over GNOME's AT-SPI \(accessibility_tree\) \|/);
	assert.match(port, /\| \*\*all\*\* \| \*\*7\*\* \| \*\*4\*\* \| \*\*1\*\* \| \*\*3\*\* \| \*\*4\*\* \|/);
});

test("a task whose setup or check runs sudo is refused: osw runs as the computer's own user, with no root", async () => {
	const { classify, osworldNames } = await loader();
	const names = osworldNames(OSWORLD);
	const NO_ROOT = "a setup or check step runs sudo, and the bench desktop gives no root: osw runs as the computer's own user";
	const task = (config, command) => ({ id: "00000000-0000-0000-0000-000000000000", related_apps: ["os"], config, evaluator: { func: "exact_match", result: { type: "vm_command_line", command }, expected: { type: "rule", rules: { expected: "x" } } } });
	const execute = (line) => [{ type: "execute", parameters: { command: ["bash", "-c", line] } }];
	assert.ok(classify(task(execute("echo {CLIENT_PASSWORD} | sudo -S apt-get install -y expect"), "which expect"), names).reasons.includes(NO_ROOT), "in the config");
	assert.ok(classify(task([], ["bash", "-c", "echo '{CLIENT_PASSWORD}' | sudo -S cat /etc/shadow"]), names).reasons.includes(NO_ROOT), "in the check");
	assert.ok(classify({ ...task([], "true"), evaluator: { ...task([], "true").evaluator, postconfig: execute("sudo mkdir /opt/x") } }, names).reasons.includes(NO_ROOT), "in the postconfig");
	assert.equal(classify(task(execute("mkdir ~/sudoku"), "ls ~"), names).reasons.includes(NO_ROOT), false, "a word with sudo in it is not sudo");
});

test("a port that now refuses a task removes its folder from an earlier port, in the domains it writes alone", async (t) => {
	const { writeSuite } = await loader();
	const ids = (out) => loadSuite(out).map((task) => task.spec.id).sort();
	const out = scratch(t, "osw-port-");
	writeSuite(await portFixture(), out);
	writeFileSync(join(out, "chrome-bb5e4c0d", "kept.txt"), "an earlier port's\n");
	// Without the sums, the calc task's two files have no sha256: refused.
	const unsummed = await portFixture({});
	assert.ok(unsummed.find((one) => one.uuid.startsWith("1273e544")).reasons);
	// A port of another domain leaves the calc folder alone.
	writeSuite(unsummed, out, ["gimp"]);
	assert.ok(ids(out).includes("osworld-verified.libreoffice-calc.1273e544"));
	// A port of the calc domain removes it; the chrome folder, not written by this port, stays as it was.
	const written = writeSuite(unsummed, out, ["libreoffice_calc"]);
	assert.deepEqual(ids(out), ["osworld-verified.chrome.bb5e4c0d", "osworld-verified.gimp.dbbf4b99", "osworld-verified.gimp.fbb548ca"]);
	assert.equal(written.has("libreoffice-calc-1273e544"), false);
	assert.equal(read(join(out, "chrome-bb5e4c0d", "kept.txt")), "an earlier port's\n");
});

test("osworld.json is OSWorld's JSON with each file-cache URL at a revision and each download and gold given its sha256", async () => {
	const results = await portFixture();
	const calc = JSON.parse(results.find((one) => one.folder === "libreoffice-calc-1273e544").files["osworld.json"]);
	const source = json(join(OSWORLD, "evaluation_examples", "examples", "libreoffice_calc", "1273e544-688f-496b-8d89-3e0f40aa0606.json"));
	assert.match(calc.notice, /^From OSWorld \(https:\/\/github\.com\/xlang-ai\/OSWorld, Apache-2\.0, Copyright 2024 XLANG NLP Lab\)/);
	assert.deepEqual(calc.config[0].parameters.files, [
		{ url: `${CACHE}${DATASET}/libreoffice_calc/1273e544-688f-496b-8d89-3e0f40aa0606/NetIncome.xlsx`, path: "/home/user/NetIncome.xlsx", sha256: "4bf3c94407240969c2dc55b098d2fab6b247f3b530fe48bae0f39a923b397300" },
	]);
	assert.deepEqual(calc.evaluator.expected, {
		type: "cloud_file",
		path: `${CACHE}${DATASET}/libreoffice_calc/1273e544-688f-496b-8d89-3e0f40aa0606/3_NetIncome_gt1.xlsx`,
		dest: "3_NetIncome_gt1.xlsx",
		sha256: "42d66bba3e1906eb41b397d010394da08cc296b017ec295bcffc139788341fb6",
	});
	// Everything else is OSWorld's, as it was.
	const { notice: _a, config: _b, evaluator: pinned, ...rest } = calc;
	const { notice: _c, config: _d, evaluator: original, ...restSource } = source;
	assert.deepEqual(rest, restSource);
	assert.deepEqual({ ...pinned, expected: undefined }, { ...original, expected: undefined });
	// An LFS file's sha256 is the tree's own.
	const gimp = JSON.parse(results.find((one) => one.folder === "gimp-dbbf4b99").files["osworld.json"]);
	assert.equal(gimp.config[0].parameters.files[0].sha256, "31c0aeec617ddc8f6a60eea02a2594e6956a047c9f30d56f1416ff1520860aaf");
	assert.equal(gimp.config[0].parameters.files[0].url, `${CACHE}${DATASET}/gimp/dbbf4b99-2253-4b10-9274-45f246af2466/yicun.raw`);
});

test("a file with no sha256 refuses its task, naming it; sums fetches each such file once and checks it against its git oid", async () => {
	const { fetchSums, gitOid } = await loader();
	const results = await portFixture({});
	const calc = results.find((one) => one.uuid.startsWith("1273e544"));
	assert.equal(calc.folder, undefined);
	assert.deepEqual(calc.reasons, [
		"libreoffice_calc/1273e544-688f-496b-8d89-3e0f40aa0606/NetIncome.xlsx has no sha256: it is not an LFS file, and the sums don't have its oid ff6b6dc4d60842efdb10a2aa8dc002e64014587d",
		"libreoffice_calc/1273e544-688f-496b-8d89-3e0f40aa0606/3_NetIncome_gt1.xlsx has no sha256: it is not an LFS file, and the sums don't have its oid e209478923b2894fa0618df1579ddc3593230fb7",
	]);
	// A stand-in for the cache: bytes whose git oid the tree gives, as the real files' are.
	const bytes = (size) => Buffer.alloc(size, 7);
	const wanted = calc.unsummed.map((file) => ({ ...file, oid: gitOid(bytes(file.size)) }));
	const fetched = [];
	const sums = {};
	assert.equal(await fetchSums([{ unsummed: wanted }, { unsummed: [wanted[0]] }], sums, async (url) => (fetched.push(url), bytes(wanted.find((file) => url.endsWith(file.path.split("/").pop())).size))), 2);
	assert.deepEqual(fetched, [`${CACHE}${DATASET}/libreoffice_calc/1273e544-688f-496b-8d89-3e0f40aa0606/NetIncome.xlsx`, `${CACHE}${DATASET}/libreoffice_calc/1273e544-688f-496b-8d89-3e0f40aa0606/3_NetIncome_gt1.xlsx`]);
	assert.equal(Object.keys(sums).length, 2);
	await assert.rejects(fetchSums([{ unsummed: [wanted[0]] }], {}, async () => bytes(wanted[0].size + 1)), /the tree says 9201 bytes/);
});

test("a URL pinned to a revision whose tree is missing, or to a file the tree lacks, is refused", async () => {
	const { pinTask, treeOf } = await loader();
	const trees = new Map([[DATASET, treeOf(json(join(FIXTURE, "tree.json")))]]);
	const task = (url) => ({ id: "x", config: [{ type: "download", parameters: { files: [{ url, path: "/home/user/a" }] } }], evaluator: { func: "exact_match" } });
	assert.deepEqual(pinTask(task(`${CACHE}249d2aa77e3e3d0c0220405b251236c376044f2f/multi_apps/a/b.pdf`), { trees, sums: {} }).problems, ["multi_apps/a/b.pdf is pinned to dataset revision 249d2aa77e3e3d0c0220405b251236c376044f2f, whose tree was not given"]);
	assert.deepEqual(pinTask(task(`${CACHE}main/gimp/nothing.raw`), { trees, sums: {} }).problems, ["gimp/nothing.raw is not in the file cache at revision e28460ae"]);
	assert.deepEqual(pinTask(task("https://huggingface.co/datasets/other/resolve/main/a.raw"), { trees, sums: {} }).problems, ["https://huggingface.co/datasets/other/resolve/main/a.raw is not in OSWorld's file cache, so it can't be pinned"]);
	// A URL at its own revision keeps it.
	const kept = pinTask(task(`${CACHE}${DATASET}/gimp/dbbf4b99-2253-4b10-9274-45f246af2466/yicun.raw`), { trees, sums: {} });
	assert.deepEqual(kept.problems, []);
	assert.equal(kept.json.config[0].parameters.files[0].url, `${CACHE}${DATASET}/gimp/dbbf4b99-2253-4b10-9274-45f246af2466/yicun.raw`);
});

/** A computer whose every exec exits with this code. */
const exitsWith = (exitCode) => ({ call: async () => ({ ok: true, value: { exitCode, stdout: Buffer.from(`score ${exitCode === 0 ? 1 : 0}\n`).toString("base64"), stderr: "", timedOut: false } }) });
const OSW_CHECK = { id: "osworld", kind: "exec", why: "osw eval", argv: ["osw", "eval", "task.json"], infra: [75] };

test("an exec check's infra exit code means it could not run: 75 is an error (infra, run again), 1 still a fail, 0 a pass", async () => {
	const [infra] = await runChecks([OSW_CHECK], { wire: exitsWith(75) });
	assert.equal(infra.status, "error", infra.reason);
	assert.match(infra.reason, /exited 75, which the check names infra/);
	assert.equal(stage1Of([infra]), "error");
	const [fail] = await runChecks([OSW_CHECK], { wire: exitsWith(1) });
	assert.equal(fail.status, "fail", fail.reason);
	assert.equal(fail.reason, "exited 1, not 0");
	const [pass] = await runChecks([OSW_CHECK], { wire: exitsWith(0) });
	assert.equal(pass.status, "pass", pass.reason);
	// Without infra, 75 is a fail like any other exit.
	const { infra: _, ...plain } = OSW_CHECK;
	assert.equal((await runChecks([plain], { wire: exitsWith(75) }))[0].status, "fail");
});

test("infra is an exec check's list of exit codes, never the code it passes on", (t) => {
	const spec = (check) => ({ id: "t.infra", version: 1, title: "t", split: "dev", needs: { os: "linux", kind: "desktop" }, instruction: "i", budget: { steps: 1, usd: 1, wall_s: 1 }, checks: [check] });
	const write = (check) => {
		const dir = scratch(t, "osw-infra-");
		writeFileSync(join(dir, "task.json"), JSON.stringify(spec(check)));
		return loadTask(dir);
	};
	assert.deepEqual(write(OSW_CHECK).spec.checks[0].infra, [75]);
	const problems = (check) => {
		try {
			write(check);
		} catch (error) {
			assert.ok(error instanceof TaskError, String(error));
			return error.problems.join("\n");
		}
		return "";
	};
	assert.match(problems({ ...OSW_CHECK, infra: [0] }), /infra.*0.*passes/);
	assert.match(problems({ ...OSW_CHECK, exit: 3, infra: [3, 75] }), /infra.*3.*passes/);
	assert.notEqual(problems({ ...OSW_CHECK, infra: [] }), "", "an empty list names nothing");
	assert.notEqual(problems({ id: "f", kind: "file", why: "w", path: "/a", infra: [75] }), "", "a file check has no exit code");
});

/**
 * A folder for the front of PATH: `osw` as given, and a `sudo` that refuses as it does under computerd's no_new_privs
 * (writing that it ran to sudo.log), so no test here ever reaches the host's own sudo.
 */
function binWith(t, osw) {
	const bin = scratch(t, "osw-bin-");
	writeFileSync(join(bin, "osw"), osw, { mode: 0o755 });
	writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho ran >> ${bin}/sudo.log\necho 'sudo: The "no new privileges" flag is set, which prevents sudo from running as root.' >&2\nexit 1\n`, { mode: 0o755 });
	return { bin, env: { PATH: `${bin}:${process.env.PATH}` } };
}

/** The fixture suite's calc task, as the loader writes it. */
async function portedCalc(t) {
	const { writeSuite } = await loader();
	const out = scratch(t, "osw-port-");
	writeSuite(await portFixture(), out);
	return { out, task: loadSuite(out).find((task) => task.spec.id.endsWith("1273e544")) };
}

const freePort = () =>
	new Promise((resolve, reject) => {
		const server = createTcpServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});

/**
 * The calc task's check, run by a real `sh` as the desktop would run it, with `osw` on PATH as given. With `osworld`
 * true its OSWorld JSON is a stand-in task that scores 1 on osw's stub OSWorld (test/fixtures/osworld-stub), so osw
 * runs a whole eval: its server, a getter and a metric.
 */
async function runCheck(t, osw, { osworld = false, more = () => {} } = {}) {
	const { task } = await portedCalc(t);
	const { checks, nonce } = resolveTask(task, 1);
	const [check] = checks;
	// The run's own cache, which osw eval makes.
	t.after(() => rmSync(`/tmp/computer-bench-${nonce}-osw-cache`, { recursive: true, force: true }));
	const { bin, env } = binWith(t, osw);
	more(bin, env);
	const argv = [...check.argv];
	if (osworld) {
		const dir = scratch(t, "osw-stub-");
		cpSync(join(ROOT, "test", "fixtures", "osworld-stub"), join(dir, "osworld"), { recursive: true });
		mkdirSync(join(dir, "home"));
		Object.assign(env, { OSW_OSWORLD: join(dir, "osworld"), OSW_HOME: join(dir, "home"), OSW_PORT: String(await freePort()) });
		argv[argv.length - 1] = JSON.stringify({ id: "eq-1", evaluator: { func: "score", result: { type: "rule", rules: { score: 1 } } } });
	}
	return { check, bin, ...spawnSync(argv[0], argv.slice(1), { env, encoding: "utf8", timeout: 60_000 }) };
}

test("the check runs osw only when it is the bench's osw.py: a changed one refuses the eval in words, infra, never a score", async (t) => {
	const { OSW_SHA256 } = await loader();
	const bench = read(OSW);
	assert.equal(OSW_SHA256, createHash("sha256").update(bench).digest("hex"), "the tasks pin the bench's own osw.py");

	// Changed in the agent's turn (the computer's own user can write it): refused before it runs.
	const changed = await runCheck(t, `${bench}\nraise SystemExit(0)\n`);
	assert.deepEqual(changed.check.infra, [75]);
	assert.equal(changed.status, 75, changed.stderr);
	assert.match(changed.stderr, new RegExp(`osw \\(${changed.bin}/osw\\) is not the bench's osw\\.py: its sha256 is [0-9a-f]{64}, the bench's is ${OSW_SHA256}; the check refuses to run it, and the task is not scored`));
	// The bench's own runs a whole eval as the check runs it: its server, a getter and a metric, a score of 1.
	const same = await runCheck(t, bench, { osworld: true });
	assert.equal(same.status, 0, same.stderr);
	assert.match(same.stdout, /^score 1$/m);
	assert.equal(existsSync(join(same.bin, "sudo.log")), false, "no sudo");
});

test("the check runs the bytes it checked: osw changed on disk once they are read still runs the bench's own", async (t) => {
	const bench = read(OSW);
	const real = spawnSync("sh", ["-c", "command -v sha256sum"], { encoding: "utf8" }).stdout.trim();
	assert.ok(real, "sha256sum is on PATH");
	// sha256sum, the step after the read, stands in for an agent loop: it changes osw on disk (and any file it is
	// given) to one that would exit 42, then answers as the real one does.
	const ran = await runCheck(t, bench, {
		osworld: true,
		more: (bin) => {
			writeFileSync(join(bin, "changed.py"), `raise SystemExit(42)\n${bench}`);
			writeFileSync(join(bin, "sha256sum"), `#!/bin/sh\nout=$(${real} "$@")\nfor f in ${bin}/osw "$@"; do [ -f "$f" ] && cp ${bin}/changed.py "$f"; done\nprintf '%s\\n' "$out"\n`, { mode: 0o755 });
		},
	});
	assert.equal(read(join(ran.bin, "osw")).startsWith("raise SystemExit(42)"), true, "osw was changed on disk");
	assert.equal(ran.status, 0, ran.stderr);
	assert.match(ran.stdout, /^score 1$/m);
});

test("a ported osw task passes its preconditions on a desktop with osw and no sudo, and its setup runs osw setup on the task's OSWorld JSON as the desktop's own user", async (t) => {
	const { out, task } = await portedCalc(t);
	const nonce = resolveTask(task, 1).nonce;
	const ran = join(scratch(t, "osw-ran-"), "osw.log");
	// A stand-in osw: what it was asked, its cache, and its stdin.
	const { bin, env } = binWith(t, `#!/bin/sh\necho "$* OSW_CACHE=$OSW_CACHE" >> ${ran}\ncat > ${ran}.$1.stdin\n`);
	const setupFiles = ["log", "exit"].map((end) => `/tmp/computer-bench-${nonce}-osw-setup.${end}`);
	const clear = () => setupFiles.forEach((path) => rmSync(path, { force: true }));
	clear();
	try {
		// The fake desktop, with exec.run and process.start run for real with that PATH, and the task's apps installed.
		const world = new FakeWorld({ os: "linux", groups: ["exec", "processes", "apps", "files"] });
		const output = (child) =>
			new Promise((resolve) => {
				const stdout = [];
				const stderr = [];
				child.stdout.on("data", (chunk) => stdout.push(chunk));
				child.stderr.on("data", (chunk) => stderr.push(chunk));
				child.on("close", (code) => resolve({ ok: true, value: { exitCode: code, stdout: Buffer.concat(stdout).toString("base64"), stderr: Buffer.concat(stderr).toString("base64"), timedOut: false } }));
			});
		const wire = {
			call(method, params, options) {
				if (method === "apps.list") return Promise.resolve({ ok: true, value: { apps: task.spec.needs.apps.map((id) => ({ id })) } });
				if (method === "exec.run") return output(spawn(params.argv[0], params.argv.slice(1), { env, timeout: params.timeoutMs }));
				if (method === "process.start") {
					const child = spawn(params.argv[0], params.argv.slice(1), { env, stdio: "ignore" });
					return new Promise((resolve) => child.on("spawn", () => resolve({ ok: true, value: { id: String(child.pid) } })));
				}
				return world.call(method, params, options);
			},
		};
		const backend = fakeBackend({ agents: {}, connect: async () => ({ wire, close: async () => {} }) });
		const [result] = await runBench({ tasks: [task], arms: [arm("none")], seeds: [1], backend, store: new Store(scratch(t, "osw-store-")), mode: "null", frames: false, retries: 0, grade: "never" });
		assert.notEqual(result.phase, "preconditions", result.why);
		assert.notEqual(result.phase, "setup", result.why);
		assert.equal(read(ran).split("\n")[0], `setup /dev/stdin OSW_CACHE=/tmp/computer-bench-${nonce}-osw-cache`);
		assert.equal(read(`${ran}.setup.stdin`), read(join(out, "libreoffice-calc-1273e544", "osworld.json")), "the task's OSWorld JSON reaches osw whole");
		assert.equal(existsSync(join(bin, "sudo.log")), false, "no sudo");
	} finally {
		clear();
	}
});
