// The OSWorld loader (scripts/port-osworld.mjs): OSWorld task JSONs in, computer-bench tasks out that run OSWorld's own
// setup and evaluator through osw, every file they download or compare with pinned to a revision and a sha256, and
// each task the bench desktop can't run refused with its reason. And the exec check's `infra` exit codes, which the
// generated checks use for osw's 75: a check that could not run is infra, run again, never a fail.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadSuite, loadTask, resolveTask, runChecks, stage1Of, TaskError } from "../dist/index.js";
import { ROOT, tmp } from "./support.mjs";

const FIXTURE = join(ROOT, "test", "fixtures", "osworld-port");
const OSWORLD = join(FIXTURE, "osworld");
const DATASET = "e28460ae734cb1b33901d232cef8747c20ccd677";
const CACHE = "https://huggingface.co/datasets/xlangai/ubuntu_osworld_file_cache/resolve/";
const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
// Imported in each test, so the check tests below run, and fail on their own, without it.
const loader = () => import("../scripts/port-osworld.mjs");

async function portFixture(sums = json(join(FIXTURE, "sums.json"))) {
	const { portAll, treeOf } = await loader();
	return portAll({ osworld: OSWORLD, trees: new Map([[DATASET, treeOf(json(join(FIXTURE, "tree.json")))]]), sums });
}

test("the loader writes each portable fixture's task.json as expected, and the suite it writes loads", async () => {
	const { writeSuite, INFEASIBLE_RUBRIC } = await loader();
	const out = tmp("osw-port-");
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

test("each fixture the bench desktop can't run is refused with its reason, and PORT.md lists it", async () => {
	const { writeSuite } = await loader();
	const results = await portFixture();
	const refused = Object.fromEntries(results.filter((one) => one.reasons).map((one) => [`${one.domain}/${one.uuid.slice(0, 8)}`, one.reasons]));
	assert.deepEqual(refused, {
		"chrome/7b6c7e24": ["opens or reads a live host: www.amazon.com"],
		"os/a4d98375": ["the check reads GNOME-only state (gsettings)"],
		"vs_code/7aeae0e2": ["the check reads the accessibility tree over GNOME's AT-SPI (accessibility_tree)"],
	});
	const out = tmp("osw-port-");
	writeSuite(results, out);
	const port = read(join(out, "PORT.md"));
	assert.match(port, /\| `chrome\/7b6c7e24-c58a-49fc-a5bb-d57b80e5b4c3` \| opens or reads a live host: www\.amazon\.com \|/);
	assert.match(port, /\| `os\/a4d98375-215b-4a4d-aee9-3d4370fccc41` \| the check reads GNOME-only state \(gsettings\) \|/);
	assert.match(port, /\| `vs_code\/7aeae0e2-70ee-4705-821d-1bba5d5b2ddd` \| the check reads the accessibility tree over GNOME's AT-SPI \(accessibility_tree\) \|/);
	assert.match(port, /\| \*\*all\*\* \| \*\*7\*\* \| \*\*4\*\* \| \*\*1\*\* \| \*\*3\*\* \| \*\*4\*\* \|/);
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

test("infra is an exec check's list of exit codes, never the code it passes on", () => {
	const spec = (check) => ({ id: "t.infra", version: 1, title: "t", split: "dev", needs: { os: "linux", kind: "desktop" }, instruction: "i", budget: { steps: 1, usd: 1, wall_s: 1 }, checks: [check] });
	const write = (check) => {
		const dir = tmp("osw-infra-");
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
