import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import { finish } from "../src/box/files.ts";
import { LaunchError, launch, launchState, launchStop } from "../src/launch/index.ts";
import { daytonaLike, fakeBoxes, fakeClock, modalLike } from "../src/testing/index.ts";

const context = BACKGROUND_CONTEXT;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const SPEC = { maxLifetimeMs: 60_000 };

describe("fakeBoxes: the provider contract", () => {
	it("makes boxes with stable ids and labels, finds them by id and label, and refuses what a provider refuses", async () => {
		const provider = fakeBoxes({ name: "fake-x", facts: { isolation: "vm", gpu: "T4" } });
		const box = getOrThrow(await provider.create({ ...SPEC, labels: { "agentrun-run": "r1" } }, context));
		expect(box.id).toBe("fake-1");
		expect(box.facts()).toMatchObject({
			provider: "fake-x",
			isolation: "vm",
			gpu: "T4",
			maxLifetimeMs: 60_000,
			workspace: "/workspace",
		});
		const same = getOrThrow(await provider.attach("fake-1", context));
		expect(same).toBe(box);
		expect(getOrThrow(await provider.attach("nope", context))).toBeUndefined();
		expect(getOrThrow(await provider.list({ "agentrun-run": "r1" }, context)).map((b) => b.id)).toEqual(["fake-1"]);
		expect(getOrThrow(await provider.list({ "agentrun-run": "r2" }, context))).toEqual([]);
		const bad = await provider.create({ ...SPEC, labels: { "pi-transport.owner": "x" } }, context);
		expect(bad.ok ? "ok" : bad.error.code).toBe("invalid");
		const noLife = await provider.create({ maxLifetimeMs: 0 }, context);
		expect(noLife.ok ? "ok" : noLife.error.code).toBe("invalid");
		const wrongIsolation = await provider.create({ ...SPEC, isolation: "none" }, context);
		expect(wrongIsolation.ok ? "ok" : wrongIsolation.error.code).toBe("unsupported");
	});

	it("enforces capacity, ends a box on destroy (idempotent) and stops finding it", async () => {
		const provider = fakeBoxes({ capacity: 1 });
		const box = getOrThrow(await provider.create(SPEC, context));
		const over = await provider.create(SPEC, context);
		expect(over.ok ? "ok" : over.error.code).toBe("capacity");
		getOrThrow(await box.destroy(context));
		getOrThrow(await box.destroy(context));
		expect(getOrThrow(await box.status(context))).toEqual({ state: "ended", exitCode: null });
		expect(getOrThrow(await provider.attach(box.id, context))).toBeUndefined();
		getOrThrow(await provider.create(SPEC, context));
	});

	it("moves files through upload and download with modes, and a missing file is not_found", async () => {
		const provider = fakeBoxes();
		const box = getOrThrow(await provider.create({ ...SPEC, workspace: "/w" }, context));
		getOrThrow(await box.upload([{ path: "a/b.txt", bytes: new TextEncoder().encode("hi"), mode: 0o600 }], context));
		const got = getOrThrow(await box.download(["/w/a/b.txt"], context));
		expect(text(got[0]?.bytes ?? new Uint8Array())).toBe("hi");
		expect(got[0]?.mode).toBe(0o600);
		const missing = await box.download(["nope"], context);
		expect(missing.ok ? "ok" : missing.error.code).toBe("not_found");
	});
});

describe("fakeBoxes: programs", () => {
	it("runs a registered program with its argv, env and stdin, and reports its exit code as a value", async () => {
		const provider = fakeBoxes();
		provider.program("greet", async ({ argv, env, stdin, stdout }) => {
			stdout.write(`${argv[1]} ${env.HOST_BOX} ${text(await stdin.readAll())}`);
			return 3;
		});
		const box = getOrThrow(await provider.create({ ...SPEC, env: { HOST_BOX: "hb" } }, context));
		const started = getOrThrow(await box.exec(["greet", "x"], undefined, context));
		const done = getOrThrow(await finish(started, new TextEncoder().encode("in")));
		expect(done).toMatchObject({ exitCode: 3 });
		expect(text(done.stdout)).toBe("x hb in");
		expect(box.programs[0]).toMatchObject({ state: "exited", exitCode: 3, stdout: "x hb in" });
	});

	it("answers 127 for a command no program matches, and the built-ins work", async () => {
		const provider = fakeBoxes();
		const box = getOrThrow(await provider.create(SPEC, context));
		const none = getOrThrow(await finish(getOrThrow(await box.exec(["nothing"], undefined, context))));
		expect(none.exitCode).toBe(127);
		box.files.set("f", "data");
		const cat = getOrThrow(await finish(getOrThrow(await box.exec(["cat", "f"], undefined, context))));
		expect(text(cat.stdout)).toBe("data");
		const echo = getOrThrow(await finish(getOrThrow(await box.exec(["echo", "a", "b"], undefined, context))));
		expect(text(echo.stdout)).toBe("a b\n");
	});

	it("ends the box with its first program when asked, and status says so", async () => {
		const provider = fakeBoxes({ endsWithProgram: true });
		provider.program("main", () => 7);
		const box = getOrThrow(await provider.create(SPEC, context));
		getOrThrow(await finish(getOrThrow(await box.exec(["main"], undefined, context))));
		expect(getOrThrow(await box.status(context))).toEqual({ state: "ended", exitCode: 7 });
	});
});

