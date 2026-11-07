// A computer is what was declared: the daemon is the provider's version with its kind and groups, hello's arch is the
// computer's own, the network reads back as asked, and a daemon of another version is never handed out.
import type { Case, CaseContext } from "../types.js";
import { CASE_LABEL } from "./util.js";

/** uname -m for each of Go's architecture names. */
const MACHINE: Record<string, string> = { amd64: "x86_64", arm64: "aarch64", "386": "i686", arm: "armv7l", riscv64: "riscv64", s390x: "s390x", ppc64le: "ppc64le" };

const drift = (name: string, run: Case["run"], extra: Partial<Case> = {}): Case => ({ id: `drift.${name}`, level: "core", group: "drift", needs: [], run, ...extra });

function sameDaemon(t: CaseContext, hello: CaseContext["hello"], where: string) {
	t.equal(hello.version, t.provider.version, `${where}: the daemon's version is the provider's`);
	const { kind, groups } = t.provider.capabilities();
	t.equal(hello.kind, kind, `${where}: hello's kind is the provider's`);
	for (const group of groups) {
		t.assert(Array.isArray(hello.groups) && hello.groups.includes(group), `${where}: hello declares ${group}, which the provider declares`);
	}
}

export const driftCases: Case[] = [
	drift("hello-matches", async (t) => {
		sameDaemon(t, t.hello, "connect");
		const again = await t.connect();
		sameDaemon(t, again.hello, "a second connect");
	}),
	drift(
		"arch",
		async (t) => {
			const machine = (await t.exec(["uname", "-m"])).out.trim();
			const expected = t.present(MACHINE[t.hello.arch], `hello's arch ${t.hello.arch} is one the suite knows (${Object.keys(MACHINE).join(", ")})`);
			t.equal(machine, expected, `uname -m in a computer whose hello says ${t.hello.arch}`);
		},
		{ needs: ["exec"] },
	),
	drift("network", async (t) => {
		const declared = t.spec().network;
		t.deepEqual(t.ok(await t.provider.network(t.ref), "network read-back"), declared, "the network read back");
		const listed = t.ok(await t.provider.list(t.runLabels), "list");
		const info = t.present(
			listed.find((one) => one.ref.name === t.ref.name),
			`${t.ref.name} is listed by the run's label`,
		);
		t.deepEqual(info.network, declared, "the network list reads back");
	}, { needs: ["network:none"] }),
	drift(
		"version",
		async (t) => {
			const drifted = await t.drifted();
			const labels = { ...t.runLabels, [CASE_LABEL]: "drift" };
			const created = await t.attempt(t.spec({ labels }), drifted);
			if (created.ok) {
				let connected: Awaited<ReturnType<typeof drifted.connect>>;
				try {
					connected = await drifted.connect(created.value);
					if (connected.ok) await connected.value.close();
				} finally {
					await drifted.release(created.value, "delete");
				}
				t.refused(connected, "connect to a computer whose daemon reports another version", ["refused"]);
			} else {
				const error = t.refused(created, "create of a computer whose daemon reports another version", ["refused"]);
				t.match(error.message, /version/, "the refusal names the version");
			}
			const left = t.ok(await t.provider.list(labels), "list").map((info) => info.ref.name);
			t.deepEqual(left, [], "the computers of the drifted daemon left");
		},
		{ computer: "none", timeoutMs: 600_000 },
	),
];
