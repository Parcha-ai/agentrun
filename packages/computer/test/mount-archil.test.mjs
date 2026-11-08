// The Archil mount's shared part (src/mount-archil.ts), with a fake root channel and a fake computerd client: no vendor,
// no archil, no root. Every provider's Archil computer goes through it: the spec rule, the steps at create (preflight,
// takeover, mount or revoke, serve) through the provider's own root exec, the syncing client, the read-back and
// the release. The token reaches the helper's stdin alone, and no refusal, error, argv or label holds it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as computer from "../dist/index.js";

const {
	ARCHIL_HELPER,
	ARCHIL_MOUNT_LABEL,
	archilLabels,
	archilMount,
	archilReadBack,
	archilRefusals,
	archilRelease,
	helperSha256,
	recordedMount,
	syncingClient,
	EPOCH_LABEL,
	RUN_LABEL,
} = computer;

const TOKEN = "tok-archil-shared-0123456789abcdef";
const RUN = "r1";
const MOUNT = { kind: "archil", disk: "dsk-00000000000baf76", region: "aws-us-east-1", folder: `agents/a1/runs/${RUN}/work`, token: TOKEN };
const LABELS = { [RUN_LABEL]: RUN, [EPOCH_LABEL]: "3" };
const SPEC = { image: "snap", lifetimeMs: 60_000, network: "none", labels: LABELS, mount: MOUNT };
const HELPER_SHA = createHash("sha256").update(readFileSync(new URL("../box/agentrun-archil", import.meta.url))).digest("hex");
const ok = (value) => ({ ok: true, value });
const fail = (code, message) => ({ ok: false, error: { code, message } });
const noToken = (value, what) => assert.ok(!JSON.stringify(value ?? null).includes(TOKEN), `${what} holds the token`);

/** What a computer's preflight prints when it is as the image makes it. */
const GOOD_PREFLIGHT = ["uid 0", `helper ${HELPER_SHA} -rwxr-xr-x 0 0`, "archil Archil Client: v0.10.1-1793222256, 1001, proto=Version2", "tool 2510:2510", "sudo none"].join("\n");

/** A root channel that records each call and answers by the helper's verb (or "preflight"). */
function fakeRoot(answers = {}) {
	const calls = [];
	return {
		calls,
		verbs: () => calls.map(({ argv }) => (argv[0] === ARCHIL_HELPER ? argv[1] : "preflight")),
		async run(argv, options) {
			calls.push({ argv: [...argv], stdin: options.stdin });
			const verb = argv[0] === ARCHIL_HELPER ? argv[1] : "preflight";
			const answer = answers[verb] ?? (verb === "preflight" ? { exitCode: 0, output: GOOD_PREFLIGHT } : { exitCode: 0, output: "" });
			return typeof answer === "function" ? answer(argv, options) : "ok" in answer ? answer : ok(answer);
		},
	};
}

const released = (refs = []) => async () => ok({ released: refs, kept: [], unproven: [] });

test("archilRefusals: an Archil spec takes network none, the run and epoch labels, the helper's shapes and a disk token, in words that never hold the token", () => {
	assert.deepEqual(archilRefusals(SPEC), []);
	const cases = [
		[{ network: "open" }, /network/, "network open"],
		[{ network: { allow: ["1.1.1.1/32"] } }, /network/, "an allowlist"],
		[{ labels: { [EPOCH_LABEL]: "3" } }, /agentrun\.run/, "no run label"],
		[{ labels: { [RUN_LABEL]: RUN } }, /agentrun\.epoch/, "no epoch label"],
		[{ labels: { ...LABELS, [EPOCH_LABEL]: "03" } }, /agentrun\.epoch/, "an epoch that is not one"],
		[{ mount: { ...MOUNT, folder: "runs/r1" } }, /mount\.folder/, "a folder of another shape"],
		[{ mount: { ...MOUNT, folder: "agents/a1/runs/r2/work" } }, /run r2.*agentrun\.run/, "another run's folder"],
		[{ mount: { ...MOUNT, disk: "dsk;rm" } }, /mount\.disk/, "a disk of another shape"],
		[{ mount: { ...MOUNT, region: "us" } }, /mount\.region/, "a region with no provider"],
		[{ mount: { ...MOUNT, token: "short" } }, /mount\.token/, "a token too short"],
		[{ mount: { ...MOUNT, token: `${TOKEN} x` } }, /mount\.token/, "a token with a space"],
	];
	for (const [change, words, what] of cases) {
		const refusals = archilRefusals({ ...SPEC, ...change });
		assert.ok(refusals.some(({ message }) => words.test(message)), `${what}: ${JSON.stringify(refusals)}`);
		noToken(refusals, what);
	}
	// A token put in the wrong field is not echoed either.
	noToken(archilRefusals({ ...SPEC, mount: { ...MOUNT, folder: TOKEN } }), "a token in the folder");
	assert.deepEqual(archilRefusals({ ...SPEC, mount: undefined }), [], "no mount: nothing to refuse here");
	assert.deepEqual(archilRefusals({ ...SPEC, mount: { kind: "bind", path: "/x" } }), [], "a bind is not this rule's");
});

