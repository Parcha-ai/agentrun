import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModalClient } from "modal";
import { afterAll, describe, expect, it, vi } from "vitest";
import { finish } from "../src/box/files.ts";
import { type ModalBoxesOptions, modalBoxes } from "../src/box/modal.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
process.env[CANARY] = "the host's environment reached a box";
const LABELS = { "pi-transport": "1", lane: "h5" };
const APP_NAME = "pt-h5-conformance";
const MAX_LIFETIME_MS = 20 * 60_000;
const CASE_TIMEOUT_MS = 600_000;

type Kind = { readonly name: string; readonly options: Partial<ModalBoxesOptions>; readonly gpu?: string };
const KINDS: readonly Kind[] = [
	{ name: "sandbox", options: {} },
	{ name: "vm", options: { runtime: "vm" } },
	{ name: "gpu", options: {}, gpu: "T4" },
];

// Needs Modal credentials in the environment (MODAL_TOKEN_ID, MODAL_TOKEN_SECRET) and spends money, so it runs only
// when asked: `npm run test:live:modal`. PI_TRANSPORT_LIVE_MODAL_KINDS picks kinds; the GPU kind is never a default.
if (process.env.PI_TRANSPORT_LIVE_MODAL === "1") {
	vi.setConfig({ testTimeout: CASE_TIMEOUT_MS, hookTimeout: CASE_TIMEOUT_MS });
	const wanted = (process.env.PI_TRANSPORT_LIVE_MODAL_KINDS ?? "sandbox,vm").split(",");
	const client = new ModalClient();
	for (const kind of KINDS.filter((candidate) => wanted.includes(candidate.name))) {
		const provider = modalBoxes(client, { appName: APP_NAME, ...kind.options });
		describe(`modal ${kind.name} boxes`, () => {
			registerBoxConformance({ describe, expect, it }, `modal ${kind.name} boxes`, (use) => use(provider), {
				absentEnv: [CANARY],
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
					expect(box.facts().isolation).toBe(kind.options.runtime ?? "gvisor");
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