describe("fakeBoxes: the recording", () => {
	it("logs every call in order, failed creates included, with argv, env names (never values), stdin and the rule that decided it", async () => {
		const provider = fakeBoxes({ capacity: 1 });
		provider.program("p", async ({ stdin }) => {
			await stdin.readAll();
			return 0;
		});
		const box = getOrThrow(await provider.create({ ...SPEC, env: { FAKE_SETTING: "secret-value" } }, context));
		await provider.create(SPEC, context);
		provider.script.on({ op: "exec", argv: (a) => a[0] === "p" }, { fail: "spawn" }, { label: "no-spawn" });
		await box.exec(["p", "1"], undefined, context);
		const ok = getOrThrow(await box.exec(["p", "2"], { timeoutMs: 5 }, context));
		await finish(ok, new TextEncoder().encode("abc"));
		expect(provider.calls.map((c) => c.op)).toEqual(["create", "create", "exec", "exec"]);
		expect(
			provider.callsOf("create").map((c) => (c.result === "ok" ? "ok" : (c.result as { error: string }).error)),
		).toEqual(["ok", "capacity"]);
		const [spawned, started] = provider.callsOf("exec");
		expect(spawned).toMatchObject({ argv: ["p", "1"], scripted: "no-spawn", result: { error: "spawn" } });
		expect(started).toMatchObject({
			argv: ["p", "2"],
			envKeys: ["FAKE_SETTING"],
			stdinClosed: true,
			result: "ok",
			options: { timeoutMs: 5 },
		});
		expect(text(started?.stdin ?? new Uint8Array())).toBe("abc");
		expect(JSON.stringify(provider.calls.map((c) => c.envKeys))).not.toContain("secret-value");
		expect(provider.calls.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
	});

	it("finds a planted marker in each channel, and in nothing else", async () => {
		const provider = fakeBoxes();
		provider.program("p", async ({ stdin }) => {
			await stdin.readAll();
			return 0;
		});
		const box = getOrThrow(
			await provider.create({ ...SPEC, env: { E: "m-env" }, labels: { l: "m-label" } }, context),
		);
		getOrThrow(await box.upload([{ path: "m-path/x", bytes: new TextEncoder().encode("m-upload") }], context));
		await finish(
			getOrThrow(await box.exec(["p", "m-argv"], undefined, context)),
			new TextEncoder().encode("m-stdin"),
		);
		const where = (marker: string) => provider.leaks(marker).map((l) => l.where);
		expect(where("m-argv")).toEqual(["argv"]);
		expect(where("m-stdin")).toEqual(["stdin"]);
		expect(where("m-upload")).toEqual(["upload"]);
		expect(where("m-path")).toEqual(["path"]);
		expect(where("m-env")).toEqual(["env"]);
		expect(where("m-label")).toEqual(["label"]);
		expect(provider.leaks("never-sent")).toEqual([]);
	});
});

describe("fakeBoxes: scripted outcomes", () => {
	it("fails a create with a typed error and leaves no box, and a rule is one-shot unless times says more", async () => {
		const provider = fakeBoxes();
		provider.script.on({ op: "create" }, { fail: "capacity" });
		const first = await provider.create(SPEC, context);
		expect(first.ok ? "ok" : first.error.code).toBe("capacity");
		expect(provider.boxes).toHaveLength(0);
		getOrThrow(await provider.create(SPEC, context));
		provider.script.on({ op: "create" }, { fail: "unknown" }, { times: 2 });
		expect((await provider.create(SPEC, context)).ok).toBe(false);
		expect((await provider.create(SPEC, context)).ok).toBe(false);
		expect((await provider.create(SPEC, context)).ok).toBe(true);
	});

	it("matches the nth call of an op on one box", async () => {
		const provider = fakeBoxes();
		const box = getOrThrow(await provider.create(SPEC, context));
		provider.script.on({ op: "exec", box: box.id, nth: 2 }, { fail: "gone" });
		expect((await box.exec(["true"], undefined, context)).ok).toBe(true);
		const second = await box.exec(["true"], undefined, context);
		expect(second.ok ? "ok" : second.error.code).toBe("gone");
		expect((await box.exec(["true"], undefined, context)).ok).toBe(true);
	});

	it("delays on the clock without waiting, and a hang ends only on abort or timeout", async () => {
		const clock = fakeClock();
		const provider = fakeBoxes({ clock });
		const pending = provider.create(SPEC, context);
		provider.script.on({ op: "status" }, { delayMs: 500 });
		const box = getOrThrow(await pending);
		let answered = false;
		const status = box.status(context).then((r) => {
			answered = true;
			return r;
		});
		await clock.advance(499);
		expect(answered).toBe(false);
		await clock.advance(1);
		expect(getOrThrow(await status)).toEqual({ state: "running" });
		provider.script.on({ op: "download" }, { hang: true });
		const controller = new AbortController();
		const hung = box.download(["x"], withAbortSignal(controller.signal, context));
		controller.abort();
		const result = await hung;
		expect(result.ok ? "ok" : result.error.code).toBe("aborted");
	});

	it("times a program out at timeoutMs on the clock", async () => {
		const clock = fakeClock();
		const provider = fakeBoxes({ clock });
		const box = getOrThrow(await provider.create(SPEC, context));
		const proc = getOrThrow(await box.exec(["sleep", "100"], { timeoutMs: 1_000 }, context));
		const waited = proc.wait();
		await clock.advance(1_000);
		const result = await waited;
		expect(result.ok ? "ok" : result.error.code).toBe("timeout");
	});

	it("ends a box at its lifetime on the clock, with pending programs answering gone", async () => {
		const clock = fakeClock();
		const provider = fakeBoxes({ clock });
		const box = getOrThrow(await provider.create({ maxLifetimeMs: 1_000 }, context));
		const proc = getOrThrow(await box.exec(["sleep", "100"], undefined, context));
		const waited = proc.wait();
		await clock.advance(1_000);
		const result = await waited;
		expect(result.ok ? "ok" : result.error.code).toBe("gone");
		const after = await box.exec(["true"], undefined, context);
		expect(after.ok ? "ok" : after.error.code).toBe("gone");
	});

	it("ends the box in the middle of an exec with { gone: {} }: the program started ok, then the box ends", async () => {
		const provider = fakeBoxes();
		provider.program(
			"long",
			({ signal }) => new Promise<number>((resolve) => signal.addEventListener("abort", () => resolve(143))),
		);
		const box = getOrThrow(await provider.create(SPEC, context));
		provider.script.on({ op: "exec" }, { gone: {} });
		const proc = getOrThrow(await box.exec(["long"], undefined, context));
		const result = await proc.wait();
		expect(result.ok ? "ok" : result.error.code).toBe("gone");
		expect(box.state).toBe("ended");
		expect(provider.callsOf("exec")[0]?.result).toEqual({ error: "gone", message: expect.any(String) });
	});

	it("loses the end of an empty stdin, so a program that reads it waits", async () => {
		const provider = fakeBoxes({ clock: fakeClock() });
		provider.program("reader", async ({ stdin }) => {
			await stdin.readAll();
			return 0;
		});
		const box = getOrThrow(await provider.create(SPEC, context));
		provider.script.on({ op: "exec" }, { lose: "stdin-eof" });
		const proc = getOrThrow(await box.exec(["reader"], { timeoutMs: 50 }, context));
		let ended = false;
		const done = finish(proc).then((r) => {
			ended = true;
			return r;
		});
		await provider.clock.advance(49);
		expect(ended).toBe(false);
		await provider.clock.advance(1);
		expect((await done).ok).toBe(false);
		// with a byte written first, the end is delivered
		provider.script.on({ op: "exec" }, { lose: "stdin-eof" });
		const fine = getOrThrow(await box.exec(["reader"], undefined, context));
		expect(getOrThrow(await finish(fine, new Uint8Array([1])))).toMatchObject({ exitCode: 0 });
	});

	it("drops or truncates an output stream, and a scripted exit ends the program at once", async () => {
		const provider = fakeBoxes();
		provider.program("loud", ({ stdout, stderr }) => {
			stdout.write("0123456789");
			stderr.write("err");
			return 0;
		});
		const box = getOrThrow(await provider.create(SPEC, context));
		provider.script.on({ op: "exec" }, { truncate: { stream: "stdout", afterBytes: 4 } });
		const cut = getOrThrow(await finish(getOrThrow(await box.exec(["loud"], undefined, context))));
		expect(text(cut.stdout)).toBe("0123");
		provider.script.on({ op: "exec" }, { lose: "stderr" });
		const lost = getOrThrow(await finish(getOrThrow(await box.exec(["loud"], undefined, context))));
		expect(lost.stderr).toBe("");
		expect(text(lost.stdout)).toBe("0123456789");
		provider.script.on({ op: "exec" }, { exit: 9 });
		expect(getOrThrow(await finish(getOrThrow(await box.exec(["loud"], undefined, context)))).exitCode).toBe(9);
	});

	it("ends every live box on endAll", async () => {
		const provider = fakeBoxes();
		const a = getOrThrow(await provider.create(SPEC, context));
		const b = getOrThrow(await provider.create(SPEC, context));
		provider.endAll(1);
		expect(getOrThrow(await a.status(context))).toEqual({ state: "ended", exitCode: 1 });
		expect(getOrThrow(await b.status(context))).toEqual({ state: "ended", exitCode: 1 });
	});
});

describe("fakeBoxes: a create that fails after the box was made", () => {
	it("leaves the box findable by list and attach when the rule says leakBox", async () => {
		const provider = fakeBoxes();
		provider.script.on({ op: "create" }, { fail: "unknown", leakBox: true });
		const failed = await provider.create({ ...SPEC, labels: { run: "r1" } }, context);
		expect(failed.ok ? "ok" : failed.error.code).toBe("unknown");
		const found = getOrThrow(await provider.list({ run: "r1" }, context));
		expect(found.map((b) => b.id)).toEqual(["fake-1"]);
		expect(getOrThrow(await provider.attach("fake-1", context))).toBe(provider.boxes[0]);
		expect(provider.callsOf("create")[0]).toMatchObject({ box: "fake-1", result: { error: "unknown" } });
		// without leakBox a failed create leaves nothing
		provider.script.on({ op: "create" }, { fail: "capacity" });
		await provider.create({ ...SPEC, labels: { run: "r2" } }, context);
		expect(getOrThrow(await provider.list({ run: "r2" }, context))).toEqual([]);
	});
});

describe("fakeBoxes: presets", () => {
	it("modalLike is a VM with FUSE, live programs, files, a start time and a ptrace scope a launcher can raise", async () => {
		const provider = fakeBoxes(modalLike({ clock: fakeClock(Date.UTC(2026, 9, 22)) }));
		const box = getOrThrow(await provider.create(SPEC, context));
		expect(box.facts()).toMatchObject({
			provider: "modal-like",
			isolation: "vm",
			fuse: true,
			liveProcesses: true,
			bulk: "files",
			ptraceScope: 0,
			ptraceRaisable: true,
			startedAt: "2026-10-22T00:00:00.000Z",
		});
	});

	it("daytonaLike is a container with no FUSE and a ptrace scope that cannot be raised, and a spec asking for a VM is refused", async () => {
		const provider = fakeBoxes(daytonaLike());
		const box = getOrThrow(await provider.create(SPEC, context));
		expect(box.facts()).toMatchObject({
			provider: "daytona-like",
			isolation: "container",
			fuse: false,
			ptraceScope: 0,
			ptraceRaisable: false,
		});
		const vm = await provider.create({ ...SPEC, isolation: "vm" }, context);
		expect(vm.ok ? "ok" : vm.error.code).toBe("unsupported");
	});
});

describe("fakeBoxes: review findings (red first)", () => {
	const hung = (ms: number) => new Promise<string>((resolve) => setTimeout(() => resolve("hung"), ms));
	const codeOf = (r: string | { ok: boolean; error?: { code: string } }): string =>
		typeof r === "string" ? r : r.ok ? "ok" : (r.error?.code ?? "error");

	it("settles the wait of an exec with aborted when the caller's context aborts after exec returned", async () => {
		const provider = fakeBoxes();
		const box = getOrThrow(await provider.create(SPEC, context));
		const controller = new AbortController();
		const proc = getOrThrow(await box.exec(["sleep", "100"], undefined, withAbortSignal(controller.signal, context)));
		controller.abort();
		const result = await Promise.race([proc.wait(), hung(500)]);
		expect(codeOf(result)).toBe("aborted");
	});

	it("ends a scripted hang at the call's timeoutMs and when the box ends", async () => {
		const clock = fakeClock();
		const provider = fakeBoxes({ clock });
		const box = getOrThrow(await provider.create(SPEC, context));
		provider.script.on({ op: "exec" }, { hang: true });
		const timed = box.exec(["true"], { timeoutMs: 50 }, context);
		await clock.advance(50);
		const first = await Promise.race([timed, hung(500)]);
		expect(codeOf(first)).toBe("timeout");
		provider.script.on({ op: "exec" }, { hang: true });
		const ending = box.exec(["true"], undefined, context);
		await clock.advance(1);
		box.end(null);
		const second = await Promise.race([ending, hung(500)]);
		expect(codeOf(second)).toBe("gone");
	});

	it("counts each call once for nth, whatever rules are installed, and counts calls made before a rule", async () => {
		const provider = fakeBoxes();
		const box = getOrThrow(await provider.create(SPEC, context));
		provider.script.on({ op: "exec", box: box.id, nth: 2 }, { fail: "unknown" });
		provider.script.on({ op: "exec", box: box.id, nth: 3 }, { fail: "capacity" });
		const codes: string[] = [];
		for (let i = 0; i < 3; i++) {
			const r = await box.exec(["true"], undefined, context);
			codes.push(r.ok ? "ok" : r.error.code);
		}
		expect(codes).toEqual(["ok", "unknown", "capacity"]);
		const late = fakeBoxes();
		const b = getOrThrow(await late.create(SPEC, context));
		await b.exec(["true"], undefined, context);
		await b.exec(["true"], undefined, context);
		late.script.on({ op: "exec", nth: 3 }, { fail: "unknown" });
		const third = await b.exec(["true"], undefined, context);
		expect(third.ok ? "ok" : third.error.code).toBe("unknown");
	});

	it("keeps what a delayed outcome says: a delayed exit, and a delayed failing create that leaks its box", async () => {
		const clock = fakeClock();
		const provider = fakeBoxes({ clock });
		const box = getOrThrow(await provider.create(SPEC, context));
		provider.script.on({ op: "exec" }, { delayMs: 10, next: { exit: 9 } });
		const pending = box.exec(["echo", "x"], undefined, context);
		await clock.advance(10);
		const proc = getOrThrow(await pending);
		expect(getOrThrow(await finish(proc)).exitCode).toBe(9);
		provider.script.on({ op: "create" }, { delayMs: 10, next: { fail: "unknown", leakBox: true } });
		const creating = provider.create({ ...SPEC, labels: { run: "d" } }, context);
		await clock.advance(10);
		const failed = await creating;
		expect(failed.ok ? "ok" : failed.error.code).toBe("unknown");
		expect(getOrThrow(await provider.list({ run: "d" }, context))).toHaveLength(1);
	});

	it("records copies: a reused upload buffer and a mutated spec do not change what leaks finds", async () => {
		const provider = fakeBoxes();
		const env = { E: "m-env" };
		const box = getOrThrow(await provider.create({ ...SPEC, env }, context));
		env.E = "changed";
		const bytes = new TextEncoder().encode("m-upload");
		getOrThrow(await box.upload([{ path: "a", bytes }], context));
		bytes.fill(0);
		expect(provider.leaks("m-upload").map((l) => l.where)).toEqual(["upload"]);
		expect(provider.leaks("m-env").map((l) => l.where)).toEqual(["env"]);
	});

	it("lets the spec's cpus, memory and gpu win over the provider's defaults, and keeps the defaults where the spec is silent", async () => {
		const provider = fakeBoxes({ facts: { cpus: 8, memoryMb: 4096, gpu: "T4" } });
		const box = getOrThrow(await provider.create({ ...SPEC, cpus: 2, memoryMb: 512, gpu: "H100" }, context));
		expect(box.facts()).toMatchObject({ cpus: 2, memoryMb: 512, gpu: "H100" });
		const plain = getOrThrow(await provider.create(SPEC, context));
		expect(plain.facts()).toMatchObject({ cpus: 8, memoryMb: 4096, gpu: "T4" });
	});
});

describe("fakeBoxes: T3's own launcher over a fake box (Box.launcher)", () => {
	const enc = (t: string) => new TextEncoder().encode(t);
	const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
	const hung = (ms: number) => new Promise<string>((resolve) => setTimeout(() => resolve("hung"), ms));
	const forever = ({ signal }: { signal: AbortSignal }) =>
		new Promise<number>((resolve) => signal.addEventListener("abort", () => resolve(0)));
	const withSecrets = () => fakeBoxes({ facts: { secretsVia: "fd" } });

	it("takes box.launcher: no exec of a launcher program, the first incarnation running, and the stdin recorded on the launch call only", async () => {
		const provider = withSecrets();
		let seen = "";
		provider.program("inst", async (ctx) => {
			seen = `${text(await ctx.stdin.readAll())}#${ctx.env.PI_TRANSPORT_INCARNATION}`;
			return forever(ctx);
		});
		const box = getOrThrow(await provider.create(SPEC, context));
		const state = getOrThrow(await launch(box, "inst", { argv: ["inst"], stdin: enc("token-1") }, context));
		await tick();
		expect(state).toMatchObject({
			launch: { v: 1, name: "inst" },
			phase: "running",
			incarnation: 1,
			restarts: 0,
			starts: 1,
			launcherAlive: true,
		});
		expect(provider.callsOf("exec")).toEqual([]);
		expect(provider.calls.map((c) => c.op)).toEqual(["create", "launch", "incarnation"]);
		expect(seen).toBe("token-1#1");
		expect(provider.leaks("token-1").map((l) => `${l.op}:${l.where}`)).toEqual(["launch:stdin"]);
	});

	it("records a launch's secrets on the launch call only, and hands them to the program on its secrets channel", async () => {
		const provider = withSecrets();
		let got = "";
		provider.program("inst", async (ctx) => {
			got = `${ctx.secrets.API}|${ctx.env.PI_TRANSPORT_SECRETS_FD}`;
			return forever(ctx);
		});
		const box = getOrThrow(await provider.create(SPEC, context));
		getOrThrow(await launch(box, "inst", { argv: ["inst"], secrets: { API: "s3cret-value" } }, context));
		await tick();
		expect(got).toBe("s3cret-value|3");
		expect(provider.leaks("s3cret-value").map((l) => `${l.op}:${l.where}`)).toEqual(["launch:secret"]);
	});

	it("refuses a stdin or secrets on a box that takes none, as T3's own check does", async () => {
		const provider = fakeBoxes();
		const box = getOrThrow(await provider.create(SPEC, context));
		const refused = await launch(box, "inst", { argv: ["inst"], stdin: enc("x") }, context);
		expect(refused.ok ? "ok" : refused.error.code).toBe("unsupported");
		expect(provider.callsOf("launch")).toEqual([]);
	});

	it("restarts a failing program under its policy: restarts and incarnations count, the burst limit gives up, terminal exits stop", async () => {
		const provider = fakeBoxes();
		provider.program("inst", () => 1);
		provider.program("done", () => 78);
		const box = getOrThrow(await provider.create(SPEC, context));
		const limited = getOrThrow(
			await launch(box, "a", { argv: ["inst"], restartLimit: { burst: 2, intervalMs: 60_000 } }, context),
		);
		await tick();
		expect(getOrThrow(await launchState(box, limited.launch, context))).toMatchObject({
			phase: "gave_up",
			incarnation: 3,
			restarts: 2,
			lastExit: 1,
			launcherAlive: false,
		});
		const terminal = getOrThrow(await launch(box, "b", { argv: ["done"], terminalExits: [78] }, context));
		await tick();
		expect(getOrThrow(await launchState(box, terminal.launch, context))).toMatchObject({
			phase: "exited",
			incarnation: 1,
			restarts: 0,
			lastExit: 78,
		});
		const once = getOrThrow(await launch(box, "c", { argv: ["inst"], restart: false }, context));
		await tick();
		expect(getOrThrow(await launchState(box, once.launch, context))).toMatchObject({
			phase: "exited",
			restarts: 0,
			lastExit: 1,
		});
	});

	it("counts a restart that fails to start as an incarnation with exit 126, and goes on within the limit", async () => {
		const provider = fakeBoxes();
		let runs = 0;
		provider.program("inst", (ctx) => {
			runs += 1;
			return runs === 1 ? 2 : forever(ctx);
		});
		const box = getOrThrow(await provider.create(SPEC, context));
		provider.script.on(
			{ op: "incarnation", when: (c) => c.incarnation === 2 },
			{ fail: "spawn" },
			{ label: "restart-fails" },
		);
		const started = getOrThrow(await launch(box, "inst", { argv: ["inst"] }, context));
		await tick();
		expect(getOrThrow(await launchState(box, started.launch, context))).toMatchObject({
			phase: "running",
			incarnation: 3,
			restarts: 2,
			starts: 3,
			lastExit: 126,
		});
		expect(provider.callsOf("incarnation").map((c) => [c.incarnation, c.scripted ?? null])).toEqual([
			[1, null],
			[2, "restart-fails"],
			[3, null],
		]);
	});

	it("gives up when every restart fails to start: incarnation counts, lastExit 126, phase gave_up", async () => {
		const provider = fakeBoxes();
		provider.program("inst", () => 2);
		const box = getOrThrow(await provider.create(SPEC, context));
		provider.script.on(
			{ op: "incarnation", when: (c) => (c.incarnation ?? 0) >= 2 },
			{ fail: "spawn" },
			{ times: 20 },
		);
		const started = getOrThrow(
			await launch(box, "inst", { argv: ["inst"], restartLimit: { burst: 2, intervalMs: 60_000 } }, context),
		);
		await tick();
		expect(getOrThrow(await launchState(box, started.launch, context))).toMatchObject({
			phase: "gave_up",
			incarnation: 3,
			restarts: 2,
			lastExit: 126,
			launcherAlive: false,
		});
	});

	it("reads restarting, incarnation 2, restarts 1, lastExit 126 after a restart that failed to start, within the limit", async () => {
		const clock = fakeClock();
		const provider = fakeBoxes({ clock });
		provider.program("inst", () => 3);
		const box = getOrThrow(await provider.create(SPEC, context));
		provider.script.on({ op: "incarnation", when: (c) => c.incarnation === 2 }, { fail: "spawn" }, { times: 5 });
		const started = getOrThrow(await launch(box, "inst", { argv: ["inst"], restartDelayMs: 1_000 }, context));
		await clock.advance(1);
		expect(getOrThrow(await launchState(box, started.launch, context))).toMatchObject({
			phase: "restarting",
			incarnation: 1,
			restarts: 0,
			lastExit: 3,
		});
		await clock.advance(1_000);
		expect(getOrThrow(await launchState(box, started.launch, context))).toMatchObject({
			phase: "restarting",
			incarnation: 2,
			restarts: 1,
			starts: 2,
			lastExit: 126,
		});
	});

	it("reads exited, incarnation 1, restarts 0 and the code when no restart is attempted: a clean exit", async () => {
		const provider = fakeBoxes();
		provider.program("inst", () => 0);
		const box = getOrThrow(await provider.create(SPEC, context));
		const started = getOrThrow(await launch(box, "inst", { argv: ["inst"] }, context));
		await tick();
		expect(getOrThrow(await launchState(box, started.launch, context))).toMatchObject({
			phase: "exited",
			incarnation: 1,
			restarts: 0,
			starts: 1,
			lastExit: 0,
			launcherAlive: false,
		});
		expect(provider.callsOf("incarnation")).toHaveLength(1);
	});

	it("shows restarting while a restart waits its delay, on the clock", async () => {
		const clock = fakeClock();
		const provider = fakeBoxes({ clock });
		let runs = 0;
		provider.program("inst", (ctx) => {
			runs += 1;
			return runs === 1 ? 1 : forever(ctx);
		});
		const box = getOrThrow(await provider.create(SPEC, context));
		const started = getOrThrow(await launch(box, "inst", { argv: ["inst"], restartDelayMs: 1_000 }, context));
		await clock.advance(1);
		expect(getOrThrow(await launchState(box, started.launch, context))).toMatchObject({
			phase: "restarting",
			incarnation: 1,
			restarts: 0,
			lastExit: 1,
		});
		await clock.advance(1_000);
		expect(getOrThrow(await launchState(box, started.launch, context))).toMatchObject({
			phase: "running",
			incarnation: 2,
			restarts: 1,
		});
	});

	it("answers LaunchError: an unreadable state, a failed start, an unknown launch, and a box that ended", async () => {
		const provider = fakeBoxes();
		provider.program("inst", forever);
		const box = getOrThrow(await provider.create(SPEC, context));
		const started = getOrThrow(await launch(box, "inst", { argv: ["inst"] }, context));
		provider.script.on({ op: "launchState" }, { fail: "box" });
		const unreadable = await launchState(box, started.launch, context);
		expect(unreadable.ok ? "ok" : unreadable.error).toBeInstanceOf(LaunchError);
		expect(unreadable.ok ? "ok" : unreadable.error.code).toBe("box");
		provider.script.on({ op: "launchState" }, { fail: "failed" });
		const failed = await launchState(box, started.launch, context);
		expect(failed.ok ? "ok" : failed.error.code).toBe("failed");
		expect(getOrThrow(await launchState(box, { v: 1, name: "nobody" }, context))).toBeUndefined();
		const unknownStop = await launchStop(box, { v: 1, name: "nobody" }, undefined, context);
		expect(unknownStop.ok ? "ok" : unknownStop.error.code).toBe("invalid");
		provider.script.on({ op: "launch" }, { fail: "timeout" });
		const late = await launch(box, "second", { argv: ["inst"] }, context);
		expect(late.ok ? "ok" : late.error.code).toBe("timeout");
		box.end(null);
		const gone = await launchState(box, started.launch, context);
		expect(gone.ok ? "ok" : gone.error).toBeInstanceOf(LaunchError);
		expect(gone.ok ? "ok" : gone.error.code).toBe("box");
	});

	it("answers a scripted unsafe as the launcher's own LaunchError unsafe, at launch, state and stop", async () => {
		const provider = fakeBoxes();
		provider.program("inst", forever);
		const box = getOrThrow(await provider.create(SPEC, context));
		const started = getOrThrow(await launch(box, "inst", { argv: ["inst"] }, context));
		for (const op of ["launch", "launchState", "launchStop"] as const) provider.script.on({ op }, { fail: "unsafe" });
		const answers = [
			await launch(box, "second", { argv: ["inst"] }, context),
			await launchState(box, started.launch, context),
			await launchStop(box, started.launch, undefined, context),
		];
		for (const answer of answers) {
			expect(answer.ok ? "ok" : answer.error).toBeInstanceOf(LaunchError);
			expect(answer.ok ? "ok" : answer.error.code).toBe("unsafe");
		}
	});

	it("exits with a chosen code by a rule at launch or by the test later", async () => {
		const provider = fakeBoxes();
		provider.program("inst", forever);
		const box = getOrThrow(await provider.create(SPEC, context));
		const first = getOrThrow(await launch(box, "a", { argv: ["inst"], restart: false }, context));
		box.launches[0]?.exit(9);
		await tick();
		expect(getOrThrow(await launchState(box, first.launch, context))).toMatchObject({ phase: "exited", lastExit: 9 });
		provider.script.on({ op: "launch" }, { exit: 4 });
		const quick = getOrThrow(await launch(box, "b", { argv: ["inst"], restart: false }, context));
		await tick();
		expect(getOrThrow(await launchState(box, quick.launch, context))).toMatchObject({ phase: "exited", lastExit: 4 });
	});

	it("keeps a running launch on a second launch of its name, and starts again once it ended", async () => {
		const provider = fakeBoxes();
		provider.program("inst", forever);
		const box = getOrThrow(await provider.create(SPEC, context));
		const first = getOrThrow(await launch(box, "inst", { argv: ["inst"] }, context));
		const again = getOrThrow(await launch(box, "inst", { argv: ["inst"] }, context));
		expect(again).toMatchObject({ phase: "running", incarnation: 1, starts: 1 });
		expect(provider.callsOf("incarnation")).toHaveLength(1);
		getOrThrow(await launchStop(box, first.launch, { graceMs: 10 }, context));
		const next = getOrThrow(await launch(box, "inst", { argv: ["inst"] }, context));
		expect(next).toMatchObject({ phase: "running", incarnation: 1, starts: 1 });
		expect(provider.callsOf("incarnation")).toHaveLength(2);
	});

	it("stops in order, drain then the before-stop program then the kill, and reports stopped", async () => {
		const provider = fakeBoxes();
		const order: string[] = [];
		provider.program(
			"inst",
			({ signal }) =>
				new Promise<number>((resolve) =>
					signal.addEventListener("abort", () => {
						order.push("instance-ended");
						resolve(0);
					}),
				),
		);
		provider.program("reap", () => {
			order.push("reap");
			return 0;
		});
		const box = getOrThrow(await provider.create(SPEC, context));
		const started = getOrThrow(
			await launch(box, "inst", { argv: ["inst"], beforeStop: { argv: ["reap"] } }, context),
		);
		const stopped = getOrThrow(await launchStop(box, started.launch, { graceMs: 100 }, context));
		expect(stopped).toMatchObject({ phase: "stopped", launcherAlive: false });
		expect(box.launches[0]?.events).toEqual(["drain", "beforeStop", "kill"]);
		expect(order).toEqual(["reap", "instance-ended"]);
	});

	it("closes the before-stop program's stdin, so a hook that reads its input does not block the stop", async () => {
		const provider = fakeBoxes();
		provider.program("inst", forever);
		const box = getOrThrow(await provider.create(SPEC, context));
		const started = getOrThrow(await launch(box, "inst", { argv: ["inst"], beforeStop: { argv: ["cat"] } }, context));
		const stopped = await Promise.race([launchStop(box, started.launch, { graceMs: 10 }, context), hung(500)]);
		expect(typeof stopped === "string" ? stopped : stopped.ok ? "ok" : stopped.error.code).toBe("ok");
		expect(box.launches[0]?.events).toEqual(["drain", "beforeStop", "kill"]);
	});

	it("does not restart a program that fails while a planned stop is draining", async () => {
		const provider = fakeBoxes();
		provider.program("inst", forever);
		provider.program("hook", async ({ box }) => {
			box.launches[0]?.exit(1);
			await new Promise((resolve) => setImmediate(resolve));
			return 0;
		});
		const box = getOrThrow(await provider.create(SPEC, context));
		const started = getOrThrow(
			await launch(box, "inst", { argv: ["inst"], beforeStop: { argv: ["hook"] } }, context),
		);
		getOrThrow(await launchStop(box, started.launch, { graceMs: 10 }, context));
		await tick();
		expect(provider.callsOf("incarnation")).toHaveLength(1);
		expect(getOrThrow(await launchState(box, started.launch, context))).toMatchObject({
			phase: "stopped",
			incarnation: 1,
			restarts: 0,
		});
	});

	it("marks a launch lost when its box ends under the running program, and its launcher is gone", async () => {
		const provider = fakeBoxes();
		provider.program("inst", forever);
		const box = getOrThrow(await provider.create(SPEC, context));
		getOrThrow(await launch(box, "inst", { argv: ["inst"] }, context));
		box.end(null);
		await tick();
		expect(box.launches[0]?.status).toMatchObject({ phase: "lost", launcherAlive: false });
	});

	it("reports a launch's tools user in its state and gives the program PI_TRANSPORT_TOOLS_USER and PI_TRANSPORT_TOOLS_UID", async () => {
		const provider = withSecrets();
		let seen = "";
		provider.program("inst", (ctx) => {
			seen = `${ctx.env.PI_TRANSPORT_TOOLS_USER}:${ctx.env.PI_TRANSPORT_TOOLS_UID}`;
			return forever(ctx);
		});
		const box = getOrThrow(await provider.create(SPEC, context));
		const state = getOrThrow(
			await launch(box, "inst", { argv: ["inst"], stdin: enc("x"), toolsUser: "pda" }, context),
		);
		await tick();
		expect(state.toolsUser).toEqual({ name: "pda", uid: 1000 });
		expect(seen).toBe("pda:1000");
		const numeric = getOrThrow(
			await launch(box, "n", { argv: ["inst"], stdin: enc("x"), toolsUser: "1234" }, context),
		);
		expect(numeric.toolsUser).toEqual({ name: "user1234", uid: 1234 });
		// the launcher's own pure check still runs first: a tools user that is root never reaches the box
		const root = await launch(box, "r", { argv: ["inst"], stdin: enc("x"), toolsUser: "root" }, context);
		expect(root.ok ? "ok" : root.error.code).toBe("invalid");
		expect(provider.callsOf("launch").map((c) => c.launch)).toEqual(["inst", "n"]);
		// a launch with no tools user has none in its state
		const plain = getOrThrow(await launch(box, "p", { argv: ["inst"] }, context));
		expect(plain.toolsUser).toBeUndefined();
	});
});