test("archilMount: preflight, the takeover, mount, then serve, each as root through the provider's own exec (no netlock: the tools' network is init's own namespace); the token on the mount's stdin alone", async () => {
	const root = fakeRoot();
	const done = await archilMount({ root, mount: MOUNT, releaseOlder: released(), timeoutMs: 1000 });
	assert.deepEqual(done, ok(undefined));
	assert.deepEqual(root.verbs(), ["preflight", "mount", "serve"]);
	assert.deepEqual(root.calls[1].argv, [ARCHIL_HELPER, "mount", MOUNT.disk, MOUNT.region, MOUNT.folder]);
	assert.equal(root.calls[1].stdin, `${TOKEN}\n`);
	assert.deepEqual(root.calls[2].argv, [ARCHIL_HELPER, "serve"]);
	for (const [at, call] of root.calls.entries()) {
		noToken(call.argv, `call ${at}'s argv`);
		if (at !== 1) assert.equal(call.stdin, undefined, `call ${at} gets no stdin`);
	}
	assert.equal(computer.archilNetwork, undefined, "no netlock read-back");
});

test("archilMount: a takeover releases the lower epochs before any mount; released any, or the folder held, it revokes; a failed release revokes nothing", async () => {
	const order = [];
	const root = fakeRoot();
	const wrapped = {
		run: (argv, options) => {
			order.push(argv[0] === ARCHIL_HELPER ? argv[1] : "preflight");
			return root.run(argv, options);
		},
	};
	const releasing = async () => {
		order.push("releaseOlder");
		return ok({ released: [{ id: "old", name: "old" }], kept: [], unproven: [] });
	};
	assert.deepEqual(await archilMount({ root: wrapped, mount: MOUNT, releaseOlder: releasing, timeoutMs: 1000 }), ok(undefined));
	// The computer is proven as the image makes it before any older one is destroyed for it.
	assert.deepEqual(order, ["preflight", "releaseOlder", "revoke", "serve"]);
	assert.equal(root.calls.find(({ argv }) => argv[1] === "revoke").stdin, `${TOKEN}\n`);

	const held = fakeRoot({ mount: { exitCode: 1, output: "mount failed: dsk:/agents/a1/runs/r1/work has an outstanding delegation" } });
	assert.deepEqual(await archilMount({ root: held, mount: MOUNT, releaseOlder: released(), timeoutMs: 1000 }), ok(undefined));
	assert.deepEqual(held.verbs(), ["preflight", "mount", "revoke", "serve"], "held by a client no listing shows: revoke, then serve");

	for (const failed of [fail("refused", "fenced: run r1 has c at epoch 4, above this claim's epoch 3"), fail("daytona", "could not release old")]) {
		const nothing = fakeRoot();
		const result = await archilMount({ root: nothing, mount: MOUNT, releaseOlder: async () => failed, timeoutMs: 1000 });
		assert.equal(result.ok, false);
		assert.match(result.error.message, /takeover/);
		assert.ok(result.error.message.includes(failed.error.message));
		assert.deepEqual(nothing.verbs(), ["preflight"], "no mount, no revoke");
	}
});

