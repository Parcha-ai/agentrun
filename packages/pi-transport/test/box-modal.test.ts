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
			sdk.served = ["Tesla T4"];
			const box = unwrap(
				await modalBoxes(sdk, { appName: "a" }).create(
					{ ...SPEC, gpu: "T4", workspace: root, maxLifetimeMs: 48 * 3_600_000 },
					context,
				),
			);
			expect(box.facts()).toMatchObject({ isolation: "gvisor", gpu: "Tesla T4", maxLifetimeMs: 24 * 3_600_000 });
			expect(sdk.sandboxList[0]?.params).toMatchObject({ gpu: "T4" });
			expect(sdk.sandboxList[0]?.params).not.toHaveProperty("runtime");
			unwrap(await box.destroy(context));
		});
	});

	describe("network, ports and what the box reports of itself", () => {
		const provider = (sdk: FakeModal) => modalBoxes(sdk, { appName: "a" });

		it("maps none to blockNetwork, an allowlist to Modal's domain and CIDR lists, and reports it in the facts", async () => {
			await withRoot(async (root) => {
				const sdk = new FakeModal();
				const none = unwrap(await provider(sdk).create({ ...SPEC, network: "none", workspace: root }, context));
				const list = unwrap(
					await provider(sdk).create(
						{ ...SPEC, network: { allow: ["*.example.com", "10.0.0.0/8"] }, workspace: root },
						context,
					),
				);
				const open = unwrap(await provider(sdk).create({ ...SPEC, workspace: root }, context));
				expect(sdk.sandboxList[0]?.params).toMatchObject({ blockNetwork: true });
				expect(sdk.sandboxList[1]?.params).toMatchObject({
					outboundDomainAllowlist: ["*.example.com"],
					outboundCidrAllowlist: ["10.0.0.0/8"],
				});
				expect(sdk.sandboxList[1]?.params).not.toHaveProperty("blockNetwork");
				for (const key of ["blockNetwork", "outboundDomainAllowlist", "outboundCidrAllowlist"]) {
					expect(sdk.sandboxList[2]?.params).not.toHaveProperty(key);
				}
				expect([none, list, open].map((b) => b.facts().network)).toEqual(["none", "allowlist", "open"]);
				for (const box of [none, list, open]) unwrap(await box.destroy(context));
			});
		});

		it("refuses a bad network or port, and a port on a box with no network, before any Modal call", async () => {
			const sdk = new FakeModal();
			const codes = [];
			for (const spec of [
				{ network: { allow: [] } },
				{ network: { allow: ["not a domain"] } },
				{ ports: [0] },
				{ ports: [80, 80] },
				{ network: "none" as const, ports: [8080] },
			]) {
				const result = await provider(sdk).create({ ...SPEC, ...spec }, context);
				codes.push(result.ok ? "ok" : result.error.code);
			}
			expect(codes).toEqual(Array(5).fill("invalid"));
			expect(sdk.sandboxList).toEqual([]);
		});

		it("exposes ports as encrypted or plain tunnels, names each kind in the facts, and answers endpoint with the address", async () => {
			await withRoot(async (root) => {
				const sdk = new FakeModal();
				const box = unwrap(
					await provider(sdk).create(
						{ ...SPEC, ports: [8080, { port: 5432, kind: "tcp" }], workspace: root },
						context,
					),
				);
				expect(sdk.sandboxList[0]?.params).toMatchObject({ encryptedPorts: [8080], unencryptedPorts: [5432] });
				expect(box.facts().ports).toEqual([
					{ port: 8080, kind: "https" },
					{ port: 5432, kind: "tcp" },
				]);
				expect(unwrap(await (box.endpoint?.(8080, context) as Promise<never>))).toEqual({
					kind: "https",
					url: "https://fake-8080.modal.test",
				});
				expect(unwrap(await (box.endpoint?.(5432, context) as Promise<never>))).toEqual({
					kind: "tcp",
					host: "fake-5432.modal.test",
					port: 45_432,
				});
				const unexposed = await box.endpoint?.(9999, context);
				expect(unexposed?.ok ? "ok" : unexposed?.error.code).toBe("invalid");
				expect(box.id).not.toContain("modal.test");
				unwrap(await box.destroy(context));
			});
		});

		it("reports the disk the box has, in whole GiB, the Yama setting, and when it started", async () => {
			await withRoot(async (root) => {
				const sdk = new FakeModal();
				sdk.probeOutput = "disk=52428801\nptrace=2\n";
				const before = Date.now();
				const box = unwrap(await provider(sdk).create({ ...SPEC, workspace: root }, context));
				const facts = box.facts();
				expect(facts).toMatchObject({ diskGb: 50, ptraceScope: 2, fuse: false });
				expect(new Date(facts.startedAt ?? "").getTime()).toBeGreaterThanOrEqual(before - 1000);
				expect(facts.startedAt).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
				const again = unwrap(await provider(sdk).attach(box.id, context));
				expect(again?.facts()).toMatchObject({ diskGb: 50, ptraceScope: 2, startedAt: facts.startedAt });
				unwrap(await box.destroy(context));
			});
		});

		it("leaves a fact it cannot read out, and reads a box without the Yama file as 0", async () => {
			await withRoot(async (root) => {
				const sdk = new FakeModal();
				sdk.probeOutput = "disk=\nptrace=banana\n";
				const odd = unwrap(await provider(sdk).create({ ...SPEC, workspace: root }, context));
				sdk.probeOutput = "disk=1048576\nptrace=0\n";
				const none = unwrap(await provider(sdk).create({ ...SPEC, workspace: root }, context));
				for (const key of ["diskGb", "ptraceScope"]) expect(odd.facts()).not.toHaveProperty(key);
				expect(none.facts()).toMatchObject({ diskGb: 1, ptraceScope: 0 });
				unwrap(await odd.destroy(context));
				unwrap(await none.destroy(context));
			});
		});

		it("reads a box whose tag predates the network and ports facts as unknown for both, never as open or as none", async () => {
			await withRoot(async (root) => {
				const sdk = new FakeModal();
				const box = unwrap(await provider(sdk).create({ ...SPEC, workspace: root }, context));
				const tags = sdk.sandboxList[0]?.params.tags ?? {};
				const old = JSON.parse(tags["pi-transport.facts"] ?? "{}") as Record<string, unknown>;
				delete old.network;
				delete old.ports;
				delete old.startedAt;
				tags["pi-transport.facts"] = JSON.stringify(old);
				const found = unwrap(await provider(sdk).attach(box.id, context));
				for (const key of ["network", "ports", "startedAt"]) expect(found?.facts()).not.toHaveProperty(key);
				const asked = await found?.endpoint?.(8080, context);
				expect(asked?.ok ? "ok" : asked?.error.code).toBe("invalid");
				unwrap(await box.destroy(context));
			});
		});

		it("gives fuse on the vm runtime only when the box checks out, and ends a box that does not", async () => {
			await withRoot(async (root) => {
				const sdk = new FakeModal();
				const box = unwrap(
					await provider(sdk).create({ ...SPEC, capabilities: ["fuse"], workspace: root }, context),
				);
				expect(sdk.sandboxList[0]?.params).toMatchObject({ runtime: "vm" });
				expect(box.facts()).toMatchObject({ isolation: "vm", fuse: true });
				const probe = sdk.sandboxList[0]?.execs.find(
					(e) => e.command[0] === "sh" && e.command[2]?.includes("fuse"),
				);
				expect(probe?.command.slice(3)).toEqual(["sh", root, "fuse", "-"]);
				const again = unwrap(await provider(sdk).attach(box.id, context));
				expect(again?.facts().fuse).toBe(true);
				const plain = unwrap(await provider(sdk).create({ ...SPEC, workspace: root }, context));
				expect(plain.facts().fuse).toBe(false);
				for (const [output, missing] of [
					["disk=1\nptrace=1\nfuse_dev=0\n", /character device that root can open/],
				] as const) {
					sdk.probeOutput = output;
					const lacking = await provider(sdk).create(
						{ ...SPEC, capabilities: ["fuse"], workspace: root },
						context,
					);
					expect(lacking.ok ? "ok" : lacking.error.code).toBe("unknown");
					expect(!lacking.ok && lacking.error.message).toMatch(missing);
				}
				expect(sdk.running().map((s) => s.sandboxId)).toEqual([box.id, plain.id]);
				unwrap(await box.destroy(context));
				unwrap(await plain.destroy(context));
			});
		});

		describe("attach of a live sandbox always returns the handle, and never ends the box", () => {
			const MEASURED = "pi-transport.measured";
			const fuseBox = async (root: string, extra: Partial<BoxSpec> = {}) => {
				const sdk = new FakeModal();
				const box = unwrap(
					await provider(sdk).create({ ...SPEC, capabilities: ["fuse"], workspace: root, ...extra }, context),
				);
				const sandbox = sdk.sandboxList[0];
				if (sandbox === undefined) throw new Error("no sandbox");
				return { sdk, box, sandbox };
			};
			const isProbe = (command: string[]) => command[0] === "sh" && command[2]?.includes("ptrace_scope") === true;
			/** The probe throws `times` times, then works; `tries.count` is how many times it was asked. */
			const failProbe = (
				sandbox: { exec: (command: string[], params: never) => Promise<unknown> },
				times: number,
			) => {
				const exec = sandbox.exec.bind(sandbox);
				const tries = { count: 0 };
				let left = times;
				sandbox.exec = async (command: string[], params: never) => {
					if (isProbe(command)) {
						tries.count++;
						if (left-- > 0) throw new Error("the connection went away");
					}
					return exec(command, params);
				};
				return tries;
			};
			const end = async (
				sdk: FakeModal,
				attached: { destroy: (c: typeof context) => Promise<unknown> } | undefined,
			) => {
				await (attached as NonNullable<typeof attached>).destroy(context);
				expect(sdk.running()).toEqual([]);
			};

			it("is an attach ERROR when the workspace setup fails (mkdir exits non-zero, or the exec errs): the box runs on, nothing is created", async () => {
				await withRoot(async (root) => {
					const { sdk, box, sandbox } = await fuseBox(root);
					const exec = sandbox.exec.bind(sandbox);
					for (const how of ["exits", "errs"] as const) {
						sandbox.exec = async (command, params) => {
							if (command[0] !== "mkdir") return exec(command, params);
							if (how === "errs") throw new Error("the connection went away");
							return exec(["sh", "-c", "echo no space left >&2; exit 1"], params);
						};
						const attached = await provider(sdk).attach(box.id, context);
						expect(attached.ok ? "ok" : attached.error.code, how).toBe("unknown");
						expect(
							sdk.running().map((each) => each.sandboxId),
							how,
						).toEqual([box.id]);
						expect(sdk.sandboxList, how).toHaveLength(1);
					}
					// With the setup working again the same box attaches and is ended through its handle.
					sandbox.exec = exec;
					await end(sdk, unwrap(await provider(sdk).attach(box.id, context)));
				});
			});

			it("stores what the create measured in the box's tag", async () => {
				await withRoot(async (root) => {
					const { box, sandbox } = await fuseBox(root);
					const stored = JSON.parse((await sandbox.getTags())[MEASURED] ?? "null") as Record<
						string,
						unknown
					> | null;
					expect(stored).toEqual({ fuse: true, diskGb: 100 });
					// Hardware only: no security fact (the Yama setting) is ever kept in a tag.
					expect(stored).not.toHaveProperty("ptraceScope");
					unwrap(await box.destroy(context));
				});
			});

			it("returns the handle with the facts AS MEASURED when the read is definitive: no usable FUSE reads fuse false", async () => {
				await withRoot(async (root) => {
					const { sdk, box, sandbox } = await fuseBox(root);
					sandbox.probeOutput = "disk=104857600\nptrace=1\nfuse_dev=0\n";
					const attached = unwrap(await provider(sdk).attach(box.id, context));
					expect(attached?.facts().fuse).toBe(false);
					expect(sdk.running().map((each) => each.sandboxId)).toEqual([box.id]);
					await end(sdk, attached);
				});
			});

			it("retries a probe error, and a read that then works gives the fresh facts", async () => {
				await withRoot(async (root) => {
					const { sdk, box, sandbox } = await fuseBox(root);
					sandbox.probeOutput = "disk=209715200\nptrace=2\nfuse_dev=1\n";
					const tries = failProbe(sandbox, 2);
					const attached = unwrap(await provider(sdk).attach(box.id, context));
					expect(attached?.facts()).toMatchObject({ fuse: true, diskGb: 200, ptraceScope: 2 });
					expect(tries.count).toBe(3);
					await end(sdk, attached);
				});
			});

			it("returns the handle with the HARDWARE measured at create when every try errs, every security fact unknown, and the box still running", async () => {
				await withRoot(async (root) => {
					const { sdk, box, sandbox } = await fuseBox(root, {
						network: { allow: ["10.0.0.0/8"] },
						ports: [8080],
						cpus: 2,
					});
					expect(box.facts()).toMatchObject({
						network: "allowlist",
						ports: [{ port: 8080, kind: "https" }],
						ptraceScope: 1,
					});
					const tries = failProbe(sandbox, 100);
					const attached = unwrap(await provider(sdk).attach(box.id, context));
					expect(tries.count).toBe(3);
					expect(attached?.facts()).toMatchObject({ fuse: true, diskGb: 100, cpus: 2 });
					// A security fact is never taken from a tag on a read error: the Yama setting, the network and the ports are unknown.
					for (const key of ["ptraceScope", "network", "ports"]) expect(attached?.facts()).not.toHaveProperty(key);
					expect(sdk.running().map((each) => each.sandboxId)).toEqual([box.id]);
					await end(sdk, attached);
				});
			});

			it("treats a read that exits non-zero as an error: the same retry, then the create-time facts", async () => {
				await withRoot(async (root) => {
					const { sdk, box, sandbox } = await fuseBox(root);
					const exec = sandbox.exec.bind(sandbox);
					sandbox.exec = async (command, params) =>
						isProbe(command) ? exec(["sh", "-c", "echo broken >&2; exit 3"], params) : exec(command, params);
					const attached = unwrap(await provider(sdk).attach(box.id, context));
					expect(attached?.facts().fuse).toBe(true);
					await end(sdk, attached);
				});
			});

			it("is an attach ERROR, not a fail-closed guess given as measured, for a tag from before measured facts when the read errs; the box still runs", async () => {
				await withRoot(async (root) => {
					const { sdk, box, sandbox } = await fuseBox(root);
					const tags = { ...(await sandbox.getTags()) };
					delete tags[MEASURED];
					sandbox.params.tags = tags;
					const tries = failProbe(sandbox, 100);
					const attached = await provider(sdk).attach(box.id, context);
					expect(attached.ok ? "ok" : attached.error.code).toBe("unknown");
					expect(tries.count).toBe(3);
					// Nothing ended, nothing created: the caller fails this start and tries again.
					expect(sdk.running().map((each) => each.sandboxId)).toEqual([box.id]);
					expect(sdk.sandboxList).toHaveLength(1);
					sandbox.exec = Object.getPrototypeOf(sandbox).exec.bind(sandbox);
					await end(sdk, unwrap(await provider(sdk).attach(box.id, context)));
				});
			});

			it("still gives the handle, measured, for a tag from before measured facts when the read ANSWERS", async () => {
				await withRoot(async (root) => {
					const { sdk, box, sandbox } = await fuseBox(root);
					const tags = { ...(await sandbox.getTags()) };
					delete tags[MEASURED];
					sandbox.params.tags = tags;
					const attached = unwrap(await provider(sdk).attach(box.id, context));
					expect(attached?.facts()).toMatchObject({ fuse: true, diskGb: 100, ptraceScope: 1 });
					await end(sdk, attached);
				});
			});
		});

		describe("the GPU served", () => {
			const GPU_MEASURED = "pi-transport.measured";
			const isProbe = (command: string[]) => command[0] === "sh" && command[2]?.includes("ptrace_scope") === true;
			const gpuBox = async (root: string, served: string[], gpu = "H100") => {
				const sdk = new FakeModal();
				sdk.served = served;
				const box = unwrap(await provider(sdk).create({ ...SPEC, gpu, workspace: root }, context));
				const sandbox = sdk.sandboxList[0];
				if (sandbox === undefined) throw new Error("no sandbox");
				return { sdk, box, sandbox };
			};
			const failProbe = (
				sandbox: { exec: (command: string[], params: never) => Promise<unknown> },
				times: number,
			) => {
				const exec = sandbox.exec.bind(sandbox);
				let left = times;
				sandbox.exec = async (command: string[], params: never) => {
					if (isProbe(command) && left-- > 0) throw new Error("the connection went away");
					return exec(command, params);
				};
			};

			it("is the model nvidia-smi names, not the request, and the request stays in the create call", async () => {
				await withRoot(async (root) => {
					const { sdk, box } = await gpuBox(root, ["NVIDIA H200"]);
					expect(box.facts().gpu).toBe("NVIDIA H200");
					expect(sdk.sandboxList[0]?.params.gpu).toBe("H100");
					unwrap(await box.destroy(context));
				});
			});

			it("is one name for identical cards, and every model, in the order first seen and joined by ' + ' (the panel joins its label with ', '), for a mixed box", async () => {
				await withRoot(async (root) => {
					const same = await gpuBox(
						root,
						Array.from({ length: 8 }, () => "NVIDIA H100 80GB HBM3"),
						"H100!:8",
					);
					const mixed = await gpuBox(root, ["NVIDIA A100", "NVIDIA H100 80GB HBM3", "NVIDIA A100"], "any:3");
					expect([same.box.facts().gpu, mixed.box.facts().gpu]).toEqual([
						"NVIDIA H100 80GB HBM3",
						"NVIDIA A100 + NVIDIA H100 80GB HBM3",
					]);
					unwrap(await same.box.destroy(context));
					unwrap(await mixed.box.destroy(context));
				});
			});

			it("fails the create, and ends the sandbox, when a box that asked for a GPU reports none", async () => {
				await withRoot(async (root) => {
					const sdk = new FakeModal();
					const result = await provider(sdk).create({ ...SPEC, gpu: "H100", workspace: root }, context);
					expect(result.ok ? "ok" : result.error.code).toBe("unknown");
					expect(!result.ok && result.error.message).toMatch(/H100/);
					expect(sdk.running()).toEqual([]);
				});
			});

			it("is not read for a box that asked for none, and its fact stays null", async () => {
				await withRoot(async (root) => {
					const sdk = new FakeModal();
					sdk.served = ["NVIDIA H200"];
					const box = unwrap(await provider(sdk).create({ ...SPEC, workspace: root }, context));
					expect(box.facts().gpu).toBeNull();
					const probe = sdk.sandboxList[0]?.execs.find((e) => isProbe(e.command));
					expect(probe?.command[6]).toBe("-");
					unwrap(await box.destroy(context));
				});
			});

			it("stores the model measured at create in the box's tag, beside the other hardware facts", async () => {
				await withRoot(async (root) => {
					const { box, sandbox } = await gpuBox(root, ["NVIDIA H200"]);
					const stored = JSON.parse((await sandbox.getTags())[GPU_MEASURED] ?? "null") as Record<string, unknown>;
					expect(stored).toMatchObject({ gpu: "NVIDIA H200", fuse: false });
					unwrap(await box.destroy(context));
				});
			});

			it("attach reads it again: a definitive answer is the model, or null when none is named, and the box keeps running", async () => {
				await withRoot(async (root) => {
					const { sdk, box, sandbox } = await gpuBox(root, ["NVIDIA H200"]);
					sandbox.served = ["NVIDIA H100 80GB HBM3"];
					const fresh = unwrap(await provider(sdk).attach(box.id, context));
					expect(fresh?.facts().gpu).toBe("NVIDIA H100 80GB HBM3");
					sandbox.served = [];
					const none = unwrap(await provider(sdk).attach(box.id, context));
					expect(none?.facts().gpu).toBeNull();
					expect(sdk.running().map((each) => each.sandboxId)).toEqual([box.id]);
					// The caller sees the mismatch and ends the box through the handle.
					unwrap(await (none as NonNullable<typeof none>).destroy(context));
					expect(sdk.running()).toEqual([]);
				});
			});

			it("attach keeps the model measured at create when every try errs, and no security fact", async () => {
				await withRoot(async (root) => {
					const { sdk, box, sandbox } = await gpuBox(root, ["NVIDIA H200"]);
					failProbe(sandbox, 100);
					const attached = unwrap(await provider(sdk).attach(box.id, context));
					expect(attached?.facts().gpu).toBe("NVIDIA H200");
					for (const key of ["ptraceScope", "network", "ports"]) expect(attached?.facts()).not.toHaveProperty(key);
					expect(sdk.running().map((each) => each.sandboxId)).toEqual([box.id]);
					unwrap(await (attached as NonNullable<typeof attached>).destroy(context));
					expect(sdk.running()).toEqual([]);
				});
			});

			it("attach of a GPU box whose tag holds no measured model is an ERROR when the read errs (never the request given as the model), and the box runs on", async () => {
				await withRoot(async (root) => {
					const { sdk, box, sandbox } = await gpuBox(root, ["NVIDIA H200"]);
					// A tag from before the model was kept: the other hardware facts are there, the model is not.
					const tags = { ...(await sandbox.getTags()) };
					const kept = JSON.parse(tags[GPU_MEASURED] ?? "{}") as Record<string, unknown>;
					delete kept.gpu;
					tags[GPU_MEASURED] = JSON.stringify(kept);
					sandbox.params.tags = tags;
					failProbe(sandbox, 100);
					const attached = await provider(sdk).attach(box.id, context);
					expect(attached.ok ? "ok" : attached.error.code).toBe("unknown");
					expect(sdk.running().map((each) => each.sandboxId)).toEqual([box.id]);
					expect(sdk.sandboxList).toHaveLength(1);
				});
			});
		});

		it("refuses fuse with gvisor (unsupported) and with a GPU (invalid), and any other capability, before any Modal call", async () => {
			const sdk = new FakeModal();
			const codes = [];
			for (const spec of [
				{ capabilities: ["fuse" as const], isolation: "gvisor" as const },
				{ capabilities: ["fuse" as const], gpu: "T4" },
				{ capabilities: ["ptrace" as never] },
			]) {
				const result = await provider(sdk).create({ ...SPEC, ...spec }, context);
				codes.push(result.ok ? "ok" : result.error.code);
			}
			expect(codes).toEqual(["unsupported", "invalid", "unsupported"]);
			expect(sdk.sandboxList).toEqual([]);
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

	it("returns a cancellation during the box's own probe, for attach and for create, though no FUSE was asked for", async () => {
		await withRoot(async (root) => {
			const sdk = new FakeModal();
			const provider = modalBoxes(sdk, { appName: "a" });
			const made = unwrap(await provider.create({ ...SPEC, workspace: root }, context));
			const cancelDuringProbe = (sandbox: (typeof sdk.sandboxList)[number], cancel: () => void) => {
				const exec = sandbox.exec.bind(sandbox);
				sandbox.exec = async (command, params) => {
					if (command[0] === "sh" && command[2]?.includes("ptrace_scope")) cancel();
					return exec(command, params);
				};
			};
			const cancelAttach = withCancel(context);
			cancelDuringProbe(sdk.sandboxList[0] as (typeof sdk.sandboxList)[number], () => cancelAttach.cancel());
			const attached = await provider.attach(made.id, cancelAttach.context);
			expect(attached.ok ? "ok" : attached.error.code).toBe("aborted");

			// The probe throws after the caller cancelled: still an abort, not a box that read nothing.
			const cancelThrown = withCancel(context);
			const sandbox = sdk.sandboxList[0] as (typeof sdk.sandboxList)[number];
			const exec = sandbox.exec.bind(sandbox);
			sandbox.exec = async (command, params) => {
				if (command[0] === "sh" && command[2]?.includes("ptrace_scope")) {
					cancelThrown.cancel();
					throw new Error("the connection went away");
				}
				return exec(command, params);
			};
			const thrown = await provider.attach(made.id, cancelThrown.context);
			expect(thrown.ok ? "ok" : thrown.error.code).toBe("aborted");

			const cancelCreate = withCancel(context);
			const create = sdk.sandboxes.create;
			sdk.sandboxes.create = async (app, image, params) => {
				const sandbox = await create(app, image, params);
				cancelDuringProbe(sandbox as (typeof sdk.sandboxList)[number], () => cancelCreate.cancel());
				return sandbox;
			};
			const created = await provider.create({ ...SPEC, workspace: root }, cancelCreate.context);
			expect(created.ok ? "ok" : created.error.code).toBe("aborted");
			expect(sdk.running().map((s) => s.sandboxId)).toEqual([made.id]);
			unwrap(await made.destroy(context));
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
