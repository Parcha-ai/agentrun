import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { afterAll, describe, expect, it } from "vitest";
import type { Box, BoxSpec } from "../src/box/box.ts";
import { e2bBoxes } from "../src/box/e2b.ts";
import { finish } from "../src/box/files.ts";
import { registerBoxConformance } from "../src/testing/index.ts";
import { AuthenticationError, FakeE2b, InvalidArgumentError, RateLimitError } from "./e2b-fake.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
process.env[CANARY] = "the host's environment reached a box";
const context = BACKGROUND_CONTEXT;
const SPEC: BoxSpec = { maxLifetimeMs: 60_000, labels: { run: "a" } };

function withRoot<T>(use: (root: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-e2b-"));
	return use(root).finally(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!result.ok) throw result.error;
	return result.value;
}

const conformanceRoot = mkdtempSync(join(tmpdir(), "pi-transport-e2b-conf-"));
registerBoxConformance({ describe, expect, it }, "e2b boxes over a fake SDK", (use) => use(e2bBoxes(new FakeE2b())), {
	absentEnv: [CANARY],
	textOutput: true,
	spec: { workspace: join(conformanceRoot, "ws") },
});
afterAll(() => rmSync(conformanceRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

describe("e2b boxes", () => {
	it("passes the lifetime, the template, the env and the labels to E2B and reports facts", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeE2b();
			const provider = e2bBoxes(sdk, { template: "base-template" });
			const box = unwrap(
				await provider.create({ ...SPEC, workspace: root, maxLifetimeMs: 90_500, env: { A: "1" } }, context),
			);
			const made = sdk.sandboxes[0]?.options;
			expect(made).toMatchObject({ template: "base-template", envs: { A: "1" }, timeoutMs: 91_000 });
			expect(made?.metadata).toMatchObject({ run: "a", "pi-transport": "1", "pi-transport.box": "1" });
			expect(box.facts()).toMatchObject({
				provider: "e2b",
				isolation: "vm",
				cpus: 2,
				memoryMb: 512,
				gpu: null,
				workspace: root,
				maxLifetimeMs: 91_000,
				snapshot: null,
				bulk: "files",
			});
			// A spec's own image is the template.
			unwrap(await provider.create({ ...SPEC, workspace: root, image: "mine" }, context));
			expect(sdk.sandboxes[1]?.options.template).toBe("mine");
			for (const sandbox of sdk.sandboxes) await sandbox.kill();
		});
	});

	it("refuses what the template decides, a snapshot, a GPU and a stronger isolation, before any E2B call", async () => {
		const sdk = new FakeE2b();
		const provider = e2bBoxes(sdk);
		const refused = async (spec: Partial<BoxSpec>) => {
			const result = await provider.create({ ...SPEC, ...spec }, context);
			return result.ok ? "created" : result.error.code;
		};
		expect(await refused({ cpus: 4 })).toBe("unsupported");
		expect(await refused({ memoryMb: 1024 })).toBe("unsupported");
		expect(await refused({ region: "eu" })).toBe("unsupported");
		expect(await refused({ gpu: "T4" })).toBe("unsupported");
		expect(await refused({ snapshot: "snap" })).toBe("unsupported");
		expect(await refused({ isolation: "container" })).toBe("unsupported");
		expect(await refused({ maxLifetimeMs: 0 })).toBe("invalid");
		expect(await refused({ workspace: "relative" })).toBe("invalid");
		expect(await refused({ labels: { "pi-transport.x": "1" } })).toBe("invalid");
		expect(sdk.sandboxes).toHaveLength(0);
	});

	it("maps the SDK's errors to box error codes", async () => {
		const sdk = new FakeE2b();
		const provider = e2bBoxes(sdk);
		const code = async (failure: Error) => {
			sdk.createFailure = failure;
			const result = await provider.create(SPEC, context);
			return result.ok ? "created" : result.error.code;
		};
		expect(await code(new InvalidArgumentError("timeout over the plan"))).toBe("invalid");
		expect(await code(new RateLimitError("too many"))).toBe("capacity");
		expect(await code(new AuthenticationError("bad key"))).toBe("unauthorized");
		expect(await code(new Error("something else"))).toBe("unknown");
	});

	it("runs an argv as the program receives it, quoting every word, in the workspace and with the box's own env only", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeE2b();
			const provider = e2bBoxes(sdk);
			const box = unwrap(await provider.create({ ...SPEC, workspace: root, env: { ONLY: "this" } }, context));
			const started = unwrap(
				await box.exec(
					["sh", "-c", 'printf "%s|%s|%s" "$1" "$ONLY" "$PI_TRANSPORT_HOST_CANARY"', "x", "it's"],
					undefined,
					context,
				),
			);
			const done = unwrap(await finish(started));
			expect(done.exitCode).toBe(0);
			expect(done.stdout.length).toBeGreaterThan(0);
			const text = new TextDecoder().decode(done.stdout);
			expect(text).toBe("it's|this|");
			const run = sdk.sandboxes[0]?.runs.at(-1);
			expect(run?.options.cwd).toBe(root);
			expect(run?.command).toContain(`'it'\\''s'`);
			await box.destroy(context);
		});
	});

	it("keeps every byte of a file through upload and download, which output does not", async () => {
		await withRoot(async (root) => {
			const provider = e2bBoxes(new FakeE2b());
			const box = unwrap(await provider.create({ ...SPEC, workspace: root }, context));
			const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);
			unwrap(await box.upload([{ path: "deep/er/all.bin", bytes, mode: 0o755 }], context));
			const [file] = unwrap(await box.download(["deep/er/all.bin"], context));
			expect(Array.from(file?.bytes ?? [])).toEqual(Array.from(bytes));
			const mode = unwrap(
				await finish(unwrap(await box.exec(["stat", "-c", "%a", "deep/er/all.bin"], undefined, context))),
			);
			expect(new TextDecoder().decode(mode.stdout).trim()).toBe("755");
			const missing = await box.download(["nope.bin"], context);
			expect(missing.ok ? "" : missing.error.code).toBe("not_found");
			await box.destroy(context);
		});
	});

	it("kills the program when the call is aborted or the timeout passes, and reports each as such", async () => {
		await withRoot(async (root) => {
			const provider = e2bBoxes(new FakeE2b());
			const box = unwrap(await provider.create({ ...SPEC, workspace: root }, context));
			const slow = unwrap(await box.exec(["sleep", "30"], { timeoutMs: 300 }, context));
			const timedOut = await slow.wait();
			expect(timedOut.ok ? "" : timedOut.error.code).toBe("timeout");
			const call = withCancel(context);
			const waiting = unwrap(await box.exec(["sleep", "30"], undefined, call.context));
			setTimeout(call.cancel, 100);
			const aborted = await waiting.wait();
			expect(aborted.ok ? "" : aborted.error.code).toBe("aborted");
			await box.destroy(context);
		});
	});

	it("says gone for a box that ended, from every call, and attach finds a box again by its facts", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeE2b();
			const provider = e2bBoxes(sdk);
			const box = unwrap(await provider.create({ ...SPEC, workspace: root }, context));
			const again = unwrap(await provider.attach(box.id, context)) as Box;
			expect(again.facts()).toMatchObject({ provider: "e2b", workspace: root, bulk: "files" });
			// The sandbox ends behind the provider's back (its lifetime ran out, or it was killed).
			await sdk.sandboxes[0]?.kill();
			expect(unwrap(await box.status(context))).toEqual({ state: "ended", exitCode: null });
			const started = await box.exec(["true"], undefined, context);
			expect(started.ok ? "" : started.error.code).toBe("gone");
			expect(unwrap(await provider.attach(box.id, context))).toBeUndefined();
			expect(unwrap(await box.destroy(context))).toBeUndefined();
		});
	});

	it("lists the running boxes with the labels, across pages, and not the ones it did not start", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeE2b();
			const provider = e2bBoxes(sdk);
			const a = unwrap(await provider.create({ ...SPEC, workspace: root, labels: { run: "x" } }, context));
			const b = unwrap(await provider.create({ ...SPEC, workspace: root, labels: { run: "x" } }, context));
			unwrap(await provider.create({ ...SPEC, workspace: root, labels: { run: "y" } }, context));
			// One that is not this package's.
			await sdk.create({ metadata: { run: "x" }, timeoutMs: 60_000 });
			const listed = unwrap(await provider.list({ run: "x" }, context));
			expect(listed.map((ref) => ref.id).sort()).toEqual([a.id, b.id].sort());
			expect(listed.every((ref) => ref.labels.run === "x" && !("pi-transport" in ref.labels))).toBe(true);
			for (const sandbox of sdk.sandboxes) await sandbox.kill();
		});
	});
});