test("archilMount: another computer of the run at the claim's own epoch is never forced off: a held folder then refuses in words, and a takeover of lower epochs mounts without force", async () => {
	const SELF = { id: "c-new", name: "c-new" };
	const twin = { id: "c-twin", name: "c-twin" };
	const keeping = (released = []) => async () => ok({ released, kept: [SELF, twin], unproven: [] });

	const held = fakeRoot({ mount: { exitCode: 1, output: "mount failed: dsk:/agents/a1/runs/r1/work has an outstanding delegation" } });
	const refused = await archilMount({ root: held, mount: MOUNT, self: SELF, releaseOlder: keeping(), timeoutMs: 1000 });
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "refused");
	assert.match(refused.error.message, /c-twin/);
	assert.match(refused.error.message, /same epoch|epoch 3/);
	noToken(refused, "the refusal");
	assert.deepEqual(held.verbs(), ["preflight", "mount"], "no revoke, no serve");

	const takeover = fakeRoot();
	assert.deepEqual(await archilMount({ root: takeover, mount: MOUNT, self: SELF, releaseOlder: keeping([{ id: "old", name: "old" }]), timeoutMs: 1000 }), ok(undefined));
	assert.deepEqual(takeover.verbs(), ["preflight", "mount", "serve"], "lower epochs released, but a twin is listed: mount, never revoke");

	// The computer itself, listed at its own epoch, is no twin.
	const alone = fakeRoot({ mount: { exitCode: 1, output: "mount failed: dsk:/agents/a1/runs/r1/work has an outstanding delegation" } });
	assert.deepEqual(await archilMount({ root: alone, mount: MOUNT, self: SELF, releaseOlder: async () => ok({ released: [], kept: [SELF], unproven: [] }), timeoutMs: 1000 }), ok(undefined));
	assert.deepEqual(alone.verbs(), ["preflight", "mount", "revoke", "serve"]);
});

test("archilMount: a preflight that differs from the image refuses before anything else, naming each difference", async () => {
	const wrong = ["uid 1000", "helper 0000 -rwxrwxrwx 1000 1000", "archil Archil Client: v0.10.0-1792692895", "tool 1000:1000", "sudo /usr/bin/sudo"].join("\n");
	const root = fakeRoot({ preflight: { exitCode: 0, output: wrong } });
	const result = await archilMount({ root, mount: MOUNT, releaseOlder: released(), timeoutMs: 1000 });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "refused");
	for (const words of [/not root/, /helper/, /0\.10\.1/, /agentrun-tool/, /sudo/]) assert.match(result.error.message, words);
	assert.deepEqual(root.verbs(), ["preflight"]);
});

