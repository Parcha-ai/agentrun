import { describe, expect, it } from "vitest";
import { BoxError } from "../src/box/box.ts";
import { parseNetwork, parsePorts, refuseNetworkFields } from "../src/box/network.ts";

const code = (value: unknown) => (value instanceof BoxError ? value.code : "ok");

describe("a spec's network", () => {
	it("is open by default, and none or an allowlist as asked", () => {
		expect(parseNetwork(undefined)).toEqual({ kind: "open" });
		expect(parseNetwork("open")).toEqual({ kind: "open" });
		expect(parseNetwork("none")).toEqual({ kind: "none" });
		expect(parseNetwork({ allow: ["api.example.com", "*.Example.org", "10.0.0.0/8", "192.168.1.1/32"] })).toEqual({
			kind: "allowlist",
			domains: ["api.example.com", "*.example.org"],
			cidrs: ["10.0.0.0/8", "192.168.1.1/32"],
		});
	});

	it("refuses an empty list and an entry that is no domain, wildcard domain or IPv4 CIDR, as invalid", () => {
		const bad = [
			[],
			["https://example.com"],
			["example.com/path"],
			["*example.com"],
			["a.*.example.com"],
			["localhost"],
			["10.0.0.0/33"],
			["300.0.0.0/8"],
			["10.0.0.1"],
			["::1/128"],
			["bad domain.com"],
			[""],
			[1 as unknown as string],
		];
		expect(bad.map((allow) => code(parseNetwork({ allow })))).toEqual(bad.map(() => "invalid"));
		expect(code(parseNetwork("closed" as never))).toBe("invalid");
	});
});

describe("a spec's ports", () => {
	it("are https unless the entry says tcp", () => {
		expect(parsePorts(undefined)).toEqual([]);
		expect(parsePorts([8080, { port: 5432, kind: "tcp" }, { port: 443, kind: "https" }])).toEqual([
			{ port: 8080, kind: "https" },
			{ port: 5432, kind: "tcp" },
			{ port: 443, kind: "https" },
		]);
	});

	it("refuse a port outside 1-65535, a non-integer, a repeat and an unknown kind, as invalid", () => {
		const bad = [
			[0],
			[65536],
			[1.5],
			[-1],
			[80, 80],
			[80, { port: 80, kind: "tcp" as const }],
			[{ port: 80, kind: "udp" as never }],
		];
		expect(bad.map((ports) => code(parsePorts(ports)))).toEqual(bad.map(() => "invalid"));
	});
});

describe("a provider with no network boundary of its own", () => {
	it("refuses none (unless it can), an allowlist, any port and any capability as unsupported, and a malformed spec as invalid", () => {
		const refused = (spec: object, allowNone = false) => {
			const e = refuseNetworkFields({ maxLifetimeMs: 1, ...spec }, "x", allowNone);
			return e === undefined ? "ok" : e.code;
		};
		expect(refused({})).toBe("ok");
		expect(refused({ network: "open" })).toBe("ok");
		expect(refused({ network: "none" })).toBe("unsupported");
		expect(refused({ network: "none" }, true)).toBe("ok");
		expect(refused({ network: { allow: ["example.com"] } }, true)).toBe("unsupported");
		expect(refused({ ports: [80] })).toBe("unsupported");
		expect(refused({ capabilities: ["fuse"] })).toBe("unsupported");
		expect(refused({ network: { allow: [] } })).toBe("invalid");
		expect(refused({ ports: [0] })).toBe("invalid");
	});
});
