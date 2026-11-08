// The mount group of the conformance suite against the fake provider (test/fake-computer.mjs): "mounts the run's folder"
// for each mount kind a provider declares, and the refusal of each kind it does not. No Docker, no daemon binary.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import test from "node:test";
import { conformanceCases, formatReport, runConformance } from "../dist/index.js";
import { main } from "../dist/conformance/cli.js";
import { fakeComputers, fakeRunFolders } from "./fake-computer.mjs";

const IMAGE = "debian:bookworm-slim";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const MOUNT_CASES = ["mount.run-folder-bind", "mount.run-folder-archil", "mount.undeclared-kind"];
const statuses = (report) => Object.fromEntries(report.results.map((r) => [r.id, r.status]));
const reasons = (report) => Object.fromEntries(report.results.filter((r) => r.reason).map((r) => [r.id, r.reason]));
const folders = fakeRunFolders();
after(() => folders.remove());

/** The mount group's report for a fake with these options, given run folders unless mountFor is null. */
async function run(options = {}, { mountFor = folders.mountFor, ids = MOUNT_CASES } = {}) {
	const { provider } = fakeComputers({ disks: folders.disks, ...options });
	return runConformance(provider, { image: IMAGE, cases: conformanceCases.filter((c) => ids.includes(c.id)), ...(mountFor ? { mountFor } : {}) });
}

test("the mount group: one case per mount kind, the Archil contract's four, and one for the kinds a provider does not declare, every one Full", () => {
	const mount = conformanceCases.filter((c) => c.group === "mount");
	assert.deepEqual(
		mount.map((c) => [c.id, c.level, c.needs]),
		[
			["mount.run-folder-bind", "full", ["mount:bind", "exec", "files"]],
			["mount.run-folder-archil", "full", ["mount:archil", "exec", "files"]],
			["mount.archil-durable", "full", ["mount:archil", "exec", "files"]],
			["mount.archil-takeover", "full", ["mount:archil", "exec", "files"]],
			["mount.archil-token", "full", ["mount:archil", "exec"]],
			["mount.archil-isolated-durable", "full", ["mount:archil", "exec", "files"]],
			["mount.undeclared-kind", "full", []],
		],
	);
});

test("the run-folder Archil case records both directions while the computer holds the folder, and asserts neither", async () => {
	const report = await run({ mount: ["archil"] }, { ids: ["mount.run-folder-archil"] });
	const [result] = report.results;
	assert.equal(result.status, "pass", result.reason);
	assert.equal(result.observed.length, 4, JSON.stringify(result.observed));
	// What the file API gives a file and a folder it makes, as the computer sees them: the owner a tool writes against.
	assert.match(result.observed[0], /^a file the file API made, seen at \/workspace: /);
	assert.match(result.observed[1], /^a folder the file API made, seen at \/workspace: /);
	assert.match(result.observed[2], /^outside in, while held: a file the file API wrote is read at \/workspace as written$/);
	assert.match(result.observed[3], /^inside out, while held: a file files\.write made \(synced before it answered\) is read through the file API as written$/);
});

test("the run-folder Archil case labels its computer for the folder's own run, as the helper's rule asks, even when the run folder does not say its run", async () => {
	const run = "r42";
	const folder = `agents/conformance/runs/${run}/work`;
	const dir = join(folders.disks["fake-disk"], folder);
	mkdirSync(dir, { recursive: true });
	// A run folder like one from before RunFolder had its run: the mount alone says it.
	const mountFor = (kind) =>
		kind !== "archil"
			? undefined
			: {
					mount: { kind: "archil", disk: "fake-disk", region: "fake-region-1", folder, token: "tok-run-folder-label-0123456789" },
					read: async (path) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path)) : undefined),
					write: async (path, data) => {
						mkdirSync(dirname(join(dir, path)), { recursive: true });
						if (!path.endsWith("/")) writeFileSync(join(dir, path), data);
					},
					close: async () => rmSync(dir, { recursive: true, force: true }),
				};
	const { provider } = fakeComputers({ disks: folders.disks, mount: ["archil"] });
	const check = provider.check.bind(provider);
	// The helper's rule, as every remote provider's check applies it: the folder is the labelled run's.
	provider.check = (spec) => [...check(spec), ...(spec.mount?.kind === "archil" && spec.labels?.["agentrun.run"] !== run ? [{ field: "mount", message: `mount.folder is run ${run}'s folder, not the labelled run's` }] : [])];
	const report = await runConformance(provider, { image: IMAGE, cases: conformanceCases.filter((c) => c.id === "mount.run-folder-archil"), mountFor });
	assert.equal(report.results[0].status, "pass", report.results[0].reason);
});

