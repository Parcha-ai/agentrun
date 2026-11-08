// The provider: check refuses in words and makes nothing (past maxLifetimeMs too), create, attach, list and release do
// what they say, the network reads back as asked, a change to a network the provider does not declare is refused
// (Core) and one it does declare is refused or applied truthfully (Full), a computer does not run past its deadline,
// the janitor ends only the expired, stopped or running, and a takeover releases the run's lower epochs by label (Full).
import { randomBytes } from "node:crypto";
import { releaseOlder, sweep } from "../../janitor.js";
import { EPOCH_LABEL, RUN_LABEL, runLabels } from "../../labels.js";
import type { ComputerRef, ComputerSpec, NetworkSpec } from "../../provider.js";
import type { Case, CaseContext } from "../types.js";
import { CASE_LABEL, delay } from "./util.js";

/** Labels for one case's computers: the run's, and the case's own. */
const own = (t: CaseContext, name: string) => ({ ...t.runLabels, [CASE_LABEL]: name });
const names = async (t: CaseContext, labels: Record<string, string>) =>
	t
		.ok(await t.provider.list(labels), `list ${JSON.stringify(labels)}`)
		.map((info) => info.ref.name)
		.sort();
/** A computer as the cases compare it: its id and name alone, so what else create or attach returns (notes) is not compared. */
const refOf = ({ id, name }: ComputerRef): ComputerRef => ({ id, name });
const byName = (a: ComputerRef, b: ComputerRef) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const kindOf = (policy: NetworkSpec) => (typeof policy === "string" ? policy : "allow");
const POLICIES: NetworkSpec[] = ["none", "open", { allow: ["example.com"] }];

/**
 * Asserts create refuses spec for what check() refuses in it: the refusal carries check()'s own words, so a create
 * refused for another reason (no capacity, a network mismatch) does not pass. A computer create makes anyway, even
 * after the case ended, is deleted by the runner.
 */
async function refusedCreate(t: CaseContext, spec: ComputerSpec, what: string) {
	const checked = t.provider.check(spec);
	t.assert(checked.length > 0, `${what}: check() refuses it`);
	const error = t.refused(await t.attempt(spec), what, ["refused"]);
	t.assert(
		checked.some(({ message }) => error.message.includes(message)),
		`${what}: create's refusal names what check() refused (${checked.map(({ field, message }) => `${field}: ${message}`).join("; ")}), not: ${error.message}`,
	);
}

const provider = (name: string, run: Case["run"], extra: Partial<Case> = {}): Case => ({
	id: `provider.${name}`,
	level: "core",
	group: "provider",
	needs: [],
	computer: "none",
	run,
	...extra,
});

/**
 * A Full case for one wider policy the provider declares: on a computer of its own (never the run's shared one), a
 * change from none to it and back to none is refused in words with the network unchanged, or applied, returned and
 * read back as asked.
 */
const switchCase = (name: string, wider: NetworkSpec): Case =>
	provider(
		name,
		async (t) => {
			const ref = await t.create({ labels: own(t, name) });
			for (const policy of [wider, "none" as const]) {
				const was = t.ok(await t.provider.network(ref), "network read-back");
				const changed = await t.provider.network(ref, policy);
				const words = `a change from network ${JSON.stringify(was)} to ${JSON.stringify(policy)}`;
				if (changed.ok) {
					t.deepEqual(changed.value, policy, `${words}: what it returns`);
					t.deepEqual(t.ok(await t.provider.network(ref), "network read-back"), policy, `${words}: the network read back after it`);
				} else {
					const error = t.refused(changed, words, ["refused"]);
					t.assert(error.message !== "", `${words}: the refusal is in words`);
					t.deepEqual(t.ok(await t.provider.network(ref), "network read-back"), was, `${words}, refused: the network read back after it`);
				}
			}
		},
		{ level: "full", needs: [`network:${kindOf(wider)}`] },
	);

