// The daemon answers: hello, ping, and an error in words for a method it does not have.
import type { Case } from "../types.js";

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
			t.assert(Array.isArray(hello.capabilities), "hello lists capabilities");
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
];
