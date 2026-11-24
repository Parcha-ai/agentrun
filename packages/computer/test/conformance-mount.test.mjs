// The mount group of the conformance suite against the fake provider (test/fake-computer.mjs): "mounts the run's folder"
// for each mount kind a provider declares, and the refusal of each kind it does not. No Docker. The synced folder's cases
// run the fake's computers on a real computerd in a user namespace of its own, skipped in words where the host has no
// daemon build or refuses the namespace.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import test from "node:test";
import { conformanceCases, DaemonClient, formatReport, runConformance } from "../dist/index.js";
import { main } from "../dist/conformance/cli.js";
import { computerdListening } from "./computerd-listening.mjs";
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
			["mount.archil-loop-tool-edit", "full", ["mount:archil", "exec", "files"]],
			["mount.sync-durable", "full", ["mount:sync", "exec", "files"]],
			["mount.sync-push", "full", ["mount:sync", "exec", "files"]],
			["mount.sync-delete", "full", ["mount:sync", "exec", "files"]],
			["mount.sync-cap", "full", ["mount:sync", "exec", "files"]],
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

test("the run-folder Archil case records Archil's exclusive hold refusing an outside write while the computer holds the folder, and does not fail on it", async () => {
	// The Daytona live run: the file API's write while held answered 409 OperationAborted (another client holds a write
	// delegation), which is the exclusive mount doing its job.
	const HOLD = "S3 PutObject failed: 409 OperationAborted — The path /work cannot be written because another client holds a write delegation. Release the delegation before retrying.";
	const mountFor = async (kind) => {
		const folder = await folders.mountFor(kind);
		if (folder === undefined) return undefined;
		return {
			...folder,
			write: async (path, data) => {
				if (path.startsWith("outside-")) throw new Error(HOLD);
				return folder.write(path, data);
			},
		};
	};
	const report = await run({ mount: ["archil"] }, { ids: ["mount.run-folder-archil"], mountFor });
	const [result] = report.results;
	assert.equal(result.status, "pass", result.reason);
	assert.ok(
		result.observed.some((line) => line.startsWith("outside in, while held: the file API's write was refused: ") && line.includes("409 OperationAborted")),
		JSON.stringify(result.observed),
	);
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

test("mount.archil-loop-tool-edit: a file the loop wrote through the file API before the mount, a tool edits, and the edit reads back through the file API; a tool that cannot write fails it in words", async () => {
	// The lead's ruling on the Daytona live run: object-API files read uid 0, 644, so the tools could not edit them.
	const report = await run({ mount: ["archil"] }, { ids: ["mount.archil-loop-tool-edit"] });
	const [result] = report.results;
	assert.equal(result.status, "pass", result.reason);
	assert.ok(result.observed.some((line) => line.startsWith("the file the loop wrote, seen at /workspace before the tool's edit: ")), JSON.stringify(result.observed));
	assert.ok(result.observed.some((line) => line.startsWith("the loop's read while the computer holds the folder: ")), JSON.stringify(result.observed));

	const refused = await run({ mount: ["archil"], toolCannotWrite: true }, { ids: ["mount.archil-loop-tool-edit"] });
	assert.equal(refused.results[0].status, "fail");
	assert.match(refused.results[0].reason, /a tool .* could not edit .* the file API made/);
	assert.match(refused.results[0].reason, /Permission denied/);
});

test("mount.archil-token asks exec.run for no more output than a reply line holds, and passes a fake daemon that refuses more, as computerd does", async () => {
	// Review (#1994, P2) and the Daytona live run: it asked for 4 MiB, over MAX_OUTPUT_BYTES, and failed before checking.
	const report = await run({ mount: ["archil"] }, { ids: ["mount.archil-token"] });
	const [result] = report.results;
	assert.equal(result.status, "pass", result.reason);
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
	const report = await run({ mount: ["bind", "archil", "sync"] });
	assert.deepEqual(statuses(report), { "mount.run-folder-bind": "pass", "mount.run-folder-archil": "pass", "mount.undeclared-kind": "skip" }, JSON.stringify(reasons(report)));
	assert.equal(reasons(report)["mount.undeclared-kind"], "the provider declares every mount kind (bind, archil, sync)");
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
		{ "mount.run-folder-bind": "pass", "mount.run-folder-archil": "skip", "mount.archil-durable": "skip", "mount.archil-takeover": "skip", "mount.archil-token": "skip", "mount.archil-isolated-durable": "skip", "mount.archil-loop-tool-edit": "skip", "mount.sync-durable": "skip", "mount.sync-push": "skip", "mount.sync-delete": "skip", "mount.sync-cap": "skip", "mount.undeclared-kind": "pass" },
		JSON.stringify(reasons(report)),
	);
	assert.equal(code, 3, "a run of the mount group alone leaves Core out: partial");
});

const SYNC_CASES = ["mount.sync-durable", "mount.sync-push", "mount.sync-delete", "mount.sync-cap"];
const ARCH = { x64: "amd64", arm64: "arm64" }[process.arch];
const DAEMON = fileURLToPath(new URL(`../dist/computerd-linux-${ARCH}`, import.meta.url));
const userns = spawnSync("unshare", ["-Ur", "unshare", "-n", "true"]).status === 0;
const skip = !existsSync(DAEMON) ? `needs ${DAEMON}: npm run build:daemon` : !userns ? "needs a user namespace with its capabilities (unshare -Ur), which this host refuses" : false;

/** `client` (computerd's, on this host) as a computer whose /workspace is host folder `root`: every path in and every
 *  listed path out moved between the two. `listed` changes each listed entry (a broken computer). */
function at(client, root, listed = (entry) => entry) {
	const inside = (path) => (path === "/workspace" ? root : path.startsWith("/workspace/") ? `${root}${path.slice("/workspace".length)}` : path);
	const outside = (path) => (path === root ? "/workspace" : path.startsWith(`${root}/`) ? `/workspace${path.slice(root.length)}` : path);
	return {
		async call(method, params, options) {
			const given = { ...params };
			if (typeof given.path === "string") given.path = inside(given.path);
			if (typeof given.cwd === "string") given.cwd = inside(given.cwd);
			const result = await client.call(method, given, options);
			if (method === "files.list" && result.ok) return { ok: true, value: { ...result.value, entries: result.value.entries.map((entry) => listed({ ...entry, path: outside(entry.path) })) } };
			return result;
		},
		close: () => client.close(),
	};
}

describe("the synced folder's cases, on the fake's computers run by computerd in a user namespace", { skip }, () => {
	const dir = mkdtempSync(join(tmpdir(), "computer-conformance-sync-"));
	const socket = join(dir, "computerd.sock");
	let init;
	let stderr = "";

	before(async () => {
		const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
		init = spawn("unshare", ["-Ur", DAEMON, "init", "--deadline", deadline], { env: { PATH: process.env.PATH, AGENTRUN_COMPUTERD_SOCKET: socket }, stdio: ["ignore", "ignore", "pipe"] });
		init.stderr.on("data", (chunk) => (stderr += chunk));
		await computerdListening(socket, init, () => stderr);
	});

	after(async () => {
		if (init && init.exitCode === null) {
			const ended = new Promise((resolve) => init.once("exit", resolve));
			init.kill("SIGTERM");
			await ended;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	/** The fake provider declaring the synced folder, each of its computers' /workspace a folder of its own on computerd. */
	function syncProvider(listed) {
		const { provider } = fakeComputers({ mount: ["sync"] });
		const fake = provider.connect.bind(provider);
		provider.connect = async (ref) => {
			const got = await fake(ref);
			if (!got.ok) return got;
			const root = join(dir, "computers", ref.name);
			mkdirSync(root, { recursive: true });
			const stream = connect(socket);
			await new Promise((resolve, reject) => stream.once("connect", resolve).once("error", reject));
			const daemon = new DaemonClient({ readable: stream, writable: stream });
			const close = async () => {
				daemon.close();
				stream.destroy();
				await got.value.close();
			};
			return { ok: true, value: { client: at(daemon, root, listed), hello: got.value.hello, close } };
		};
		return provider;
	}

	it("each passes a provider whose computers hold /workspace as computerd gives it", async () => {
		const report = await runConformance(syncProvider(), { image: IMAGE, cases: conformanceCases.filter((c) => SYNC_CASES.includes(c.id)) });
		assert.deepEqual(statuses(report), Object.fromEntries(SYNC_CASES.map((id) => [id, "pass"])), JSON.stringify(reasons(report)));
		assert.deepEqual(report.cleanup.left, []);
	});

	it("mount.sync-push fails a computer that lists every file 644: the push's modes are not there", async () => {
		const report = await runConformance(syncProvider((entry) => (entry.type === "file" ? { ...entry, mode: (entry.mode & ~0o7777) | 0o644 } : entry)), { image: IMAGE, cases: conformanceCases.filter((c) => c.id === "mount.sync-push") });
		assert.equal(statuses(report)["mount.sync-push"], "fail");
		assert.match(reasons(report)["mount.sync-push"], /^run\.sh: its mode, as pushed: expected "755", got "644"$/);
	});
});

test("a provider that does not declare the synced folder skips each of its cases in words", async () => {
	const report = await run({ mount: ["bind"] }, { ids: SYNC_CASES });
	assert.deepEqual(reasons(report), Object.fromEntries(SYNC_CASES.map((id) => [id, "the provider does not declare mount:sync"])));
});
