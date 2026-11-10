// GPU: a computer asked for with a GPU the provider declares has it, as the vendor reports it (attach's read-back) and
// as its programs see it from inside (nvidia-smi, as the computer's user). The run names the GPU it pays for (t.gpu()):
// a GPU bills by the second, so this case makes one computer and keeps it no longer than it takes to look.
import type { Case } from "../types.js";
import { CASE_LABEL } from "./util.js";

/** An AMD type: its programs see it through ROCm, not nvidia-smi, so the count from inside is recorded, not asserted. */
const AMD = /^MI\d/;

export const gpuCases: Case[] = [
	{
		id: "gpu.present",
		level: "full",
		group: "gpu",
		needs: ["gpu", "exec"],
		computer: "none",
		timeoutMs: 600_000,
		async run(t) {
			const gpu = t.gpu();
			const labels = { ...t.runLabels, [CASE_LABEL]: "gpu" };
			t.deepEqual(t.provider.check(t.spec({ labels, gpu })), [], `check of a spec with gpu ${JSON.stringify(gpu)}`);
			const ref = await t.create({ labels, gpu });
			const attached = t.ok(await t.provider.attach({ id: ref.id }, { signal: t.signal }), "attach by id");
			t.deepEqual(attached.spec.gpu, gpu, "the GPUs attach reads back: the vendor's report, or what create recorded where the vendor reports none");
			const connected = await t.connect(ref);
			if (AMD.test(gpu.type)) {
				const seen = await t.exec(["sh", "-c", "rocm-smi --showproductname 2>&1; true"], {}, connected.client);
				t.observe(`the GPUs the computer's user sees (rocm-smi): ${seen.out.trim().slice(0, 600) || "nothing"}`);
			} else {
				// nvidia-smi -L: one "GPU <n>: <name> (UUID: ...)" line per GPU the computer's programs can use.
				const seen = await t.exec(["sh", "-c", "nvidia-smi -L"], {}, connected.client);
				t.observe(`the GPUs the computer's user sees (nvidia-smi -L): ${(seen.out.trim() || seen.err.trim()).slice(0, 600) || "nothing"}`);
				t.equal(seen.exitCode, 0, `nvidia-smi -L as the computer's user: a GPU computer's image carries the driver's tools, and its user reaches the GPU (stderr: ${seen.err.trim().slice(0, 300)})`);
				const listed = seen.out.split("\n").filter((line) => /^GPU \d+: /.test(line.trim()));
				t.equal(listed.length, gpu.count, "the GPUs nvidia-smi lists, as the computer's user");
			}
			await connected.close();
			t.ok(await t.provider.release(ref, "delete"), "release delete, at once: a GPU bills by the second");
		},
	},
];
