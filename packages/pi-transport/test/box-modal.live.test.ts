import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { BoxSpec } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { type ModalSdk, modalBoxes } from "../src/box/modal.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
process.env[CANARY] = "the host's environment reached a box";
// Names every Modal app and label this suite makes. A host that shares an account sets its own prefix and labels:
// PI_TRANSPORT_LIVE_PREFIX, and PI_TRANSPORT_LIVE_LABELS as `key=value,key=value`.
const PREFIX = process.env.PI_TRANSPORT_LIVE_PREFIX ?? "pi-transport-live-";
const LABELS: Record<string, string> = {
	"pi-transport": "1",
	...Object.fromEntries(
		(process.env.PI_TRANSPORT_LIVE_LABELS ?? "")
			.split(",")
			.filter((pair) => pair.includes("="))
			.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
	),
};
const APP_NAME = `${PREFIX}conformance`;
const MAX_LIFETIME_MS = 20 * 60_000;
const CASE_TIMEOUT_MS = 600_000;
const SHORT_LIFETIME_MS = Number(process.env.PI_TRANSPORT_LIVE_SHORT_LIFETIME_MS ?? 10_000);
const SHORT_GRACE_MS = 180_000;
const MODAL_VERSION = "0.11.0";

// The Modal SDK is not a dependency of this package: the suite loads it only when asked to run.
async function loadClient(): Promise<ModalSdk> {
	const specifier = "modal";
	try {
		const sdk = (await import(specifier)) as { ModalClient: new () => ModalSdk };
		return new sdk.ModalClient();
	} catch (cause) {
		throw new Error(
			`the live Modal suite needs the Modal SDK: run \`npm install --no-save modal@${MODAL_VERSION}\` (${String(cause)})`,
		);
	}
}

type Kind = { readonly name: string; readonly isolation?: BoxSpec["isolation"]; readonly gpu?: string };
const KINDS: readonly Kind[] = [{ name: "sandbox" }, { name: "vm", isolation: "vm" }, { name: "gpu", gpu: "T4" }];

// Needs Modal credentials in the environment (MODAL_TOKEN_ID, MODAL_TOKEN_SECRET) and spends money, so it runs only
// when asked: `npm run test:live:modal`. PI_TRANSPORT_LIVE_MODAL_KINDS picks kinds; the GPU kind is never a default.
if (process.env.PI_TRANSPORT_LIVE_MODAL === "1") {
	vi.setConfig({ testTimeout: CASE_TIMEOUT_MS, hookTimeout: CASE_TIMEOUT_MS });
	const wanted = (process.env.PI_TRANSPORT_LIVE_MODAL_KINDS ?? "sandbox,vm").split(",");
	const client = await loadClient();
	for (const kind of KINDS.filter((candidate) => wanted.includes(candidate.name))) {
		const provider = modalBoxes(client, { appName: APP_NAME });
		describe(`modal ${kind.name} boxes`, () => {
			registerBoxConformance({ describe, expect, it }, `modal ${kind.name} boxes`, (use) => use(provider), {
				absentEnv: [CANARY],
				lifetime: { maxLifetimeMs: SHORT_LIFETIME_MS, graceMs: SHORT_GRACE_MS },
				spec: {
					cpus: 2,
					maxLifetimeMs: MAX_LIFETIME_MS,
					labels: LABELS,
					...(kind.gpu === undefined ? {} : { gpu: kind.gpu }),
				},
			});

			it("reports the isolation of its kind", async () => {
				const created = await provider.create(
					{
						cpus: 2,
						maxLifetimeMs: MAX_LIFETIME_MS,
						labels: LABELS,
						...(kind.gpu === undefined ? {} : { gpu: kind.gpu }),
					},
					BACKGROUND_CONTEXT,
				);
				if (!created.ok) throw created.error;
				const box = created.value;
				try {
					expect(box.facts().isolation).toBe(kind.isolation ?? "gvisor");
					if (kind.gpu !== undefined) {
						const started = await box.exec(["nvidia-smi", "-L"], { timeoutMs: 60_000 }, BACKGROUND_CONTEXT);
						if (!started.ok) throw started.error;
						const finished = await finish(started.value);
						if (!finished.ok) throw finished.error;
						expect(new TextDecoder().decode(finished.value.stdout)).toContain(kind.gpu);
					}
				} finally {
					await box.destroy(BACKGROUND_CONTEXT);
				}
			});

			it("measures the time from create to gone for a box nobody ends", async () => {
				const started = Date.now();
				const created = await provider.create(
					{
						cpus: 2,
						maxLifetimeMs: SHORT_LIFETIME_MS,
						labels: LABELS,
						...(kind.gpu === undefined ? {} : { gpu: kind.gpu }),
					},
					BACKGROUND_CONTEXT,
				);
				if (!created.ok) throw created.error;
				const createdMs = Date.now() - started;
				let goneMs: number | undefined;
				try {
					while (Date.now() - started < SHORT_LIFETIME_MS + SHORT_GRACE_MS) {
						await new Promise((resolve) => setTimeout(resolve, 1000));
						const found = await provider.attach(created.value.id, BACKGROUND_CONTEXT);
						if (found.ok && found.value === undefined) {
							goneMs = Date.now() - started;
							break;
						}
					}
				} finally {
					await created.value.destroy(BACKGROUND_CONTEXT);
				}
				console.log(
					`modal ${kind.name}: lifetime ${SHORT_LIFETIME_MS} ms, create returned at ${createdMs} ms, gone at ${goneMs ?? "never"} ms`,
				);
				expect(goneMs).toBeDefined();
			});

			afterAll(async () => {
				// Whatever a failed case left: find it by label, end it, and say how many there were.
				const left = await provider.list(LABELS, BACKGROUND_CONTEXT);
				const refs = left.ok ? left.value : [];
				for (const ref of refs) {
					const box = await provider.attach(ref.id, BACKGROUND_CONTEXT);
					if (box.ok) await box.value?.destroy(BACKGROUND_CONTEXT);
				}
				const after = await provider.list(LABELS, BACKGROUND_CONTEXT);
				console.log(
					`modal ${kind.name}: boxes left before sweep ${refs.length}, after ${after.ok ? after.value.length : "?"}`,
				);
			});
		});
	}
} else {
	describe.skip("modal boxes (set PI_TRANSPORT_LIVE_MODAL=1)", () => {
		it("runs the box conformance suite on Modal", () => {});
	});
}
