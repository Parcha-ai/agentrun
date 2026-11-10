// Orgo's Windows and macOS desktops (src/orgo-desktop.ts), daemon none, against the fake (test/fake-orgo-desktop.mjs):
// the provider's lifecycle over Orgo's REST API, the in-process client's screen, input, exec and files, what each os
// refuses in words, and that nothing runs in a computer Orgo does not read running. No key leaves the Authorization
// header, and nothing reaches the network.
import assert from "node:assert/strict";
import test from "node:test";
import { kindOf, serves } from "../dist/index.js";
import { readPng } from "../dist/conformance/png.js";
import { API, KEY, WORKSPACE } from "./fake-orgo.mjs";
import { fakeOrgoDesktop, MACOS_LABELS, WINDOWS_HOME, WINDOWS_LABELS } from "./fake-orgo-desktop.mjs";

const orgo = await import("../dist/orgo.js");
const desktop = await import("../dist/orgo-desktop.js");
const { create, orgoName } = orgo;

const HOUR = 3_600_000;
const RUN = "run-7f3a";
const LABELS = { "agentrun.run": RUN, "agentrun.epoch": "3", team: "a" };
const TIMEOUTS = { requestMs: 2_000, createMs: 2_000, execMs: 2_000, listMs: 2_000, goneMs: 500, pollMs: 5 };
const specOf = (os, extra = {}) => ({ image: os, lifetimeMs: 30 * 60_000, network: "open", labels: LABELS, ...extra });

function setup(os = "windows", { options = {}, ...fakeOptions } = {}) {
	const fake = fakeOrgoDesktop({ os, ...fakeOptions });
	const provider = create({ os, apiKey: KEY, workspaceId: WORKSPACE, apiUrl: API, fetch: fake.fetch, timeouts: TIMEOUTS, ...options });
	return { fake, provider };
}
const keyless = (value, what) => assert.ok(!JSON.stringify(value ?? null).includes(KEY), `${what} holds the key`);
const newest = (fake) => [...fake.api.computers.values()].at(-1);
const bashCalls = (fake, id) => fake.api.requests.filter(({ method, path }) => method === "POST" && path === `/computers/${id}/bash`);
const decode = (b64) => Buffer.from(b64, "base64").toString("utf8");

/** A computer as create leaves one, seeded into the fake: its record, its labels file. */
function seeded({ fake }, os = "windows", { labels = LABELS, status = "running", hex = "0123456789ab", file } = {}) {
	const deadline = new Date(Date.now() + 30 * 60_000).toISOString();
	const record = fake.api.add({ name: orgoName(labels, hex, new Date(deadline)), status, os, ends_at: new Date(Date.now() + HOUR).toISOString() });
	const text = file ?? JSON.stringify({ name: record.name, labels, deadline, maxDeadline: new Date(Date.now() + 720 * HOUR).toISOString(), image: os, cpus: 1, memoryMb: 4096 });
	fake.boxOf(record.id).files.set(os === "windows" ? WINDOWS_LABELS : MACOS_LABELS, Buffer.from(text));
	return { record, ref: { id: record.id, name: record.name } };
}

test("Orgo desktops: create({ os }) builds the Windows or the macOS provider, daemon none, network open, desktop kind; the registry lists each configuration", () => {
	const windows = setup("windows").provider;
	assert.ok(windows instanceof desktop.OrgoDesktopProvider);
	assert.equal(windows.id, "orgo");
	assert.deepEqual(windows.capabilities(), {
		kind: "desktop",
		lifetime: "janitor",
		network: ["open"],
		networkReadBack: false,
		isolation: "vm",
		os: "windows",
		daemon: "none",
		groups: ["exec", "files", "screen", "input.pointer", "input.keys"],
		maxLifetimeMs: 720 * HOUR,
		release: ["delete"],
	});
	const mac = setup("macos").provider;
	assert.equal(mac.capabilities().os, "macos");
	assert.deepEqual(mac.capabilities().groups, ["exec", "screen", "input.pointer", "input.keys"], "no files on macOS: the shell is there through exec");
	for (const provider of [windows, mac]) {
		assert.equal(serves(provider.capabilities(), "desktop"), true);
		assert.equal(kindOf(provider.capabilities()), "desktop");
	}
	assert.ok(create({ apiKey: KEY, workspaceId: WORKSPACE, fetch: fakeOrgoDesktop().fetch }) instanceof orgo.OrgoProvider, "no os is the Linux desktop with computerd");
	assert.throws(() => create({ os: "beos", apiKey: KEY, workspaceId: WORKSPACE }), /linux.*windows.*macos/);
	assert.throws(() => create({ os: "windows", workspaceId: WORKSPACE }), /apiKey/);
	assert.deepEqual(orgo.CAPABILITIES.slice(1), [
		{ kind: "desktop", groups: ["exec", "files", "screen", "input.pointer", "input.keys"] },
		{ kind: "desktop", groups: ["exec", "screen", "input.pointer", "input.keys"] },
	]);
	assert.equal(orgo.ORGO_WINDOWS_IMAGE, "windows");
	assert.equal(orgo.ORGO_MACOS_IMAGE, "macos");
});

