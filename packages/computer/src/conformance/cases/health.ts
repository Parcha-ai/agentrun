// The daemon answers: hello, ping, and an error in words for a method it does not have; the computer is the kind it
// says it is; what the provider declares of itself, its capabilities() and each hello agree, at this protocol's
// version; and no error the provider answers holds a key.
import { GROUPS, PROTOCOL_VERSION } from "../../protocol.js";
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
				else if (need === "vendor-agent") t.assert(Array.isArray(declared.vendorAgentPorts), `${who} must declare its vendor's agent's ports (vendorAgentPorts)`);
				else t.assert((groups as string[]).includes(need), `${who} must declare ${need}`);
			}
		},
	},
	{
		// The provider says what it is three times: in what it declares of itself (its descriptor), in capabilities(), and
		// in each computer's hello. A runner trusts the first to pick a provider, the second to call it, and the third to
		// hand a computer out; where they disagree, it picks a computer that cannot do the work. kind-consistent above
		// holds hello to capabilities(); this holds capabilities() to the declaration, and hello to the protocol.
		id: "health.declared",
		level: "core",
		group: "health",
		needs: [],
		async run(t) {
			t.equal(t.hello.protocol, PROTOCOL_VERSION, `hello carries the protocol version this suite speaks, ${PROTOCOL_VERSION}`);
			const declared = t.declared;
			if (declared === undefined) {
				return t.skip("the run was given no declaration of the provider: its descriptor, its PROVIDERS entry, or its module's CAPABILITIES");
			}
			const { kind, groups } = t.provider.capabilities();
			const same = (a: readonly string[], b: readonly string[]) => [...a].sort().join(",") === [...b].sort().join(",");
			const configurations = declared.map((one) => `${one.kind} [${one.groups.join(", ")}]`).join("; ");
			t.assert(
				declared.some((one) => one.kind === kind && same(one.groups, groups)),
				`capabilities(), kind ${kind} [${groups.join(", ")}], is one of the configurations the provider declares: ${configurations}`,
			);
		},
	},
	{
		// A key in an error is a key in a log, a report and a model's context. The provider is built again with a planted
		// value in place of each secret, so every call fails on it, and every refusal path is asked: none of what comes
		// back, an error thrown included, may hold the value, or its last 12 characters (a vendor that echoes a key cut
		// short). A planted key never makes a computer; one that did is deleted with the case, and the case fails.
		id: "health.no-key-in-errors",
		level: "core",
		group: "health",
		// A provider that takes no secret (Docker) has none to leak: the case is skipped as undeclared, apart from Core.
		needs: ["secrets"],
		async run(t) {
			const { provider, secrets } = await t.planted();
			t.assert(secrets.length > 0 && secrets.every((secret) => typeof secret === "string" && secret.length >= 16), "the planted secrets are named, each 16 characters or more");
			const networks = provider.capabilities().network;
			const network = networks.includes("none") ? "none" : "open";
			// The case's own computer, a real one of the provider's: each path that takes a ref passes the provider's own
			// checks of its shape and reaches the vendor with the planted secret, where a made-up ref could be refused first.
			const ref = t.ref;
			const paths: Array<[string, () => Promise<unknown>]> = [
				["testConnection", async () => provider.testConnection?.({ signal: t.signal }) ?? "no testConnection"],
				["list", () => provider.list(t.runLabels, { signal: t.signal })],
				["attach by id", () => provider.attach({ id: ref.id }, { signal: t.signal })],
				["attach by labels", () => provider.attach({ labels: t.runLabels }, { signal: t.signal })],
				["network", () => provider.network(ref, undefined, { signal: t.signal })],
				["connect", () => provider.connect(ref)],
				["release", () => provider.release(ref, "delete")],
				["create", () => t.attempt(t.spec({ network }), provider)],
			];
			for (const [name, call] of paths) {
				let answer: unknown;
				try {
					answer = await call();
				} catch (error) {
					answer = { threw: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error) };
				}
				// A connection made anyway (a vendor whose connect reads no key) is closed whatever the checks find: the runner
				// never saw it, so its cleanup can't close it.
				const opened = answer as { ok?: unknown; value?: { close?: () => Promise<unknown> } } | undefined;
				try {
					const words = JSON.stringify(answer, (_key, value: unknown) => (value instanceof Error ? `${value.name}: ${value.message}` : value)) ?? String(answer);
					for (const secret of secrets) {
						for (const piece of [secret, secret.slice(-12)]) t.assert(!words.includes(piece), `${name}: what the provider answered holds none of a planted secret`);
					}
					if (name === "create") t.assert(opened?.ok !== true, "create with a planted secret made no computer");
				} finally {
					if (name === "connect" && opened?.ok === true) await opened.value?.close?.().catch(() => undefined);
				}
			}
			// A release the vendor refused for its key let nothing go: the computer is still the provider's.
			const still = await t.provider.attach({ id: ref.id }, { signal: t.signal });
			t.assert(still.ok, `the computer is still there after a release with a planted secret${still.ok ? "" : `: ${still.error.code}: ${still.error.message}`}`);
		},
	},
];