test("mount.run-folder-bind passes a fake that binds the run's folder at /workspace; the Archil case skips in words", async () => {
	const report = await run({ mount: ["bind"] });
	assert.deepEqual(statuses(report), { "mount.run-folder-bind": "pass", "mount.run-folder-archil": "skip", "mount.undeclared-kind": "pass" }, JSON.stringify(reasons(report)));
	assert.equal(reasons(report)["mount.run-folder-archil"], "the provider does not declare mount:archil");
	assert.deepEqual(report.undeclared, ["mount:archil"]);
	assert.deepEqual(report.cleanup.left, []);
	const text = formatReport(report);
	assert.match(text, /^full mount +run-folder-bind run-folder-archil +✓ 2 - 1$/m, text);
});

test("mount.run-folder-archil passes a fake that mounts the Archil folder, and the bind case skips", async () => {
	const report = await run({ mount: ["archil"] });
	assert.deepEqual(statuses(report), { "mount.run-folder-bind": "skip", "mount.run-folder-archil": "pass", "mount.undeclared-kind": "pass" }, JSON.stringify(reasons(report)));
});

test("a provider that declares no mount kind skips both run-folder cases in words and still refuses each kind", async () => {
	const report = await run();
	assert.deepEqual(statuses(report), { "mount.run-folder-bind": "skip", "mount.run-folder-archil": "skip", "mount.undeclared-kind": "pass" }, JSON.stringify(reasons(report)));
	assert.equal(reasons(report)["mount.run-folder-bind"], "the provider does not declare mount:bind");
});

test("a provider that declares every kind has nothing for mount.undeclared-kind to refuse: it skips in words", async () => {
	const report = await run({ mount: ["bind", "archil"] });
	assert.deepEqual(statuses(report), { "mount.run-folder-bind": "pass", "mount.run-folder-archil": "pass", "mount.undeclared-kind": "skip" }, JSON.stringify(reasons(report)));
	assert.equal(reasons(report)["mount.undeclared-kind"], "the provider declares every mount kind (bind, archil)");
});

test("a run given no run folders skips the run-folder case in words: the provider's conformance module supplies mountFor", async () => {
	const report = await run({ mount: ["bind"] }, { mountFor: null });
	assert.equal(statuses(report)["mount.run-folder-bind"], "skip");
	assert.equal(reasons(report)["mount.run-folder-bind"], "the run was given no run folder for mount kind bind: a provider's conformance module exports mountFor(kind)");
	const none = await run({ mount: ["bind"] }, { mountFor: () => undefined });
	assert.equal(reasons(none)["mount.run-folder-bind"], "the run was given no run folder for mount kind bind: mountFor(\"bind\") made none");
});

test("the runner closes each run folder a case asked for when the case ends, pass or fail", async () => {
	const own = fakeRunFolders();
	try {
		await run({ mount: ["bind", "archil"] }, { mountFor: own.mountFor, ids: ["mount.run-folder-bind", "mount.run-folder-archil"] });
		await run({ mount: ["bind"], brokenMount: "unbound" }, { mountFor: own.mountFor, ids: ["mount.run-folder-bind"] });
		assert.deepEqual(own.closed().map((mount) => mount.kind), ["bind", "archil", "bind"]);
	} finally {
		own.remove();
	}
});

