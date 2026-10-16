import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { afterAll, describe, expect, it } from "vitest";
import type { Box, BoxSpec } from "../src/box/box.ts";
import { finish, readStream } from "../src/box/files.ts";
import { modalBoxes } from "../src/box/modal.ts";
import { registerBoxConformance } from "../src/testing/index.ts";
import { FakeModal, InvalidError, NotFoundError, ResourceExhaustedError } from "./modal-fake.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
process.env[CANARY] = "the host's environment reached a box";
const context = BACKGROUND_CONTEXT;
const SPEC: BoxSpec = { maxLifetimeMs: 60_000, labels: { run: "a" } };

function withRoot<T>(use: (root: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-modal-"));
	return use(root).finally(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!result.ok) throw result.error;
	return result.value;
}

const conformanceRoot = mkdtempSync(join(tmpdir(), "pi-transport-modal-conf-"));
registerBoxConformance(
	{ describe, expect, it },
	"modal boxes over a fake SDK",
	(use) => use(modalBoxes(new FakeModal(), { appName: "pi-transport-test-fake" })),
	{ absentEnv: [CANARY], spec: { workspace: join(conformanceRoot, "ws") } },
);
afterAll(() => rmSync(conformanceRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

describe("modal boxes", () => {
	it("passes lifetime, size, region and tags to Modal and reports facts", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const provider = modalBoxes(sdk, { appName: "pi-transport-test-app" });
			const box = unwrap(
				await provider.create(
					{
						...SPEC,
						isolation: "vm",
						cpus: 2,
						memoryMb: 2048,
						region: "us-east",
						workspace: root,
						maxLifetimeMs: 90_500,
					},
					context,
				),
			);
			const params = sdk.sandboxList[0]?.params;
			expect(sdk.appNames).toEqual(["pi-transport-test-app"]);
			expect(params).toMatchObject({
				runtime: "vm",
				cpu: 2,
				memoryMiB: 2048,
				regions: ["us-east"],
				timeoutMs: 91_000,
			});
			expect(params?.tags).toMatchObject({ run: "a", "pi-transport": "1", "pi-transport.box": "1" });
			expect(box.facts()).toMatchObject({
				provider: "modal",
				isolation: "vm",
				cpus: 2,
				gpu: null,
				maxLifetimeMs: 91_000,
			});
			unwrap(await box.destroy(context));
		});
	});

	it("asks Modal for gvisor when the spec says so", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const box = unwrap(
				await modalBoxes(sdk, { appName: "a" }).create({ ...SPEC, isolation: "gvisor", workspace: root }, context),
			);
			expect(box.facts().isolation).toBe("gvisor");
			expect(sdk.sandboxList[0]?.params).toMatchObject({ runtime: "gvisor" });
			unwrap(await box.destroy(context));
		});
	});

	it("reports gvisor without a runtime, and caps the lifetime at 24 hours", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const box = unwrap(
				await modalBoxes(sdk, { appName: "a" }).create(
					{ ...SPEC, gpu: "T4", workspace: root, maxLifetimeMs: 48 * 3_600_000 },
					context,
				),
			);
			expect(box.facts()).toMatchObject({ isolation: "gvisor", gpu: "T4", maxLifetimeMs: 24 * 3_600_000 });
			expect(sdk.sandboxList[0]?.params).toMatchObject({ gpu: "T4" });
			expect(sdk.sandboxList[0]?.params).not.toHaveProperty("runtime");
			unwrap(await box.destroy(context));
		});
	});

	it("refuses a GPU on a vm, other isolations, a snapshot and a lifetime of zero, without calling Modal", async () => {
		const sdk = new FakeModal();
		const provider = modalBoxes(sdk, { appName: "a" });
		const codes = [];
		for (const spec of [
			{ ...SPEC, gpu: "T4", isolation: "vm" as const },
			{ ...SPEC, isolation: "container" as const },
			{ ...SPEC, isolation: "none" as const },
			{ ...SPEC, snapshot: "s" },
			{ ...SPEC, maxLifetimeMs: 0 },
		]) {
			const result = await provider.create(spec, context);
			codes.push(result.ok ? "ok" : result.error.code);
		}
		expect(codes).toEqual(["invalid", "unsupported", "unsupported", "unsupported", "invalid"]);
		expect(sdk.sandboxList).toEqual([]);
		expect(sdk.appNames).toEqual([]);
	});

	it("maps create failures to coded errors", async () => {
		const sdk = new FakeModal();
		const provider = modalBoxes(sdk, { appName: "a" });
		const codes = [];
		for (const error of [
			new ResourceExhaustedError("no GPUs"),
			new InvalidError("bad"),
			new Error("UNAUTHENTICATED: token"),
		]) {
			sdk.fail.create = error;
			const result = await provider.create(SPEC, context);
			codes.push(result.ok ? "ok" : result.error.code);
		}
		expect(codes).toEqual(["capacity", "invalid", "unauthorized"]);
	});

	it("terminates a sandbox whose workspace could not be made", async () => {
		const sdk = new FakeModal();
		const result = await modalBoxes(sdk, { appName: "a" }).create(
			{ ...SPEC, workspace: "/proc/pi-transport-no/ws" },
			context,
		);
		expect(result.ok).toBe(false);
		expect(sdk.running()).toEqual([]);
	});

	it("attach recovers a box's facts from its tags and refuses sandboxes that are not ours", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const provider = modalBoxes(sdk, { appName: "a" });
			const box = unwrap(await provider.create({ ...SPEC, isolation: "vm", workspace: root }, context));
			const again = unwrap(await modalBoxes(sdk, { appName: "a" }).attach(box.id, context));
			expect(again?.facts()).toEqual(box.facts());
			const foreign = await sdk.sandboxes.create({ appId: "x" }, {}, { timeoutMs: 1000, tags: {} });
			expect(unwrap(await provider.attach(foreign.sandboxId, context))).toBeUndefined();
			sdk.fail.fromId = new InvalidError("not an id");
			expect(unwrap(await provider.attach("whatever", context))).toBeUndefined();
			sdk.fail.fromId = new Error("connection reset");
			const failed = await provider.attach(box.id, context);
			expect(failed.ok ? "ok" : failed.error.code).toBe("unknown");
			sdk.fail.fromId = undefined;
			unwrap(await box.destroy(context));
			expect(unwrap(await provider.attach(box.id, context))).toBeUndefined();
		});
	});

	it("refuses a label in the providers' namespace before any Modal call", async () => {
		const sdk = new FakeModal();
		const result = await modalBoxes(sdk, { appName: "a" }).create(
			{ ...SPEC, labels: { run: "a", "pi-transport.box": "0" } },
			context,
		);
		expect(result.ok ? "ok" : result.error.code).toBe("invalid");
		const bare = await modalBoxes(sdk, { appName: "a" }).create(
			{ ...SPEC, labels: { "pi-transport": "0" } },
			context,
		);
		expect(bare.ok ? "ok" : bare.error.code).toBe("invalid");
		expect(sdk.sandboxList).toEqual([]);
	});

	it("attach answers undefined for a box whose facts tag it cannot read", async () => {
		const sdk = new FakeModal();
		const provider = modalBoxes(sdk, { appName: "a" });
		const tagged = (facts: string) =>
			sdk.sandboxes.create(
				{ appId: "x" },
				{},
				{ timeoutMs: 1000, tags: { "pi-transport.box": "1", "pi-transport.facts": facts } },
			);
		for (const facts of [
			"not json",
			"null",
			"[]",
			'{"provider":"modal"}',
			'{"provider":"modal","isolation":"container"}',
		]) {
			const sandbox = await tagged(facts);
			expect(unwrap(await provider.attach(sandbox.sandboxId, context))).toBeUndefined();
		}
	});

	it("list returns own labels only, for running boxes of this package", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const provider = modalBoxes(sdk, { appName: "a" });
			const box = unwrap(
				await provider.create({ ...SPEC, workspace: root, labels: { run: "a", extra: "1" } }, context),
			);
			await sdk.sandboxes.create({ appId: "x" }, {}, { timeoutMs: 1000, tags: { run: "a" } });
			expect(unwrap(await provider.list({ run: "a" }, context))).toEqual([
				{ id: box.id, labels: { run: "a", extra: "1" } },
			]);
			unwrap(await box.destroy(context));
			expect(unwrap(await provider.list({ run: "a" }, context))).toEqual([]);
		});
	});

	it("gives a program the spec's env, in the workspace, and nothing else", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const box: Box = unwrap(
				await modalBoxes(sdk, { appName: "a" }).create(
					{ ...SPEC, workspace: root, env: { GREETING: "hi" } },
					context,
				),
			);
			const started = unwrap(await box.exec(["printf", "x"], { timeoutMs: 1000 }, context));
			for await (const _ of started.stdout) void _;
			const call = sdk.sandboxList[0]?.execs.at(-1);
			expect(call?.params).toMatchObject({ mode: "binary", workdir: root, timeoutMs: 6000 });
			// The settings belong to the sandbox, not to each program started through one handle.
			expect(call?.params).not.toHaveProperty("env");
			expect(sdk.sandboxList[0]?.params.env).toEqual({ GREETING: "hi" });
			unwrap(await box.destroy(context));
		});
	});

	it("runs programs with the spec's env in a box found again by another provider", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const box = unwrap(
				await modalBoxes(sdk, { appName: "a" }).create(
					{ ...SPEC, workspace: root, env: { GREETING: "hi" } },
					context,
				),
			);
			const again = unwrap(await modalBoxes(sdk, { appName: "a" }).attach(box.id, context));
			const started = unwrap(await (again as Box).exec(["sh", "-c", 'printf %s "$GREETING"'], undefined, context));
			const finished = unwrap(await finish(started));
			expect(new TextDecoder().decode(finished.stdout)).toBe("hi");
			unwrap(await box.destroy(context));
		});
	});

	it("does not take an output stream that broke for a complete output", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const box = unwrap(await modalBoxes(sdk, { appName: "a" }).create({ ...SPEC, workspace: root }, context));
			const sandbox = sdk.sandboxList[0];
			if (!sandbox) throw new Error("no sandbox");
			// The program exits 0, but its output stream fails after some bytes.
			sandbox.exec = async () => ({
				stdin: { writeBytes: async () => {}, close: async () => {} },
				stdout: (async function* () {
					yield Uint8Array.of(1, 2, 3);
					throw new Error("connection reset");
				})(),
				stderr: (async function* () {})(),
				wait: async () => 0,
			});
			const downloaded = await box.download(["part.bin"], context);
			expect(downloaded.ok).toBe(false);
			if (!downloaded.ok) {
				expect(downloaded.error.code).toBe("unknown");
				expect(downloaded.error.message).toMatch(/stream/);
			}
		});
	});

	it("keeps the command's deadline and abort while it waits for output after the exit", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const box = unwrap(await modalBoxes(sdk, { appName: "a" }).create({ ...SPEC, workspace: root }, context));
			const sandbox = sdk.sandboxList[0];
			if (!sandbox) throw new Error("no sandbox");
			// The program exits at once, but its output stream stalls and never ends.
			const stalled = () => ({
				stdin: { writeBytes: async () => {}, close: async () => {} },
				stdout: (async function* () {
					yield Uint8Array.of(1);
					await new Promise(() => {});
				})(),
				stderr: (async function* () {})(),
				wait: async () => 0,
			});
			sandbox.exec = async () => stalled();
			const timed = unwrap(await box.exec(["true"], { timeoutMs: 300 }, context));
			void readStream(timed.stdout).catch(() => {});
			const startedAt = Date.now();
			// The stream never ends: only the deadline can end the wait.
			const exit = await timed.wait();
			console.log(`a stalled stream past its deadline: the wait ended after ${Date.now() - startedAt} ms`);
			expect(exit.ok ? "ok" : exit.error.code).toBe("timeout");

			const cancellable = withCancel(context);
			const aborted = unwrap(await box.exec(["true"], undefined, cancellable.context));
			void readStream(aborted.stdout).catch(() => {});
			setTimeout(() => cancellable.cancel(), 200);
			const abortedAt = Date.now();
			const ended = await aborted.wait();
			console.log(`a stalled stream whose context ended: the wait ended after ${Date.now() - abortedAt} ms`);
			expect(ended.ok ? "ok" : ended.error.code).toBe("aborted");
		});
	});

	it("ends the sandbox of a create the caller cancelled, at each step", async () => {
		for (const step of ["app", "image", "sandbox"] as const) {
			await withRoot(async (root) => {
				const sdk = new FakeModal();
				const cancellable = withCancel(context);
				if (step === "app") {
					const fromName = sdk.apps.fromName;
					sdk.apps.fromName = async (name, params) => {
						cancellable.cancel();
						return fromName(name, params);
					};
				} else if (step === "image") {
					sdk.images.fromRegistry = (tag) => {
						cancellable.cancel();
						return { registry: tag };
					};
				} else {
					const create = sdk.sandboxes.create;
					sdk.sandboxes.create = async (app, image, params) => {
						const sandbox = await create(app, image, params);
						cancellable.cancel();
						return sandbox;
					};
				}
				const created = await modalBoxes(sdk, { appName: "a" }).create(
					{ ...SPEC, workspace: root },
					cancellable.context,
				);
				expect(created.ok ? "ok" : created.error.code, step).toBe("aborted");
				expect(sdk.running(), step).toEqual([]);
			});
		}
	});

	it("makes a found box's workspace when a host died before it was made", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const workspace = join(root, "made-later");
			const box = unwrap(await modalBoxes(sdk, { appName: "a" }).create({ ...SPEC, workspace }, context));
			rmSync(workspace, { recursive: true, force: true });
			const again = unwrap(await modalBoxes(sdk, { appName: "a" }).attach(box.id, context));
			const started = unwrap(await (again as Box).exec(["pwd"], undefined, context));
			const finished = unwrap(await finish(started));
			expect(finished.exitCode).toBe(0);
			expect(new TextDecoder().decode(finished.stdout).trim()).toBe(workspace);
			unwrap(await box.destroy(context));
		});
	});

	it("refuses a workspace that is not an absolute path before any Modal call", async () => {
		const sdk = new FakeModal();
		const result = await modalBoxes(sdk, { appName: "a" }).create({ ...SPEC, workspace: "relative/ws" }, context);
		expect(result.ok ? "ok" : result.error.code).toBe("invalid");
		expect(sdk.sandboxList).toEqual([]);
		expect(sdk.appNames).toEqual([]);
	});

	it("gives Modal a program timeout that is a whole number of seconds", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const box = unwrap(await modalBoxes(sdk, { appName: "a" }).create({ ...SPEC, workspace: root }, context));
			const started = unwrap(await box.exec(["true"], { timeoutMs: 500 }, context));
			for await (const _ of started.stdout) void _;
			expect(sdk.sandboxList[0]?.execs.at(-1)?.params.timeoutMs).toBe(6000);
			unwrap(await box.destroy(context));
		});
	});

	it("reads a gRPC status on the wire as a coded error", async () => {
		const sdk = new FakeModal();
		const provider = modalBoxes(sdk, { appName: "a" });
		sdk.fail.fromId = Object.assign(new Error("INVALID_ARGUMENT: not a valid sandbox ID"), { code: 3 });
		expect(unwrap(await provider.attach("no-such-box", context))).toBeUndefined();
		sdk.fail.create = Object.assign(new Error("RESOURCE_EXHAUSTED"), { code: 8 });
		const created = await provider.create(SPEC, context);
		expect(created.ok ? "ok" : created.error.code).toBe("capacity");
	});

	it("writes input to Modal in chunks of at most 512 KiB", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const box = unwrap(await modalBoxes(sdk, { appName: "a" }).create({ ...SPEC, workspace: root }, context));
			const bytes = new Uint8Array(1_300_000).fill(7);
			unwrap(await box.upload([{ path: "big.bin", bytes }], context));
			expect(sdk.sandboxList[0]?.writes).toEqual([524_288, 524_288, 251_424]);
			const [file] = unwrap(await box.download(["big.bin"], context));
			expect(file?.bytes.length).toBe(bytes.length);
			unwrap(await box.destroy(context));
		});
	});

	it("reports a sandbox that Modal ended on its own as ended and gone", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const box = unwrap(await modalBoxes(sdk, { appName: "a" }).create({ ...SPEC, workspace: root }, context));
			await sdk.sandboxList[0]?.terminate({ wait: true });
			expect(unwrap(await box.status(context))).toEqual({ state: "ended", exitCode: 0 });
			const result = await box.exec(["true"], undefined, context);
			expect(result.ok ? "ok" : result.error.code).toBe("gone");
			unwrap(await box.destroy(context));
		});
	});

	it("treats a sandbox Modal no longer knows as ended when it is destroyed", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const box = unwrap(await modalBoxes(sdk, { appName: "a" }).create({ ...SPEC, workspace: root }, context));
			const sandbox = sdk.sandboxList[0];
			if (!sandbox) throw new Error("no sandbox");
			sandbox.terminate = async () => {
				throw new NotFoundError("gone");
			};
			unwrap(await box.destroy(context));
			expect(unwrap(await box.status(context))).toEqual({ state: "ended", exitCode: null });
		});
	});
});