export const providerCases: Case[] = [
	provider("check-refuses", async (t) => {
		t.deepEqual(t.provider.check(t.spec()), [], "check of the run's own spec");
		const labels = own(t, "check");
		const { lifetimeMs: _, ...withoutLifetime } = t.spec({ labels });
		for (const [what, spec] of [
			["no lifetime", withoutLifetime],
			["lifetime 0", t.spec({ labels, lifetimeMs: 0 })],
		] as const) {
			const refusals = t.provider.check(spec as never);
			t.assert(
				refusals.some((r) => r.field === "lifetimeMs" && r.message !== ""),
				`check of a spec with ${what} refuses lifetimeMs in words: ${JSON.stringify(refusals)}`,
			);
			await refusedCreate(t, spec as ComputerSpec, `create of a spec with ${what}`);
		}
		for (const policy of POLICIES.filter((p) => !t.provider.capabilities().network.includes(kindOf(p)))) {
			const refusals = t.provider.check(t.spec({ labels, network: policy }));
			t.assert(refusals.some((r) => r.field === "network" && r.message !== ""), `check refuses network ${kindOf(policy)}, which the provider does not declare`);
			await refusedCreate(t, t.spec({ labels, network: policy }), `create with network ${kindOf(policy)}`);
		}
		// The vendor's cap is a capability, so check() refuses past it with no vendor call.
		const { maxLifetimeMs } = t.provider.capabilities();
		t.assert(Number.isSafeInteger(maxLifetimeMs) && maxLifetimeMs > 0, `capabilities().maxLifetimeMs is a whole number of milliseconds above 0, not ${JSON.stringify(maxLifetimeMs)}`);
		const over = t.spec({ labels, lifetimeMs: maxLifetimeMs + 1 });
		const refusals = t.provider.check(over);
		t.assert(
			refusals.some((r) => r.field === "lifetimeMs" && r.message !== ""),
			`check of lifetimeMs ${maxLifetimeMs + 1}, past maxLifetimeMs, refuses lifetimeMs in words: ${JSON.stringify(refusals)}`,
		);
		await refusedCreate(t, over, "create of a spec past maxLifetimeMs");
		t.deepEqual(await names(t, labels), [], "the computers the refused creates made");
	}),
	provider("create-release", async (t) => {
		const labels = own(t, "release");
		const ref = await t.create({ labels });
		t.assert(typeof ref.id === "string" && ref.id !== "" && typeof ref.name === "string" && ref.name !== "", `a ref with an id and a name: ${JSON.stringify(ref)}`);
		const connected = await t.connect(ref);
		t.deepEqual(t.ok(await connected.client.call("ping", {}), "ping"), {}, "ping in the new computer");
		await connected.close();
		t.deepEqual(await names(t, labels), [ref.name], "listed after create");
		t.ok(await t.provider.release(ref, "delete"), "release delete");
		t.ok(await t.provider.release(ref, "delete"), "a second delete of the same computer");
		t.deepEqual(await names(t, labels), [], "listed after delete");
		t.refused(await t.provider.connect(ref), "connect to a deleted computer", ["gone", "not_found"]);
	}),
	provider("attach", async (t) => {
		const labels = own(t, "attach");
		const spec = t.spec({ labels: { ...labels, role: "a" } });
		const a = await t.create(spec);
		const b = await t.create({ labels: { ...labels, role: "b" } });
		const byId = t.ok(await t.provider.attach({ id: a.id }), "attach by id");
		t.deepEqual(refOf(byId), refOf(a), "attach by id");
		const byLabels = t.ok(await t.provider.attach({ labels: { ...labels, role: "b" } }), "attach by labels");
		t.deepEqual(refOf(byLabels), refOf(b), "attach by labels");
		// What attach reports is read back from the computer: the network and image create asked for, and, since create
		// asked for no user, the provider's non-root default.
		for (const [how, attached] of [["by id", byId], ["by labels", byLabels]] as const) {
			const read = t.present(attached.spec, `attach ${how} reports the spec it read back`);
			t.deepEqual(read.network, spec.network, `attach ${how}: the network it reports`);
			t.equal(read.image, spec.image, `attach ${how}: the image it reports`);
			t.match(read.user, /^\d+:\d+$/, `attach ${how}: the user it reports, as uid:gid`);
			t.assert(!read.user.startsWith("0:"), `attach ${how} reports user ${read.user}, root, though create asked for no user`);
		}
		const both = t.refused(await t.provider.attach({ labels }), "attach by labels two computers match", ["invalid"]);
		t.assert(both.message !== "", "the refusal is in words");
		t.refused(await t.provider.attach({ labels: { ...labels, role: "c" } }), "attach by labels no computer has", ["not_found"]);
		const connected = await t.connect(byLabels);
		t.deepEqual(t.ok(await connected.client.call("ping", {}), "ping"), {}, "ping in the attached computer");
		t.ok(await t.provider.release(a, "delete"), "release a");
		t.refused(await t.provider.attach({ id: a.id }), "attach to a deleted computer", ["not_found"]);
	}),
	provider("list", async (t) => {
		const labels = own(t, "list");
		const before = Date.now();
		const spec = t.spec({ labels: { ...labels, role: "listed" } });
		const ref = await t.create(spec);
		const after = Date.now();
		const listed = t.ok(await t.provider.list(labels), "list");
		t.equal(listed.length, 1, "computers with the case's labels");
		const info = t.present(listed[0], "the listed computer");
		t.deepEqual(refOf(info.ref), refOf(ref), "its ref");
		t.equal(info.labels.role, "listed", "its label role");
		t.equal(info.labels[CASE_LABEL], labels[CASE_LABEL], "its case label");
		t.equal(info.state, "running", "its state");
		t.deepEqual(info.network, spec.network, "its network, read back");
		const deadline = info.deadline instanceof Date ? info.deadline.getTime() : Number.NaN;
		t.assert(deadline >= before + spec.lifetimeMs - 1000 && deadline <= after + spec.lifetimeMs + 1000, `its deadline, ${String(info.deadline)}, is lifetimeMs after create`);
		t.deepEqual(await names(t, { ...labels, role: "other" }), [], "list by a label no computer has");
	}),
	// Stop is declared or refused: a provider that declares it lists the computer stopped; one that does not refuses it
	// in words and leaves the computer running, never stopped or deleted behind the caller's back.
	provider("stop", async (t) => {
		const labels = own(t, "stop");
		const ref = await t.create({ labels });
		const declared = t.provider.capabilities().release;
		if (!(Array.isArray(declared) && declared.includes("stop"))) {
			const words = "release stop, which the provider does not declare";
			const error = t.refused(await t.provider.release(ref, "stop"), words, ["unsupported"]);
			t.assert(error.message !== "", `${words}: the refusal is in words`);
			t.deepEqual(
				t.ok(await t.provider.list(labels), "list").map((info) => [info.ref.name, info.state]),
				[[ref.name, "running"]],
				`${words}: the computer is still listed, running`,
			);
			t.ok(await t.provider.release(ref, "delete"), "release delete");
			t.deepEqual(await names(t, labels), [], "listed after delete");
			return;
		}
		t.ok(await t.provider.release(ref, "stop"), "release stop");
		// A provider that declares stopDeletes ends a stopped computer: once release returns, it is neither listed nor
		// attachable, and a delete after it is the idempotent delete of a computer already gone.
		if (t.provider.capabilities().stopDeletes === true) {
			const words = "a stop on a provider whose stop ends in deletion (stopDeletes)";
			t.deepEqual(await names(t, labels), [], `${words}: listed after it`);
			t.refused(await t.provider.attach({ id: ref.id }), `${words}: attach to it`, ["not_found"]);
			t.ok(await t.provider.release(ref, "delete"), `${words}: a delete after it`);
			return;
		}
		const listed = t.ok(await t.provider.list(labels), "list");
		t.deepEqual(
			listed.map((info) => [info.ref.name, info.state]),
			[[ref.name, "stopped"]],
			"a stopped computer is listed, stopped",
		);
		t.ok(await t.provider.release(ref, "delete"), "release delete of a stopped computer");
		t.deepEqual(await names(t, labels), [], "listed after delete");
	}),
	provider("network-change", async (t) => {
		const spec = t.spec({ labels: own(t, "network") });
		const ref = await t.create(spec);
		const declared = t.provider.capabilities().network;
		t.deepEqual(t.ok(await t.provider.network(ref), "network read-back"), spec.network, "the network read back");
		t.deepEqual(t.ok(await t.provider.network(ref, spec.network), "asking for the network it has"), spec.network, "asking for the network it has");
		// Core never asks for a network the provider could give: only for one it does not declare, which it must refuse.
		for (const policy of POLICIES.filter((p) => !declared.includes(kindOf(p)))) {
			const words = `a change to network ${JSON.stringify(policy)}, which the provider does not declare`;
			const error = t.refused(await t.provider.network(ref, policy), words, ["refused"]);
			t.assert(error.message !== "", `${words}: the refusal is in words`);
			t.deepEqual(t.ok(await t.provider.network(ref), "network read-back"), spec.network, `${words}, refused: the network read back after it`);
		}
	}),
	switchCase("network-switch", "open"),
	switchCase("network-switch-allow", { allow: ["example.com"] }),
	provider(
		"network-open",
		async (t) => {
			const labels = own(t, "open");
			const ref = await t.create({ labels, network: "open" });
			t.equal(t.ok(await t.provider.network(ref), "network read-back"), "open", "the network read back");
			t.deepEqual(
				t.ok(await t.provider.list(labels), "list").map((info) => info.network),
				["open"],
				"the network list reads back",
			);
			const connected = await t.connect(ref);
			t.deepEqual(t.ok(await connected.client.call("ping", {}), "ping"), {}, "ping in an open computer");
		},
		{ level: "full", needs: ["network:open"] },
	),
	provider(
		"network-allow",
		async (t) => {
			const policy = { allow: ["example.com"] };
			const ref = await t.create({ labels: own(t, "allow"), network: policy });
			t.deepEqual(t.ok(await t.provider.network(ref), "network read-back"), policy, "the allowlist read back");
		},
		{ level: "full", needs: ["network:allow"] },
	),
	provider(
		"deadline",
		async (t) => {
			const labels = own(t, "deadline");
			// Long enough for create's checks on a loaded host; the case asserts the end, not its timing.
			const lifetimeMs = 45_000;
			const ref = await t.create({ lifetimeMs, labels });
			const created = Date.now();
			const connected = await t.connect(ref);
			t.ok(await connected.client.call("process.start", { argv: ["sh", "-c", "trap '' TERM; sleep 600"] }), "a process that ignores TERM");
			await connected.close();
			await delay(Math.max(0, created + lifetimeMs + 1000 - Date.now()));
			if (t.provider.capabilities().lifetime === "janitor") t.ok(await sweep(t.provider, { labels }), "the janitor's sweep after the deadline");
			await t.until(
				async () => t.ok(await t.provider.list(labels), "list").every((info) => info.state !== "running"),
				"the computer past its deadline, with a process that ignores TERM, stopped or gone",
				120_000,
			);
			t.refused(await t.provider.connect(ref), "connect to a computer past its deadline", ["gone", "not_found"]);
		},
		{ needs: ["processes"], timeoutMs: 300_000 },
	),
	provider(
		"janitor",
		async (t) => {
			if (t.provider.capabilities().stopDeletes === true) t.skip("the provider declares stopDeletes: a stop ends in deletion, so it keeps no stopped computer for the janitor to sweep");
			const labels = own(t, "janitor");
			const stopped = await t.create({ lifetimeMs: 60_000, labels: { ...labels, role: "stopped" } });
			const running = await t.create({ lifetimeMs: 5 * 60_000, labels: { ...labels, role: "running" } });
			const long = await t.create({ labels: { ...labels, role: "long" } });
			t.ok(await t.provider.release(stopped, "stop"), "release stop");
			const swept = t.ok(await sweep(t.provider, { labels, now: new Date(Date.now() + 6 * 60_000) }), "sweep");
			t.deepEqual(
				[[...swept.deleted].sort(), swept.kept],
				[[stopped.name, running.name].sort(), 1],
				"a sweep past two deadlines: the stopped and the running computer deleted, the third kept",
			);
			t.deepEqual(await names(t, labels), [long.name], "left after the sweep");
			t.deepEqual(refOf(t.ok(await t.provider.attach({ id: t.ref.id }), "attach to the run's computer")), refOf(t.ref), "a computer outside the swept labels");
			t.deepEqual(t.ok(await sweep(t.provider, { labels }), "a second sweep"), { deleted: [], kept: 1 }, "a second sweep, now");
		},
		{ level: "full", needs: ["lifetime:janitor", "release:stop"], computer: "shared" },
	),
	// A takeover by label: computers of one run at epochs 1, 2 and 3 and one of another run at epoch 1; a claim at epoch 3
	// releases 1 and 2 and keeps 3 and the other run's, and a claim at epoch 2 after it is fenced and releases nothing.
	// Full: it needs only list, labels and release delete, but the run and epoch labels are the cutover's, not yet Core.
	provider(
		"release-older",
		async (t) => {
			const labels = own(t, "release-older");
			const nonce = randomBytes(6).toString("hex");
			const run = `conformance-${nonce}`;
			const other = `conformance-other-${nonce}`;
			const [e1, e2, e3, o1] = await Promise.all(
				[runLabels(run, 1), runLabels(run, 2), runLabels(run, 3), runLabels(other, 1)].map((epochs) => t.create({ labels: { ...labels, ...epochs } })),
			);
			// The provider carries both labels and reads them back.
			const read = t.ok(await t.provider.list({ [RUN_LABEL]: run }), `list by ${RUN_LABEL}`);
			for (const [ref, of, epoch] of [[e1, run, "1"], [e2, run, "2"], [e3, run, "3"]] as const) {
				const info = t.present(read.find((one) => one.ref.name === ref.name), `${ref.name} is listed by ${RUN_LABEL}`);
				t.deepEqual([info.labels[RUN_LABEL], info.labels[EPOCH_LABEL]], [of, epoch], `${ref.name}: its ${RUN_LABEL} and ${EPOCH_LABEL} labels, read back`);
			}

			const done = t.ok(await releaseOlder(t.provider, run, 3, { signal: t.signal }), "releaseOlder at epoch 3");
			t.deepEqual(done.released.map(refOf).sort(byName), [e1, e2].sort(byName), "releaseOlder at epoch 3: the computers it released");
			t.deepEqual(done.kept.map(refOf), [e3], "releaseOlder at epoch 3: the computers it kept");
			t.deepEqual(done.unproven, [], "releaseOlder at epoch 3: computers with no epoch it could read");
			// By id first, which no label filter decides: 1 and 2 are gone, 3 and the other run's are there.
			for (const gone of [e1, e2]) t.refused(await t.provider.attach({ id: gone.id }), `attach to ${gone.name}, released`, ["not_found"]);
			for (const left of [e3, o1]) t.deepEqual(refOf(t.ok(await t.provider.attach({ id: left.id }), `attach to ${left.name}`)), left, `attach to ${left.name}, kept`);
			// Then by label: list holds to the run's label.
			t.deepEqual(await names(t, { [RUN_LABEL]: run }), [e3.name], "the run's computers after releaseOlder at epoch 3");
			t.deepEqual(await names(t, { [RUN_LABEL]: other }), [o1.name], "the other run's computers after releaseOlder at epoch 3");

			const fenced = t.refused(await releaseOlder(t.provider, run, 2, { signal: t.signal }), "releaseOlder at epoch 2, with epoch 3 there", ["refused"]);
			t.match(fenced.message, /^fenced: /, "releaseOlder at epoch 2, with epoch 3 there: its refusal");
			t.deepEqual(await names(t, { [RUN_LABEL]: run }), [e3.name], "the run's computers after the fenced releaseOlder");

			for (const ref of [e3, o1]) t.ok(await t.provider.release(ref, "delete"), `release ${ref.name}`);
			t.deepEqual(await names(t, labels), [], "the case's computers after it");
		},
		{ level: "full", timeoutMs: 300_000 },
	),
];
