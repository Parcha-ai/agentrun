// GPU: a computer asked for with a GPU the provider declares has it, as the vendor reports it (attach's read-back) and
// as its programs see it from inside (nvidia-smi, as the computer's user). The run names the GPU it pays for (t.gpu()):
// a GPU bills by the second, so each case makes one computer and keeps it no longer than it takes to look.
//
// gpu.present makes a GPU computer alone. It needs exec but does not name it among its needs: the runner checks a group
// need on the run's shared computer, which it would make for this case alone, a second computer billed for nothing. The
// provider's declared groups and its own GPU computer's hello hold it to exec instead. It also records, as evidence and
// nothing more, what the computer's user sees of FUSE, which an Archil mount needs: nothing is mounted.
//
// gpu.archil makes ONE computer with both the GPU and the run's Archil folder, where the provider's GPU computers take an
// Archil mount (capabilities().gpu.mounts lists it, or names none): the folder reads at /workspace, a program's write
// there is on the disk once the computer is released, and the GPUs are seen from inside. Everything is collected before
// the GPU verdict, so a computer whose image lacks the GPU's tools still shows whether the mount held.
import { randomBytes } from "node:crypto";
import { readBackOf, WORKSPACE } from "../../mount.js";
import type { ComputerClient } from "../../protocol.js";
import type { GpuSpec } from "../../provider.js";
import type { Case, CaseContext } from "../types.js";
import { mounted } from "./mount.js";
import { CASE_LABEL } from "./util.js";

/** An AMD type: its programs see it through ROCm, not nvidia-smi, so the count from inside is recorded, not asserted. */
const AMD = /^MI\d/;

/** What the computer's user sees of FUSE, with nothing mounted: the device, the kernel's filesystems, whether the device
 *  opens, and the kernel (gVisor's says so). */
const FUSE_PROBE =
	'ls -l /dev/fuse 2>&1; grep -w fuse /proc/filesystems 2>&1 || echo "fuse: not in /proc/filesystems"; if (exec 3<>/dev/fuse) 2>/dev/null; then echo "/dev/fuse: opens read-write"; else echo "/dev/fuse: does not open"; fi; echo "kernel $(uname -r)"';

/** The GPUs the computer's user sees, recorded; and the verdict on them, for the case to give once it has looked at the
 *  rest (none for an AMD type, whose count is recorded only). */
async function lookAtGpus(t: CaseContext, gpu: GpuSpec, client: ComputerClient): Promise<() => void> {
	if (AMD.test(gpu.type)) {
		const seen = await t.exec(["sh", "-c", "rocm-smi --showproductname 2>&1; true"], {}, client);
		t.observe(`the GPUs the computer's user sees (rocm-smi): ${seen.out.trim().slice(0, 600) || "nothing"}`);
		return () => {};
	}
	// nvidia-smi -L: one "GPU <n>: <name> (UUID: ...)" line per GPU the computer's programs can use.
	const seen = await t.exec(["sh", "-c", "nvidia-smi -L"], {}, client);
	t.observe(`the GPUs the computer's user sees (nvidia-smi -L): ${(seen.out.trim() || seen.err.trim()).slice(0, 600) || "nothing"}`);
	return () => {
		t.equal(seen.exitCode, 0, `nvidia-smi -L as the computer's user: a GPU computer's image carries the driver's tools, and its user reaches the GPU (stderr: ${seen.err.trim().slice(0, 300)})`);
		const listed = seen.out.split("\n").filter((line) => /^GPU \d+: /.test(line.trim()));
		t.equal(listed.length, gpu.count, "the GPUs nvidia-smi lists, as the computer's user");
	};
}

/** Records what the computer's user sees of FUSE; never fails the case. */
async function lookAtFuse(t: CaseContext, client: ComputerClient): Promise<void> {
	const seen = await t.exec(["sh", "-c", FUSE_PROBE], {}, client);
	t.observe(`FUSE as the computer's user sees it, nothing mounted (an Archil mount needs it): ${(seen.out.trim() || seen.err.trim()).replace(/\n/g, " | ").slice(0, 600) || "nothing"}`);
}