test("Orgo desktops' check(): the os's own image, network open, Orgo's sizes for that os (macOS 10 GB, its host's cpus), no user, workdir, pids or mount; nothing called", () => {
	const { provider, fake } = setup("windows");
	assert.deepEqual(provider.check(specOf("windows")), []);
	assert.deepEqual(provider.check(specOf("windows", { cpus: 2, memoryMb: 8192 })), []);
	for (const [change, field, words] of [
		[{ image: "linux" }, "image", /windows/],
		[{ network: "none" }, "network", /open/],
		[{ memoryMb: 10240 }, "memoryMb", /4096, 8192/],
		[{ user: "0" }, "user", /Orgo's own user/],
		[{ workdir: "C:\\" }, "workdir", /folder/],
		[{ mount: { kind: "bind", path: "/" } }, "mount", /mount/],
		[{ labels: { "agentrun.computer.x": "1" } }, "labels", /namespace/],
	]) {
		const refusals = provider.check(specOf("windows", change));
		assert.ok(refusals.some((r) => r.field === field && words.test(r.message)), `${JSON.stringify(change)}: ${JSON.stringify(refusals)}`);
	}
	const mac = setup("macos").provider;
	assert.deepEqual(mac.check(specOf("macos")), []);
	assert.deepEqual(mac.check(specOf("macos", { memoryMb: 10240 })), []);
	assert.ok(mac.check(specOf("macos", { memoryMb: 4096 })).some(({ field }) => field === "memoryMb"));
	assert.ok(mac.check(specOf("macos", { cpus: 2 })).some(({ field, message }) => field === "cpus" && /host/.test(message)));
	assert.deepEqual(fake.api.requests, []);
});

test("Orgo Windows create: os windows with Orgo's end as the backstop, waits while the computer is not ready, writes the labels file, reads the screen; no key in a word", async () => {
	const { provider, fake } = setup("windows", { notReady: 2 });
	const created = await provider.create(specOf("windows"));
	assert.equal(created.ok, true, JSON.stringify(created));
	keyless(created, "create");
	const record = newest(fake);
	assert.deepEqual(record.asked, { workspace_id: WORKSPACE, name: created.value.name, os: "windows", ram: 4, cpu: 1, ends_in_hours: 1 });
	assert.match(created.value.name, /^computer-[0-9a-f]{12}-r[a-z2-7]{16}-e3-d[0-9a-z]+$/);
	const box = fake.boxOf(record.id);
	assert.equal(box.commands.length, 3, "two refused while it booted, then the labels file");
	const file = JSON.parse(box.files.get(WINDOWS_LABELS).toString("utf8"));
	assert.deepEqual(file.labels, LABELS);
	assert.equal(file.image, "windows");
	assert.ok(box.screens >= 1, "the screen was read before create answered");
	for (const { headers, body, path } of fake.api.requests) {
		assert.equal(headers.authorization, `Bearer ${KEY}`);
		keyless({ body, path }, "a request");
	}
});

test("Orgo macOS create: os macos, ram 10, no cpu and no end (Orgo has none for a Mac): the janitor alone ends it", async () => {
	const { provider, fake } = setup("macos");
	const created = await provider.create(specOf("macos"));
	assert.equal(created.ok, true, JSON.stringify(created));
	assert.deepEqual(newest(fake).asked, { workspace_id: WORKSPACE, name: created.value.name, os: "macos", ram: 10 });
	assert.deepEqual(JSON.parse(fake.boxOf(newest(fake).id).files.get(MACOS_LABELS).toString("utf8")).labels, LABELS);
});

test("Orgo desktops' create refused or failed: a 403 makes nothing; a labels file that cannot be written deletes the computer, in words", async () => {
	const refused = setup("windows", { api: { create: "fail" } });
	const made = await refused.provider.create(specOf("windows"));
	assert.equal(made.ok, false);
	assert.equal(refused.fake.api.computers.size, 0);
	const broken = setup("windows", { notReady: 1000 });
	const failed = await broken.provider.create(specOf("windows"));
	assert.equal(failed.ok, false);
	assert.match(failed.error.message, /did not take a command within 2 s/);
	assert.match(failed.error.message, /was deleted/);
	assert.equal(newest(broken.fake).deleted, true);
});

test("Orgo Windows connect: hello is the desktop's; screen.shot is a PNG of the screen, a region crops it, and screen.read gives the rest", async () => {
	const { provider, fake } = setup("windows");
	const { ref } = seeded({ fake });
	const connected = await provider.connect(ref);
	assert.equal(connected.ok, true, JSON.stringify(connected));
	const { client, hello } = connected.value;
	assert.deepEqual(hello, { version: provider.version, os: "windows", kind: "desktop", arch: "amd64", groups: ["exec", "files", "screen", "input.pointer", "input.keys"] });
	const shot = (await client.call("screen.shot", {})).value;
	assert.deepEqual([shot.width, shot.height, shot.scale], [1280, 720, 1]);
	const read = async (first) => {
		const parts = [Buffer.from(first.data, "base64")];
		for (let eof = first.eof, offset = parts[0].length; !eof; ) {
			const more = (await client.call("screen.read", { id: first.id, offset })).value;
			parts.push(Buffer.from(more.data, "base64"));
			offset += Buffer.from(more.data, "base64").length;
			eof = more.eof;
		}
		return readPng(Buffer.concat(parts));
	};
	const whole = await read(shot);
	assert.deepEqual([whole.width, whole.height], [1280, 720]);
	assert.deepEqual(whole.rgb(640, 360), [30, 60, 90]);
	const region = (await client.call("screen.shot", { region: [100, 50, 64, 32] })).value;
	assert.deepEqual([region.width, region.height], [64, 32]);
	const part = await read(region);
	assert.deepEqual([part.width, part.height], [64, 32]);
	assert.equal((await client.call("screen.shot", { region: [1270, 0, 64, 32] })).error.code, "invalid");
	assert.equal((await client.call("screen.read", { id: "nope", offset: 0 })).error.code, "not_found");
	await connected.value.close();
	assert.equal((await client.call("ping", {})).error.code, "gone");
});

test("Orgo Windows input: each action as Orgo's Windows calls take it; a down and its up become one click or drag; what Windows cannot do is refused whole, with nothing run", async () => {
	const { provider, fake } = setup("windows");
	const { ref } = seeded({ fake });
	const { client } = (await provider.connect(ref)).value;
	const box = fake.boxOf(ref.id);
	const act = async (actions) => (await client.call("input.actions", { actions })).value;
	assert.deepEqual(
		await act([
			{ type: "move", at: [10, 20] },
			{ type: "click", at: [30, 40], button: "right" },
			{ type: "click", count: 2 },
			{ type: "drag", path: [[1, 2], [300, 400]], button: "middle" },
			{ type: "scroll", at: [5, 6], dy: 120, unit: "clicks" },
			{ type: "key", keys: ["ctrl", "shift", "t"] },
			{ type: "key", keys: ["pageup"], repeat: 2 },
			{ type: "key", keys: ["enter"] },
			{ type: "type", text: "héllo" },
			{ type: "wait", ms: 1 },
		]),
		{ done: 10 },
	);
	assert.deepEqual(box.inputs, [
		{ path: "mouse-move", body: { x: 10, y: 20 } },
		{ path: "click", body: { x: 30, y: 40, button: "right" } },
		{ path: "click", body: { x: 30, y: 40, button: "left", double: true } },
		{ path: "drag", body: { start_x: 1, start_y: 2, end_x: 300, end_y: 400, button: "middle" } },
		{ path: "mouse-move", body: { x: 5, y: 6 } },
		{ path: "scroll", body: { direction: "down", amount: 50 } },
		{ path: "scroll", body: { direction: "down", amount: 50 } },
		{ path: "scroll", body: { direction: "down", amount: 20 } },
		{ path: "key", body: { key: "ctrl+shift+t" } },
		{ path: "key", body: { key: "pageup" } },
		{ path: "key", body: { key: "pageup" } },
		{ path: "key", body: { key: "Return" } },
		{ path: "type", body: { text: "héllo" } },
	]);
	box.inputs.length = 0;
	// A press held across batches, released where the pointer went: one drag from the down to the up.
	assert.deepEqual(await act([{ type: "move", at: [50, 50] }, { type: "down" }]), { done: 2 });
	assert.deepEqual(await act([{ type: "move", at: [90, 70] }, { type: "up" }]), { done: 2 });
	assert.deepEqual(box.inputs, [
		{ path: "mouse-move", body: { x: 50, y: 50 } },
		{ path: "drag", body: { start_x: 50, start_y: 50, end_x: 90, end_y: 70, button: "left" } },
	]);
	box.inputs.length = 0;
	for (const [action, words] of [
		[{ type: "click", at: [1, 1], count: 3 }, /triple/],
		[{ type: "click", at: [1, 1], keys: ["shift"] }, /no keys held/],
		[{ type: "drag", path: [[1, 1], [2, 2], [3, 3]] }, /2 points/],
		[{ type: "scroll", dx: 1, unit: "clicks" }, /sideways/],
		[{ type: "scroll", dy: 1, unit: "px" }, /pixels/],
		[{ type: "hold", keys: ["shift"], ms: 10 }, /hold/],
		[{ type: "key", keys: ["+"] }, /\+/],
		[{ type: "tap", at: [1, 1] }, /input\.touch/],
	]) {
		const refused = await act([{ type: "move", at: [1, 1] }, action]);
		assert.equal(refused.done, 0, JSON.stringify(action));
		assert.equal(refused.failed.index, 1);
		assert.match(refused.failed.message, words);
	}
	assert.deepEqual(box.inputs, [], "a refused batch runs nothing");
	// A point off the screen stops the batch there, and a press held down is released where the pointer is.
	const stopped = await act([{ type: "move", at: [20, 20] }, { type: "down" }, { type: "move", at: [100_000, 5] }, { type: "click", at: [9, 9] }]);
	assert.deepEqual([stopped.done, stopped.failed.index, stopped.failed.kind], [2, 2, "invalid"]);
	assert.deepEqual(box.inputs, [
		{ path: "mouse-move", body: { x: 20, y: 20 } },
		{ path: "click", body: { x: 20, y: 20, button: "left" } },
	]);
	// A typed text past Windows' 20,000 bytes a call goes in several.
	box.inputs.length = 0;
	assert.deepEqual(await act([{ type: "type", text: "ab".repeat(15_000) }]), { done: 1 });
	assert.deepEqual(box.inputs.map(({ body }) => body.text.length), [20_000, 10_000]);
	// Orgo's own refusal mid-batch: done is the actions before it.
	const failing = setup("windows", { inputFails: (path) => (path === "key" ? 400 : undefined) });
	const one = seeded(failing);
	const failingClient = (await failing.provider.connect(one.ref)).value.client;
	const answered = (await failingClient.call("input.actions", { actions: [{ type: "move", at: [1, 1] }, { type: "key", keys: ["a"] }] })).value;
	assert.deepEqual([answered.done, answered.failed.index, answered.failed.kind], [1, 1, "invalid"]);
	assert.match(answered.failed.message, /400/);
});

test("Orgo macOS input: Linux's calls, with modifiers and a triple click; X key names (Page_Up); a scroll at the pointer's place", async () => {
	const { provider, fake } = setup("macos");
	const { ref } = seeded({ fake }, "macos");
	const { client, hello } = (await provider.connect(ref)).value;
	assert.equal(hello.arch, "arm64");
	const box = fake.boxOf(ref.id);
	const result = (
		await client.call("input.actions", {
			actions: [
				{ type: "click", at: [3, 4], keys: ["super"] },
				{ type: "click", count: 3 },
				{ type: "scroll", dy: -2, unit: "clicks" },
				{ type: "key", keys: ["pagedown"] },
			],
		})
	).value;
	assert.deepEqual(result, { done: 4 });
	assert.deepEqual(box.inputs, [
		{ path: "click", body: { x: 3, y: 4, button: "left", modifiers: ["super"] } },
		{ path: "click", body: { x: 3, y: 4, button: "left", repeat: 3 } },
		{ path: "scroll", body: { x: 3, y: 4, direction: "up", amount: 2 } },
		{ path: "key", body: { key: "Page_Down" } },
	]);
	const refused = (await client.call("input.actions", { actions: [{ type: "drag", path: [[1, 1], [2, 2]], button: "right" }] })).value;
	assert.equal(refused.failed.kind, "unsupported");
});

test("Orgo desktops' exec.run: argv quoted word by word for PowerShell or the shell, never a shell string; streams, exit code, timeout, maxOutput; no user switch, no timeout past 300 s", async () => {
	const { provider, fake } = setup("windows");
	const { ref } = seeded({ fake });
	const { client } = (await provider.connect(ref)).value;
	const run = async (params) => client.call("exec.run", { timeoutMs: 10_000, ...params });
	const echoed = (await run({ argv: ["echo", "it's", "$(id)", "a;b"], cwd: "C:\\Users\\agent", env: { GREETING: "hi 'there'" } })).value;
	assert.equal(decode(echoed.stdout), "it's $(id) a;b\n");
	assert.deepEqual([echoed.exitCode, echoed.timedOut, echoed.truncated], [0, false, false]);
	const command = bashCalls(fake, ref.id).at(-1).body.command;
	assert.match(command, /^& 'echo' 'it''s' '\$\(id\)' 'a;b'$/m, "every word single-quoted, a quote doubled");
	assert.match(command, /^Set-Location -LiteralPath 'C:\\Users\\agent'$/m);
	assert.match(command, /^Set-Item -LiteralPath 'Env:GREETING' -Value 'hi ''there'''$/m);
	assert.equal(bashCalls(fake, ref.id).at(-1).body.timeout, 10);
	assert.deepEqual(decode((await run({ argv: ["warn", "oops"] })).value.stderr), "oops\n");
	assert.equal((await run({ argv: ["exit", "7"] })).value.exitCode, 7);
	const slow = (await run({ argv: ["sleep", "500"] })).value;
	assert.deepEqual([slow.exitCode, slow.timedOut, decode(slow.stdout)], [null, true, "partial"]);
	const cut = (await run({ argv: ["echo", "x".repeat(50)], maxOutput: 10 })).value;
	assert.deepEqual([decode(cut.stdout), cut.truncated], ["xxxxxxxxxx", true]);
	assert.equal((await run({ argv: ["echo"], user: "0" })).error.code, "denied");
	assert.equal((await run({ argv: ["echo"], timeoutMs: 301_000 })).error.code, "limit");
	assert.equal((await run({ argv: [] })).error.code, "invalid");
	assert.equal((await run({ argv: ["echo"], env: { "BAD NAME": "x" } })).error.code, "invalid");

	const mac = setup("macos");
	const one = seeded(mac, "macos");
	const macClient = (await mac.provider.connect(one.ref)).value.client;
	const said = (await macClient.call("exec.run", { argv: ["echo", "it's here"], cwd: "/tmp", env: { A: "b c" }, timeoutMs: 5_000 })).value;
	assert.equal(decode(said.stdout), "it's here\n");
	assert.equal(bashCalls(mac.fake, one.ref.id).at(-1).body.command, "cd '/tmp' && env 'A=b c' 'echo' 'it'\\''s here'");
	assert.deepEqual((await macClient.call("exec.run", { argv: ["sleep", "9"], timeoutMs: 5_000 })).value.timedOut, true);
	assert.equal((await macClient.call("files.read", { path: "/etc/hosts" })).error.code, "unsupported");
	assert.equal((await macClient.call("process.start", { argv: ["x"] })).error.code, "unsupported");
});

test("Orgo Windows files: write and read back (inline, and through the upload past 96 KiB), stat, list, mkdir, move and remove, each refusal its kind; a relative path is invalid", async () => {
	const { provider, fake } = setup("windows");
	const { ref } = seeded({ fake });
	const { client } = (await provider.connect(ref)).value;
	const call = (method, params) => client.call(method, params);
	const dir = `${WINDOWS_HOME}\\work`;
	assert.equal((await call("files.write", { path: `${dir}\\a.txt`, data: Buffer.from("hi").toString("base64") })).error.code, "not_found");
	assert.deepEqual((await call("files.write", { path: `${dir}\\a.txt`, data: Buffer.from("hello").toString("base64"), parents: true })).value, { size: 5 });
	assert.deepEqual((await call("files.write", { path: `${dir}\\a.txt`, data: Buffer.from("!").toString("base64"), append: true })).value, { size: 6 });
	const read = (await call("files.read", { path: `${dir}\\a.txt` })).value;
	assert.deepEqual([decode(read.data), read.eof, read.size], ["hello!", true, 6]);
	const tail = (await call("files.read", { path: `${dir}\\a.txt`, offset: 2, length: 2 })).value;
	assert.deepEqual([decode(tail.data), tail.eof], ["ll", false]);
	const big = Buffer.alloc(200 * 1024, 7);
	assert.deepEqual((await call("files.write", { path: `${dir}\\big.bin`, data: big.toString("base64") })).value, { size: big.length });
	assert.ok(fake.api.requests.some(({ path, form }) => path === "/files/upload" && form?.get("destPath") === "C:\\ProgramData\\agentrun\\staging"), "a large write goes through the upload");
	assert.deepEqual(fake.boxOf(ref.id).files.get(`${dir}\\big.bin`), big);
	assert.ok(![...fake.boxOf(ref.id).files.keys()].some((path) => path.startsWith("C:\\ProgramData\\agentrun\\staging\\")), "the staged copy is gone");
	assert.equal((await call("files.stat", { path: `${dir}\\a.txt` })).value.type, "file");
	assert.equal((await call("files.stat", { path: dir })).value.type, "dir");
	assert.equal((await call("files.stat", { path: `${dir}\\none` })).error.code, "not_found");
	assert.deepEqual((await call("files.mkdir", { path: `${dir}\\sub` })).value, {});
	assert.equal((await call("files.mkdir", { path: `${dir}\\sub` })).error.code, "exists");
	const listed = (await call("files.list", { path: dir })).value;
	assert.deepEqual(listed.entries.map(({ path, type }) => [path, type]), [[`${dir}\\a.txt`, "file"], [`${dir}\\big.bin`, "file"], [`${dir}\\sub`, "dir"]]);
	assert.equal(listed.truncated, false);
	assert.deepEqual((await call("files.list", { path: `${dir}\\sub` })).value.entries, [], "an empty folder: PowerShell's null is no entry");
	await call("files.write", { path: `${dir}\\sub\\only.txt`, data: "" });
	assert.equal((await call("files.list", { path: `${dir}\\sub` })).value.entries.length, 1, "PowerShell's one object is a list of one");
	assert.equal((await call("files.move", { from: `${dir}\\a.txt`, to: `${dir}\\big.bin` })).error.code, "exists");
	assert.deepEqual((await call("files.move", { from: `${dir}\\a.txt`, to: `${dir}\\b.txt` })).value, {});
	assert.equal((await call("files.remove", { path: `${dir}\\sub` })).error.code, "invalid");
	assert.deepEqual((await call("files.remove", { path: `${dir}\\sub`, recursive: true })).value, {});
	assert.equal((await call("files.read", { path: `${dir}\\sub\\only.txt` })).error.code, "not_found");
	assert.equal((await call("files.read", { path: dir })).error.code, "is_dir");
	assert.equal((await call("files.read", { path: "relative\\x" })).error.code, "invalid");
	assert.equal((await call("tar.pull.begin", { path: dir })).error.code, "unsupported");
	assert.equal((await call("process.list", {})).error.code, "unsupported");
});

test("Orgo desktops' list, attach and release: the name filters with nothing run; other labels from the labels file of a running computer alone; attach reads the user and refuses drift", async () => {
	const { provider, fake } = setup("windows");
	const mine = seeded({ fake });
	const asleep = seeded({ fake }, "windows", { status: "suspended", hex: "00000000000a" });
	const linux = fake.api.add({ name: orgoName(LABELS, "00000000000b", new Date(Date.now() + HOUR)), os: "linux" });
	const byRun = (await provider.list({ "agentrun.run": RUN })).value;
	assert.deepEqual(byRun.map(({ ref }) => ref.id).sort(), [mine.ref.id, asleep.ref.id, linux.id].sort(), "the workspace's listing says no os: a name of this provider's shape is listed");
	assert.deepEqual(bashCalls(fake, asleep.ref.id), [], "nothing runs in the suspended one");
	const byTeam = (await provider.list({ team: "a" })).value;
	assert.deepEqual(byTeam.map(({ ref }) => ref.id), [mine.ref.id, linux.id].filter((id) => fake.boxOf(id).files.size > 0));
	assert.equal(byTeam[0].network, "open");
	assert.deepEqual(bashCalls(fake, asleep.ref.id), [], "a label only the file proves is not proven by waking it");

	const attached = await provider.attach({ id: mine.ref.id });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual(attached.value.spec, { image: "windows", user: "1001:1001", network: "open", cpus: 1, memoryMb: 4096, deadline: attached.value.spec.deadline, kind: "desktop" });
	assert.equal((await provider.attach({ id: asleep.ref.id })).error.code, "refused");
	assert.equal((await provider.attach({ id: linux.id })).error.code, "not_found", "Orgo's record says linux: not this provider's");
	const admin = setup("windows", { user: "0:0" });
	const root = seeded(admin);
	assert.equal((await admin.provider.attach({ id: root.ref.id })).value.spec.user, "0:0", "an Administrator is root, said as it is");
	const drifted = setup("windows");
	const other = seeded(drifted, "windows", { file: JSON.stringify({ name: "x", labels: { "agentrun.run": RUN, "agentrun.epoch": "4" }, deadline: new Date().toISOString(), maxDeadline: new Date(Date.now() + HOUR).toISOString(), image: "windows" }) });
	assert.match((await drifted.provider.attach({ id: other.ref.id })).error.message, /epoch/);

	assert.deepEqual(await provider.network(mine.ref), { ok: true, value: "open" });
	assert.equal((await provider.network(mine.ref, "none")).error.code, "refused");
	assert.deepEqual(await provider.release(mine.ref, "delete"), { ok: true, value: undefined });
	assert.equal(fake.api.computers.get(mine.ref.id).deleted, true);
	assert.equal((await provider.release(asleep.ref, "stop")).error.code, "unsupported");
	assert.deepEqual(await provider.release(asleep.ref, "delete"), { ok: true, value: undefined });
	assert.deepEqual(bashCalls(fake, asleep.ref.id), [], "release runs nothing inside either");
});

test("Orgo desktops never run anything in a computer Orgo does not read running: list, attach, connect and extend", async () => {
	for (const status of ["suspended", "suspending", "resuming", "frozen", "stopped", "creating"]) {
		const { provider, fake } = setup("windows");
		const { ref } = seeded({ fake }, "windows", { status });
		for (const filter of [{}, { "agentrun.run": RUN }, { team: "a" }]) assert.equal((await provider.list(filter)).ok, true);
		assert.equal((await provider.attach({ id: ref.id })).error.code, "refused", status);
		assert.equal((await provider.connect(ref)).error.code, "refused", status);
		assert.equal((await provider.extend(ref, HOUR)).error.code, "refused", status);
		assert.deepEqual(bashCalls(fake, ref.id), [], status);
		assert.ok(!fake.api.requests.some(({ path }) => path.includes("/screenshot")), status);
	}
});

test("Orgo desktops' release of a Mac Orgo will not delete: refused in Orgo's words, and the Mac left", async () => {
	const { provider, fake } = setup("macos", { api: { deleteRefused: () => ({ status: 409, error: "This Mac is managed by Orgo. Ask support to release it.", code: "pool_mac_release_required" }) } });
	const { ref } = seeded({ fake }, "macos");
	const released = await provider.release(ref, "delete");
	assert.equal(released.ok, false);
	assert.match(released.error.message, /managed by Orgo/);
	assert.equal(fake.api.computers.get(ref.id).deleted, false);
});

test("Orgo Windows extend: Orgo's end moved in whole hours, then the name's deadline, then the labels file; never earlier", async () => {
	const { provider, fake } = setup("windows");
	const { ref } = seeded({ fake });
	const extended = await provider.extend(ref, 2 * HOUR);
	assert.equal(extended.ok, true, JSON.stringify(extended));
	const moved = fake.api.requests.find(({ path }) => path === `/computers/${ref.id}/extend`);
	assert.ok(moved !== undefined && Number.isSafeInteger(moved.body.hours) && moved.body.hours >= 1 && moved.headers["idempotency-key"], JSON.stringify(moved));
	const record = fake.api.computers.get(ref.id);
	assert.notEqual(record.name, ref.name, "the name carries the new deadline");
	const file = JSON.parse(fake.boxOf(ref.id).files.get(WINDOWS_LABELS).toString("utf8"));
	assert.equal(file.deadline, extended.value.deadline.toISOString());
	assert.equal((await provider.extend({ id: ref.id, name: record.name }, 60_000)).error.code, "refused");
});

test("Orgo desktops' live view: screen.watch frames are Orgo's PNGs, scaled by Orgo past maxWidth, in the screen's input space; a pointer move is a new frame with the cursor there", async () => {
	const { provider, fake } = setup("windows");
	const { ref } = seeded({ fake });
	const { client } = (await provider.connect(ref)).value;
	const first = (await client.call("screen.watch", { after: 0, waitMs: 0, maxWidth: 640 })).value;
	assert.deepEqual([first.seq, first.changed, first.format, first.frameWidth, first.frameHeight, first.width, first.height], [1, true, "png", 640, 360, 1280, 720]);
	assert.ok(fake.api.requests.some(({ path, query }) => path.endsWith("/screenshot") && query.scale === "0.5000"));
	const same = (await client.call("screen.watch", { after: 1, waitMs: 0, maxWidth: 640 })).value;
	assert.deepEqual([same.seq, same.changed], [1, false]);
	await client.call("input.actions", { actions: [{ type: "move", at: [400, 300] }] });
	const moved = (await client.call("screen.watch", { after: 1, waitMs: 2_000, maxWidth: 640 })).value;
	assert.deepEqual([moved.seq, moved.changed, moved.cursor], [2, true, [400, 300]]);
});

test("the Orgo conformance module: COMPUTER_ORGO_OS picks the desktop and its image; a Windows desktop's drifted twin is one whose hello reports another version, which connect refuses", async () => {
	const module = await import("../dist/conformance/orgo.js");
	assert.equal(module.ENV.os, "COMPUTER_ORGO_OS");
	const env = (os) => ({ AGENTRUN_COMPUTER_LIVE_ORGO: "1", COMPUTER_ORGO_API_KEY: KEY, COMPUTER_ORGO_WORKSPACE: WORKSPACE, ...(os ? { COMPUTER_ORGO_OS: os } : {}) });
	const windows = await module.createProvider({ env: env("windows"), fetch: fakeOrgoDesktop().fetch });
	assert.equal(windows.capabilities().os, "windows");
	assert.equal(module.conformanceImage({ env: env("windows") }), "windows");
	assert.equal(module.conformanceImage({ env: env("macos") }), "macos");
	assert.equal(module.conformanceImage({ env: env() }), "linux");
	assert.equal((await module.createProvider({ env: env("macos"), fetch: fakeOrgoDesktop().fetch })).capabilities().os, "macos");
	const fake = fakeOrgoDesktop();
	const drifted = await module.createDriftedProvider({ env: env("windows"), fetch: fake.fetch });
	const { ref } = seeded({ fake });
	const refused = await drifted.connect(ref);
	assert.equal(refused.ok, false);
	assert.match(refused.error.message, /^hello: the daemon reports version \S+-drift, expected \S+$/);
	await assert.rejects(module.createProvider({ env: env("haiku") }), /linux, windows or macos/);
});

test("the conformance suite's desktop kind on the Windows fake: it passes, the Windows fixture run through exec and files, the cases written for Linux skipped in words", async () => {
	const { kindCases, runConformance } = await import("../dist/conformance/index.js");
	const { provider, fake } = setup("windows");
	const drifted = async () => create({ os: "windows", apiKey: KEY, workspaceId: WORKSPACE, apiUrl: API, fetch: fake.fetch, timeouts: TIMEOUTS, daemonVersion: "0.0.0-drift" });
	// lifetime.extend waits a minute out on the real clock (the extend test above covers it): every other case runs.
	const cases = kindCases("desktop").filter(({ id }) => id !== "lifetime.extend");
	const report = await runConformance(provider, { image: "windows", kind: "desktop", cases, drifted, patience: 5_000, caseTimeoutMs: 60_000 });
	assert.equal(report.results.find((result) => result.id === "drift.version")?.status, "pass", "a computer whose hello reports another version is refused");
	const failed = report.results.filter(({ status }) => status === "fail");
	assert.deepEqual(failed, [], JSON.stringify(failed, null, 1));
	assert.equal(report.kindVerdict.verdict, "pass", report.kindVerdict.reasons.join("; "));
	for (const id of ["input.click-lands", "input.type-text", "input.actions-stops-at-first-failure", "screen.screenshot-size", "screen.watch"]) {
		assert.equal(report.results.find((result) => result.id === id)?.status, "pass", id);
	}
	const linuxOnly = report.results.find((result) => result.id === "exec.argv");
	assert.deepEqual([linuxOnly?.status, linuxOnly?.reason], ["skip", "the case is written for linux, and this computer runs windows"]);
	assert.deepEqual(report.cleanup.left, []);
});