test("archilMount: each step's failure stops the next, in words that never hold the token, even when the computer printed it", async () => {
	for (const [verb, answer, words] of [
		["mount", { exitCode: 4, output: "agentrun-archil: /proc is not mounted with hidepid=2" }, /hidepid/],
		["mount", { exitCode: 1, output: `archil: bad token ${TOKEN}` }, /mount.*exit 1/],
		["serve", { exitCode: 4, output: "agentrun-archil: computerd at /opt/agentrun/computerd is not root's alone" }, /serve.*root's alone/],
		["mount", fail("daytona", `the exec failed with ${TOKEN}`), /mount/],
	]) {
		const root = fakeRoot({ [verb]: answer });
		const result = await archilMount({ root, mount: MOUNT, releaseOlder: released(), timeoutMs: 1000 });
		assert.equal(result.ok, false, verb);
		assert.match(result.error.message, words, verb);
		noToken(result, `${verb}'s failure`);
		const steps = root.verbs();
		assert.equal(steps.at(-1), verb, `${verb}: nothing after it`);
	}
});

/** A computerd client that answers every call, mount.sync with `syncs` in order (default exit 0), and records each. */
function fakeClient({ syncs = [], answer = () => ok({}), syncDelay = 0 } = {}) {
	const calls = [];
	let at = 0;
	return {
		calls,
		methods: () => calls.map(([method]) => method),
		async call(method, params) {
			calls.push([method, params]);
			if (method === "mount.sync") {
				if (syncDelay) await new Promise((resolve) => setTimeout(resolve, syncDelay));
				const next = syncs[at++] ?? ok({ exitCode: 0 });
				return next;
			}
			return answer(method, params);
		},
		close() {},
	};
}

test("syncingClient: every call that may change the folder syncs before it answers; a read does not", async () => {
	const mutating = [
		["files.write", { path: "/workspace/a", data: "" }],
		["files.move", { from: "/workspace/a", to: "/workspace/b" }],
		["files.remove", { path: "/workspace/b" }],
		["files.mkdir", { path: "/workspace/d" }],
		["tar.push.end", { id: "t" }],
		["exec.run", { argv: ["true"], timeoutMs: 1000 }],
		// Review (#1994, P1): process.start makes its log file, and any missing folder above it, which may be in /workspace.
		["process.start", { argv: ["sleep", "60"], log: "/workspace/logs/run.log" }],
		["process.write", { id: "p", data: "" }],
		["process.signal", { id: "p", signal: "TERM" }],
		["process.wait", { id: "p" }],
	];
	for (const [method, params] of mutating) {
		const client = fakeClient();
		const result = await syncingClient(client).call(method, params);
		assert.equal(result.ok, true, method);
		assert.deepEqual(client.methods(), [method, "mount.sync"], method);
	}
	for (const [method, params] of [["files.read", { path: "/workspace/a" }], ["files.stat", { path: "/" }], ["files.list", { path: "/" }], ["process.list", {}], ["tar.push.write", { id: "t", data: "" }], ["hello", { client: "x" }]]) {
		const client = fakeClient();
		await syncingClient(client).call(method, params);
		assert.deepEqual(client.methods(), [method], `${method} does not sync`);
	}
	// A process seen ended syncs; a read of one still running does not.
	for (const [exited, expected] of [[true, ["process.read", "mount.sync"]], [false, ["process.read"]]]) {
		const client = fakeClient({ answer: () => ok({ data: "", nextOffset: 0, dropped: 0, exited, size: 0 }) });
		await syncingClient(client).call("process.read", { id: "p" });
		assert.deepEqual(client.methods(), expected, `process.read, exited ${exited}`);
	}
});

test("syncingClient: a sync that fails fails the call in words; a call that failed still syncs, and answers its own error", async () => {
	for (const sync of [ok({ exitCode: 1 }), fail("not_found", "no Archil sync server at /run/agentrun-archil/archil.sock")]) {
		const client = fakeClient({ syncs: [sync] });
		const result = await syncingClient(client).call("files.write", { path: "/workspace/a", data: "" });
		assert.equal(result.ok, false, JSON.stringify(sync));
		assert.match(result.error.message, /files\.write .*durable/);
	}
	const client = fakeClient({ answer: () => fail("denied", "permission denied") });
	const result = await syncingClient(client).call("files.write", { path: "/workspace/a", data: "" });
	assert.deepEqual(result, fail("denied", "permission denied"));
	assert.deepEqual(client.methods(), ["files.write", "mount.sync"]);
});

test("syncingClient: coalesced: calls during a sync in flight wait for it, then share one more", async () => {
	const client = fakeClient({ syncDelay: 30 });
	const syncing = syncingClient(client);
	const first = syncing.call("files.write", { path: "/workspace/1", data: "" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	const rest = await Promise.all([2, 3, 4].map((n) => syncing.call("files.write", { path: `/workspace/${n}`, data: "" })));
	await first;
	assert.ok(rest.every((result) => result.ok));
	assert.equal(client.methods().filter((method) => method === "mount.sync").length, 2, "one in flight, then one shared by the three");
});

test("syncingClient: a caller whose signal fires stops waiting for the sync, in words; the sync goes on, and others still wait for it", async () => {
	// Review (#1994, P1): the sync is held until the test lets it go, so no clock is involved.
	let finish;
	const held = new Promise((resolve) => {
		finish = resolve;
	});
	const calls = [];
	const client = {
		async call(method) {
			calls.push(method);
			if (method === "mount.sync") return held;
			return ok({});
		},
		close() {},
	};
	const syncing = syncingClient(client);
	const stopping = new AbortController();
	const cancelled = syncing.call("files.write", { path: "/workspace/a", data: "" }, { signal: stopping.signal });
	const patient = syncing.call("files.write", { path: "/workspace/b", data: "" });
	await Promise.resolve();
	stopping.abort();
	const stopped = await cancelled;
	assert.equal(stopped.ok, false);
	assert.equal(stopped.error.code, "aborted");
	assert.match(stopped.error.message, /files\.write ran/);
	assert.match(stopped.error.message, /sync/);

	// Already aborted when the call returns: it answers at once, without waiting for any sync.
	const gone = new AbortController();
	gone.abort();
	const late = await syncing.call("files.write", { path: "/workspace/c", data: "" }, { signal: gone.signal });
	assert.equal(late.ok, false);
	assert.equal(late.error.code, "aborted");

	finish(ok({ exitCode: 0 }));
	assert.equal((await patient).ok, true, "a caller with no signal still waits for the sync, and gets its answer");
	assert.ok(calls.includes("mount.sync"));
});

test("archilReadBack: fuse.archil at /workspace with the asked source, under the epoch, exclusive once serve answers; anything else is in words", () => {
	const line = `${MOUNT.disk}:/${MOUNT.folder}[${MOUNT.region}] /workspace fuse.archil rw,nosuid,nodev 0 0`;
	const proc = "proc /proc proc rw,hidepid=invisible 0 0";
	const read = (mounts, { epoch = 3, served = true, recorded = recordedMount(archilLabels(MOUNT)) } = {}) => archilReadBack({ mounts: `${proc}\n${mounts}\n`, epoch, served, recorded });
	assert.deepEqual(read(line), computer.readBackOf(MOUNT, 3));
	assert.deepEqual(read(line, { served: false }), { ...computer.readBackOf(MOUNT, 3), exclusive: false });
	assert.deepEqual(read(`${MOUNT.disk}:/${MOUNT.folder} /workspace fuse.archil rw 0 0`), computer.readBackOf(MOUNT, 3), "no region in the source: the recorded one");
	assert.equal(read(""), undefined, "nothing at /workspace");
	assert.match(read("tmpfs /workspace tmpfs rw 0 0").other, /tmpfs/);
	assert.match(archilReadBack({ mounts: `${line}\n`, epoch: undefined, served: true }).other, /no epoch/);
	noToken(read(line), "the read-back");
});

test("archilLabels and recordedMount: the mount's kind and source as one label, never the token, read back as written", () => {
	const labels = archilLabels(MOUNT);
	assert.deepEqual(Object.keys(labels), [ARCHIL_MOUNT_LABEL]);
	noToken(labels, "the label");
	assert.deepEqual(recordedMount(labels), { kind: "archil", disk: MOUNT.disk, region: MOUNT.region, folder: MOUNT.folder });
	assert.equal(recordedMount({}), undefined);
	assert.equal(recordedMount({ [ARCHIL_MOUNT_LABEL]: "{not json" }), undefined);
});

test("archilRelease: a final sync through computerd, then checkin as root; nothing mounted is let go already; a failed sync is said, and checkin still runs", async () => {
	const root = fakeRoot();
	const client = fakeClient();
	assert.deepEqual(await archilRelease({ root, client, timeoutMs: 1000 }), ok(undefined));
	assert.deepEqual(client.methods(), ["mount.sync"]);
	assert.deepEqual(root.calls.map(({ argv }) => argv), [[ARCHIL_HELPER, "checkin"]]);

	const gone = fakeRoot({ checkin: { exitCode: 3, output: "agentrun-archil: nothing is mounted at /workspace" } });
	assert.deepEqual(await archilRelease({ root: gone, client: undefined, timeoutMs: 1000 }), ok(undefined), "no client, nothing held: let go");

	const failing = fakeRoot();
	const result = await archilRelease({ root: failing, client: fakeClient({ syncs: [ok({ exitCode: 1 })] }), timeoutMs: 1000 });
	assert.equal(result.ok, false);
	assert.match(result.error.message, /final sync/);
	assert.deepEqual(failing.verbs(), ["checkin"], "checkin ran anyway");
});

test("helperSha256 is the shipped helper's", () => {
	assert.equal(helperSha256(), HELPER_SHA);
});