export const gpuCases: Case[] = [
	{
		id: "gpu.present",
		level: "full",
		group: "gpu",
		needs: ["gpu"],
		computer: "none",
		timeoutMs: 600_000,
		async run(t) {
			const gpu = t.gpu();
			t.assert(t.provider.capabilities().groups.includes("exec"), "the provider declares exec: nvidia-smi runs as the computer's user");
			const labels = { ...t.runLabels, [CASE_LABEL]: "gpu" };
			t.deepEqual(t.provider.check(t.spec({ labels, gpu })), [], `check of a spec with gpu ${JSON.stringify(gpu)}`);
			const ref = await t.create({ labels, gpu });
			const attached = t.ok(await t.provider.attach({ id: ref.id }, { signal: t.signal }), "attach by id");
			t.deepEqual(attached.spec.gpu, gpu, "the GPUs attach reads back: the vendor's report, or what create recorded where the vendor reports none");
			const connected = await t.connect(ref);
			t.assert(connected.hello.groups.includes("exec"), "the GPU computer's hello declares exec");
			const verdict = await lookAtGpus(t, gpu, connected.client);
			await lookAtFuse(t, connected.client);
			await connected.close();
			t.ok(await t.provider.release(ref, "delete"), "release delete, at once: a GPU bills by the second");
			verdict();
		},
	},
	{
		id: "gpu.archil",
		level: "full",
		group: "gpu",
		needs: ["gpu", "mount:archil"],
		computer: "none",
		timeoutMs: 900_000,
		async run(t) {
			const gpu = t.gpu();
			const offered = t.provider.capabilities();
			t.assert(offered.groups.includes("exec"), "the provider declares exec: nvidia-smi and the program's write run as the computer's user");
			if (offered.gpu?.mounts !== undefined && !offered.gpu.mounts.includes("archil")) {
				t.skip("the provider's GPU computers take no archil mount (capabilities().gpu.mounts): check() refuses one, as provider.check-refuses holds");
			}
			const folder = await t.runFolder("archil");
			const nonce = randomBytes(6).toString("hex");
			const before = `gpu-before-${nonce}.txt`;
			const beforeText = `written outside before the GPU computer ${nonce}\n`;
			await folder.write(before, Buffer.from(beforeText));
			// check() takes it, create makes it, and attach and list read the mount back as asked, with no token (mount.ts).
			const { ref } = await mounted(t, folder, 1, "gpu-archil", { gpu });
			const attached = t.ok(await t.provider.attach({ id: ref.id }, { signal: t.signal }), "attach by id");
			t.deepEqual(attached.spec.gpu, gpu, "the GPUs attach reads back, beside the mount");
			t.deepEqual(attached.spec.mount, readBackOf(folder.mount, 1), "the mount attach reads back, beside the GPUs");
			const connected = await t.connect(ref);
			t.assert(connected.hello.groups.includes("exec"), "the GPU computer's hello declares exec");
			const read = await t.exec(["cat", before], { cwd: WORKSPACE }, connected.client);
			t.equal(read.out, beforeText, `cat ${before} at ${WORKSPACE}, a file written outside before the computer (${read.err.trim()})`);
			const wrote = await t.exec(["sh", "-c", 'printf "%s\\n" "$1" >> "$2"', "sh", nonce, `${WORKSPACE}/gpu-${nonce}.txt`], {}, connected.client);
			t.equal(wrote.exitCode, 0, `a program's write at ${WORKSPACE}: its exit code (${wrote.err.trim()})`);
			const verdict = await lookAtGpus(t, gpu, connected.client);
			await connected.close();
			t.ok(await t.provider.release(ref, "delete"), "release delete, at once: a GPU bills by the second");
			const back = await folder.read(`gpu-${nonce}.txt`);
			t.equal(back === undefined ? undefined : Buffer.from(back).toString("utf8"), `${nonce}\n`, `gpu-${nonce}.txt, written by a program in the GPU computer, read outside once it is released`);
			verdict();
		},
	},
];
