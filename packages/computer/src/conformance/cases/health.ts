// The daemon answers: hello, ping, and an error in words for a method it does not have; and the computer is the kind
// it says it is.
import { GROUPS } from "../../protocol.js";
import { kindRefusals } from "../../provider.js";
import { type Case, coreGroups } from "../types.js";

export const healthCases: Case[] = [
	{
		id: "health.hello",
		level: "core",
		group: "health",
		needs: [],
		async run(t) {
			const hello = t.ok(await t.client.call("hello", { client: "agentrun conformance" }), "hello");
			t.equal(typeof hello.version, "string", "hello's version is a string");
			t.assert(hello.version !== "", "hello names a version");
			t.equal(hello.os, t.provider.capabilities().os, "hello's os is the one the provider declares");
			t.assert(typeof hello.arch === "string" && hello.arch !== "", "hello names an arch");
			t.assert(Array.isArray(hello.groups), "hello lists groups");
			t.deepEqual(hello, t.hello, "hello on this call and at connect");
		},
	},
	{
		id: "health.ping",
		level: "core",
		group: "health",
		needs: [],
		async run(t) {
			t.deepEqual(await t.call("ping", {}), {}, "ping");
			t.deepEqual(await t.call("ping", {}), {}, "a second ping");
		},
	},
	{
		id: "health.unknown-method",
		level: "core",
		group: "health",
		needs: [],
		async run(t) {
			const unknown = await t.client.call("no.such.method" as "ping", {});
			const error = t.refused(unknown, "a method the daemon does not have", ["unsupported"]);
			t.assert(error.message !== "", "the refusal is in words");
			t.deepEqual(await t.call("ping", {}), {}, "ping after it: the connection goes on");
		},
	},
	{
		id: "health.kind-consistent",
		level: "core",
		group: "health",
		needs: [],
		async run(t) {
			const declared = t.provider.capabilities();
			const { kind, os, daemon, groups } = declared;
			const refusals = kindRefusals(declared);
			t.assert(refusals.length === 0, `kind ${kind}, os ${os} and daemon ${daemon} are not a valid pair: ${refusals.map((r) => r.message).join("; ")}`);
			t.assert(Array.isArray(groups), "capabilities().groups is a list");
			const unknown = groups.filter((group) => !GROUPS.includes(group));
			t.deepEqual(unknown, [], "the groups capabilities() declares that the protocol does not have");
			t.equal(t.hello.kind, kind, "hello's kind is the one the provider declares");
			t.assert(Array.isArray(t.hello.groups), "hello lists groups");
			t.deepEqual([...t.hello.groups].sort(), [...groups].sort(), "hello's groups are the ones the provider declares");
			const who = daemon === "none" ? `a ${kind} computer` : `a ${kind} computer with daemon ${daemon}`;
			for (const need of coreGroups(kind, daemon)) {
				if (need === "network:none") t.assert(declared.network.includes("none"), `${who} must declare network none`);
				else t.assert((groups as string[]).includes(need), `${who} must declare ${need}`);
			}
		},
	},
];