/** For each case: a fake broken the way the case checks for, and what the failure says. */
const BROKEN = [
	// The fake claims the mount and reads it back, but nothing is bound at /workspace.
	["mount.run-folder-bind", { mount: ["bind"], brokenMount: "unbound" }, /^files\.read: not_found: /],
	["mount.run-folder-archil", { mount: ["archil"], brokenMount: "unbound" }, /^files\.read: not_found: /],
	["mount.run-folder-bind", { mount: ["bind"], brokenMount: "no-read-back" }, /^attach by id: the mount it reads back: expected \{"kind":"bind","path":".*"\}, got undefined$/],
	["mount.run-folder-archil", { mount: ["archil"], brokenMount: "token-in-read-back" }, /^attach by id: the mount it reads back holds the Archil token$/],
	["mount.run-folder-archil", { mount: ["archil"], brokenMount: "no-region" }, /^attach by id: the mount it reads back: expected \{"kind":"archil","disk":"fake-disk","region":"fake-region-1","folder":"runs\/[0-9a-f]+","exclusive":true,"epoch":1\}, got \{"kind":"archil","disk":"fake-disk","folder":/],
	["mount.run-folder-archil", { mount: ["archil"], brokenMount: "token-in-label" }, /^list: what it reads back of the computer holds the Archil token$/],
	// A provider that declares a kind its host cannot give (a Docker host that remaps ids, for a bind) fails, in its words.
	["mount.run-folder-bind", { mount: ["bind"], brokenMount: "host-refuses" }, /^check refuses a spec that mounts the run's folder of kind bind, which the provider declares: mount: this host cannot bind the run folder$/],
	["mount.undeclared-kind", { mount: ["bind"], brokenMount: "check-ignores" }, /^check refuses a mount of kind archil, which the provider does not declare, in words: \[\]$/],
];

for (const [id, options, words] of BROKEN) {
	test(`${id} fails a fake that is broken (${JSON.stringify(options)})`, async () => {
		const report = await run(options, { ids: [id] });
		assert.equal(statuses(report)[id], "fail", `${id}: ${reasons(report)[id] ?? "passed"}`);
		assert.match(reasons(report)[id], words);
		assert.deepEqual(report.cleanup.left, []);
	});
}

test("no failure of an Archil case prints the token", async () => {
	const own = fakeRunFolders();
	const tokens = [];
	const mountFor = (kind) => {
		const folder = own.mountFor(kind);
		if (folder?.mount.token) tokens.push(folder.mount.token);
		return folder;
	};
	try {
		for (const brokenMount of ["unbound", "no-read-back", "token-in-read-back", "token-in-label"]) {
			const report = await run({ mount: ["archil"], brokenMount, disks: own.disks }, { mountFor, ids: ["mount.run-folder-archil"] });
			const text = `${formatReport(report)}${JSON.stringify(report)}`;
			for (const token of tokens) assert.ok(!text.includes(token), `${brokenMount}: the report holds the token`);
		}
		assert.equal(tokens.length, 4);
	} finally {
		own.remove();
	}
});

test("the CLI passes a provider module's mountFor to the run: --only mount runs the mount group", async () => {
	let text = "";
	const stdout = { write: (chunk, done) => ((text += chunk), done?.(), true) };
	const code = await main(["--provider", "./fixtures/mount-provider.mjs", "--only", "mount", "--json"], { stdout, cwd: HERE });
	const report = JSON.parse(text);
	assert.deepEqual(
		statuses(report),
		{ "mount.run-folder-bind": "pass", "mount.run-folder-archil": "skip", "mount.archil-durable": "skip", "mount.archil-takeover": "skip", "mount.archil-token": "skip", "mount.archil-isolated-durable": "skip", "mount.undeclared-kind": "pass" },
		JSON.stringify(reasons(report)),
	);
	assert.equal(code, 3, "a run of the mount group alone leaves Core out: partial");
});
