// Lifetime: extend moves a computer's deadline, so it outlives the lifetime it was made with, with what ran in it still
// running. An extend that would move the deadline earlier, past maxLifetimeMs, or past create + maxLifetimeMs is refused
// in words, with the deadline unchanged. A computer left quiet past a vendor's idle timer is still running, its daemon
// answering (a long case: --long).
import type { Case } from "../types.js";
import { CASE_LABEL } from "./util.js";

/** How long lifetime.idle leaves its computer quiet: past the shortest vendor idle timer known (Alibaba's 5 min). */
const IDLE_MS = 6 * 60_000;
/** Its computer's lifetime: the quiet, and four minutes to make it, connect and read it. */
const IDLE_LIFETIME_MS = IDLE_MS + 4 * 60_000;

/** A deadline read back may be a second off the one extend returned: a label or a vendor timer can round. */
const SLACK_MS = 1000;
/** How far short of the cap the last extend asks, at least 60 s after create: it lands at least 30 s past create + cap. */
const UNDER_CAP_MS = 30_000;

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
			// 120 s, then the cap less 30 s once 60 s have passed: under 3 min, the second is no longer past the first.
			if (!(maxLifetimeMs >= 180_000)) return t.skip(`lifetime.extend needs a maxLifetimeMs of 3 min or more, not ${maxLifetimeMs} ms`);
			const labels = { ...t.runLabels, [CASE_LABEL]: "extend" };
			const ref = await t.create({ lifetimeMs: 45_000, labels });
			const created = t.clock.now();
			const first = await t.connect(ref);
			const started = groups.includes("processes") ? t.ok(await first.client.call("process.start", { argv: ["sleep", "600"] }), "process.start") : undefined;
			await first.close();
			const deadlineOf = async () => {
				const listed = t.ok(await t.provider.list(labels), "list");
				t.equal(listed.length, 1, "computers with the case's labels");
				return t.present(listed[0]?.deadline, "the listed computer's deadline").getTime();
			};

			const asked = t.clock.now();
			const extended = t.ok(await extend.call(t.provider, ref, 120_000, { signal: t.signal }), "extend to 120 s");
			const answered = t.clock.now();
			const deadline = extended.deadline instanceof Date ? extended.deadline.getTime() : Number.NaN;
			t.assert(deadline >= asked + 120_000 - SLACK_MS && deadline <= answered + 120_000 + SLACK_MS, `extend to 120 s returned the deadline ${String(extended.deadline)}`);
			const listed = await deadlineOf();
			t.assert(Math.abs(listed - deadline) <= SLACK_MS, `list() shows the deadline ${new Date(listed).toISOString()}, not the extended ${new Date(deadline).toISOString()}`);
			/** Asks for ttlMs, which must be refused in words, and checks the deadline list() shows did not move. */
			const refused = async (ttlMs: number, what: string) => {
				const error = t.refused(await extend.call(t.provider, ref, ttlMs, { signal: t.signal }), what);
				t.assert(error.message !== "", `${what}: the refusal is in words`);
				t.equal(await deadlineOf(), listed, `the deadline list() shows after the refused ${what}`);
			};

			// An extend never moves the deadline earlier: 60 s from now is before the 120 s just set.
			await refused(60_000, "extend to 60 s, earlier than the current deadline");
			await refused(maxLifetimeMs + 1, `extend past maxLifetimeMs (${maxLifetimeMs + 1} ms)`);

			// Past the lifetime it was made with, the computer and what ran in it are still there.
			await t.clock.sleep(Math.max(0, created + 60_000 - t.clock.now()));
			const again = await t.connect(ref);
			t.deepEqual(t.ok(await again.client.call("ping", {}), "ping"), {}, "ping 60 s after a create with 45 s");
			if (started !== undefined) {
				const exit = t.ok(await again.client.call("process.wait", { id: started.id, timeoutMs: 0 }), "process.wait");
				t.equal(exit.running, true, "the process started before the extend, 60 s after create: running");
			}
			t.assert(Math.abs((await deadlineOf()) - deadline) <= SLACK_MS, "list() shows the extended deadline 60 s after create");

			// The cap counts from create: at least 60 s after it (the provider's create was earlier still), the cap less 30 s
			// from now is at least 30 s past create + maxLifetimeMs, though within maxLifetimeMs on its own.
			const underCap = maxLifetimeMs - UNDER_CAP_MS;
			await refused(underCap, `extend to ${underCap / 1000} s, past create + maxLifetimeMs (${maxLifetimeMs} ms)`);
		},
	},
	{
		id: "lifetime.idle",
		level: "full",
		group: "lifetime",
		needs: [],
		computer: "none",
		timeoutMs: IDLE_LIFETIME_MS + 60_000,
		async run(t) {
			const minutes = IDLE_MS / 60_000;
			t.long(`it leaves a computer quiet ${minutes} min`);
			const { maxLifetimeMs } = t.provider.capabilities();
			if (!(maxLifetimeMs >= IDLE_LIFETIME_MS)) return t.skip(`lifetime.idle needs a maxLifetimeMs of ${IDLE_LIFETIME_MS / 60_000} min or more, not ${maxLifetimeMs} ms`);
			const labels = { ...t.runLabels, [CASE_LABEL]: "idle" };
			const ref = await t.create({ lifetimeMs: IDLE_LIFETIME_MS, labels });
			const first = await t.connect(ref);
			t.deepEqual(t.ok(await first.client.call("ping", {}), "ping"), {}, "ping after create");
			await first.close();
			// No call and no connection: a vendor's idle timer (Alibaba's 5 min, Azure's, Cloudflare's inactivity) would end it.
			await t.clock.sleep(IDLE_MS);
			const quiet = `after ${minutes} min with no call, well inside its lifetime`;
			t.deepEqual(
				t.ok(await t.provider.list(labels), "list").map((info) => [info.ref.name, info.state]),
				[[ref.name, "running"]],
				`${quiet}: still listed, running (a vendor's idle timer ends a quiet computer under the run: turn it off, or keep the computer busy)`,
			);
			const back = await t.connect(ref);
			t.deepEqual(t.ok(await back.client.call("ping", {}), "ping"), {}, `${quiet}: its daemon answers ping`);
		},
	},
];
