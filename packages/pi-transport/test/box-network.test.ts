import { describe, expect, it } from "vitest";
import { BoxError } from "../src/box/box.ts";
import {
	MAX_MOUNTS,
	parseMounts,
	parseNetwork,
	parsePorts,
	refuseMounts,
	refuseNetworkFields,
} from "../src/box/network.ts";

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
			["api.example-"],
			["a.example.c-"],
			["-a.example.com"],
			["example.com-"],
			["*.example-"],
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

describe("a spec's mounts", () => {
	it("are kept as given, read-write unless the entry says readOnly, nested targets included", () => {
		expect(parseMounts(undefined)).toEqual([]);
		expect(
			parseMounts([
				{ source: "/data/run", target: "/workspace/run" },
				{ source: "/data/home", target: "/workspace/home", readOnly: false },
				{ source: "/data/home/learning", target: "/workspace/home/learning", readOnly: true },
				{ source: "/data/run", target: "/workspace/again" },
				{ source: "/", target: "/host" },
			]),
		).toEqual([
			{ source: "/data/run", target: "/workspace/run", readOnly: false },
			{ source: "/data/home", target: "/workspace/home", readOnly: false },
			{ source: "/data/home/learning", target: "/workspace/home/learning", readOnly: true },
			{ source: "/data/run", target: "/workspace/again", readOnly: false },
			{ source: "/", target: "/host", readOnly: false },
		]);
	});

	it("refuse a relative path, a .. segment, a path not in normal form, a target of /, a repeat and too many, as invalid", () => {
		const one = (source: string, target: string) => [{ source, target }];
		const bad = [
			one("data/run", "/workspace/run"),
			one("/data/run", "workspace/run"),
			one("", "/workspace/run"),
			one("/data/../etc", "/workspace/run"),
			one("/data/run", "/workspace/.."),
			one("/data/run", "/"),
			one("/data/run/", "/workspace/run"),
			one("/data//run", "/workspace/run"),
			one("/data/./run", "/workspace/run"),
			one("/data/run", "//"),
			one("/data/run,readonly=false", "/workspace/run"),
			one("/data/run", '/workspace/"run"'),
			one("/data/run\ntarget=/etc", "/workspace/run"),
			one("/data/run\u0000", "/workspace/run"),
			[{ source: "/data/run", target: "/workspace/run", readOnly: "yes" as unknown as boolean }],
			[
				{ source: "/data/a", target: "/workspace/run" },
				{ source: "/data/b", target: "/workspace/run" },
			],
			Array.from({ length: MAX_MOUNTS + 1 }, (_, n) => ({ source: "/data/run", target: `/workspace/${n}` })),
			[{ source: 1 as unknown as string, target: "/workspace/run" }],
			[null as unknown as { source: string; target: string }],
			"mounts" as never,
		];
		expect(bad.map((mounts) => code(parseMounts(mounts)))).toEqual(bad.map(() => "invalid"));
		expect(
			code(parseMounts(Array.from({ length: MAX_MOUNTS }, (_, n) => ({ source: "/d", target: `/m/${n}` })))),
		).toBe("ok");
	});

	it("are refused by a provider that cannot bind them: any mount unsupported, by name, a malformed one invalid, none at all fine", () => {
		const refused = (mounts?: { source: string; target: string }[]) =>
			refuseMounts({ maxLifetimeMs: 1, mounts }, "x");
		expect(refused()).toBeUndefined();
		expect(refused([])).toBeUndefined();
		expect(refused([{ source: "/data/run", target: "/workspace/run" }])?.code).toBe("unsupported");
		expect(refused([{ source: "/data/run", target: "/workspace/run" }])?.message).toMatch(/^a x box takes no mounts/);
		expect(refused([{ source: "/data/run", target: "/" }])?.code).toBe("invalid");
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
