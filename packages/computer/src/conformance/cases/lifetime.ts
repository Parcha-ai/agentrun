// Lifetime: extend moves a computer's deadline, so it outlives the lifetime it was made with, with what ran in it still
// running; past the cap it is refused with the deadline unchanged.
import type { Case } from "../types.js";
import { CASE_LABEL, delay } from "./util.js";

/** A deadline read back may be a second off the one extend returned: a label or a vendor timer can round. */
const SLACK_MS = 1000;

export const lifetimeCases: Case[] = [
	{
		id: "lifetime.extend",
		level: "full",
		group: "lifetime",
		needs: ["extend"],
		computer: "none",
		timeoutMs: 300_000,
		async run(t) {
			const extend = t.provider.extend;
			if (extend === undefined) return t.skip("the provider has no extend()");
			const { maxLifetimeMs, groups } = t.provider.capabilities();
			const labels = { ...t.runLabels, [CASE_LABEL]: "extend" };
			const ref = await t.create({ lifetimeMs: 45_000, labels });
			const created = Date.now();
			const first = await t.connect(ref);
			const started = groups.includes("processes") ? t.ok(await first.client.call("process.start", { argv: ["sleep", "600"] }), "process.start") : undefined;
			await first.close();
			const deadlineOf = async () => {
				const listed = t.ok(await t.provider.list(labels), "list");
				t.equal(listed.length, 1, "computers with the case's labels");
				return t.present(listed[0]?.deadline, "the listed computer's deadline").getTime();
			};

			const asked = Date.now();
			const extended = t.ok(await extend.call(t.provider, ref, 120_000, { signal: t.signal }), "extend to 120 s");
			const answered = Date.now();
			const deadline = extended.deadline instanceof Date ? extended.deadline.getTime() : Number.NaN;
			t.assert(deadline >= asked + 120_000 - SLACK_MS && deadline <= answered + 120_000 + SLACK_MS, `extend to 120 s returned the deadline ${String(extended.deadline)}`);
			const listed = await deadlineOf();
			t.assert(Math.abs(listed - deadline) <= SLACK_MS, `list() shows the deadline ${new Date(listed).toISOString()}, not the extended ${new Date(deadline).toISOString()}`);

			const past = await extend.call(t.provider, ref, maxLifetimeMs + 1, { signal: t.signal });
			const error = t.refused(past, `extend past maxLifetimeMs (${maxLifetimeMs + 1} ms)`);
			t.assert(error.message !== "", "the refusal is in words");
			t.equal(await deadlineOf(), listed, "the deadline list() shows after the refused extend");

			// Past the lifetime it was made with, the computer and what ran in it are still there.
			await delay(Math.max(0, created + 60_000 - Date.now()));
			const again = await t.connect(ref);
			t.deepEqual(t.ok(await again.client.call("ping", {}), "ping"), {}, "ping 60 s after a create with 45 s");
			if (started !== undefined) {
				const exit = t.ok(await again.client.call("process.wait", { id: started.id, timeoutMs: 0 }), "process.wait");
				t.equal(exit.running, true, "the process started before the extend, 60 s after create: running");
			}
			t.assert(Math.abs((await deadlineOf()) - deadline) <= SLACK_MS, "list() shows the extended deadline 60 s after create");
		},
	},
];
