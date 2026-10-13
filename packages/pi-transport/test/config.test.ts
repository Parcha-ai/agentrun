import { describe, expect, it } from "vitest";
import { type ConfigIssue, parseDuration, parseTransportConfig } from "../src/config.ts";

const valid = {
	environments: {
		local: { provider: "local" },
		box: { provider: "daytona", image: "agent-base", cpus: 2, memoryMb: 4096, maxLifetime: "6h" },
		gpu: { provider: "modal", gpu: "H100", maxLifetime: "24h", scope: "conversation", capabilities: ["gpu"] },
	},
	home: "box",
	hands: { default: "box", train: "gpu" },
};

function issuesOf(input: unknown): readonly ConfigIssue[] {
	const result = parseTransportConfig(input);
	if (result.ok) throw new Error("the config was accepted");
	return result.error.issues;
}

describe("parseTransportConfig", () => {
	it("accepts the documented shape and resolves its defaults", () => {
		const result = parseTransportConfig(valid);
		if (!result.ok) throw result.error;
		const config = result.value;
		expect(config.home).toBe("box");
		expect(config.hands).toEqual({ default: "box", roles: { train: "gpu" } });
		expect(config.environments.box?.maxLifetimeMs).toBe(6 * 3_600_000);
		expect(config.environments.box?.scope).toBe("session");
		expect(config.environments.box?.expose).toEqual([]);
		expect(config.environments.gpu?.scope).toBe("conversation");
		expect(config.environments.local?.maxLifetimeMs).toBe(24 * 3_600_000);
		expect(config.workspace).toEqual({ exclude: [] });
		expect(config.auto).toBeUndefined();
	});

	it("carries the isolation an environment asks for", () => {
		const result = parseTransportConfig({
			environments: { vm: { provider: "modal", isolation: "vm", maxLifetime: "1h" } },
		});
		if (!result.ok) throw result.error;
		expect(result.value.environments.vm?.isolation).toBe("vm");
		const bad = { environments: { vm: { provider: "modal", isolation: "jail", maxLifetime: "1h" } } };
		expect(issuesOf(bad).map((issue) => issue.path)).toEqual(["/environments/vm/isolation"]);
	});

	it("keeps a workspace path the author wrote and refuses a relative one", () => {
		const result = parseTransportConfig({ ...valid, workspace: { path: "/srv/work", exclude: ["cache"] } });
		if (!result.ok) throw result.error;
		expect(result.value.workspace).toEqual({ path: "/srv/work", exclude: ["cache"] });
		expect(issuesOf({ ...valid, workspace: { path: "work" } }).map((issue) => issue.path)).toEqual([
			"/workspace/path",
		]);
	});

	it("accepts hands as one environment id", () => {
		const result = parseTransportConfig({ environments: valid.environments, hands: "gpu" });
		if (!result.ok) throw result.error;
		expect(result.value.hands).toEqual({ default: "gpu", roles: {} });
		expect(result.value.home).toBeUndefined();
	});

	it("refuses an unknown key at every level and names its path", () => {
		expect(issuesOf({ ...valid, homes: "box" })).toContainEqual({ path: "/homes", message: "unknown key" });
		const nested = { ...valid, environments: { box: { provider: "daytona", maxLifetime: "1h", imagee: "x" } } };
		expect(issuesOf({ ...nested, home: "box", hands: "box" })).toContainEqual({
			path: "/environments/box/imagee",
			message: "unknown key",
		});
		expect(issuesOf({ ...valid, workspace: { root: "/w" } })).toContainEqual({
			path: "/workspace/root",
			message: "unknown key",
		});
	});

	it("refuses a home or hands that names no declared environment", () => {
		expect(issuesOf({ ...valid, home: "nowhere" }).map((issue) => issue.path)).toEqual(["/home"]);
		expect(issuesOf({ ...valid, hands: { default: "box", train: "h100" } }).map((issue) => issue.path)).toEqual([
			"/hands/train",
		]);
	});

	it("refuses roles with no default", () => {
		expect(issuesOf({ ...valid, hands: { train: "gpu" } }).map((issue) => issue.path)).toEqual(["/hands/default"]);
	});

	it("refuses auto with no classifier and accepts it with one", () => {
		expect(issuesOf({ ...valid, home: "auto" })).toEqual([
			{ path: "/home", message: "is auto, which needs auto.classifier" },
		]);
		const result = parseTransportConfig({
			...valid,
			home: "auto",
			auto: { classifier: { provider: "typesafe", modelId: "jev-latest" } },
		});
		if (!result.ok) throw result.error;
		expect(result.value.auto?.ask).toBe("message");
	});

	it("requires a lifetime for every provider but local", () => {
		const input = { environments: { box: { provider: "daytona" } }, home: "box" };
		expect(issuesOf(input).map((issue) => issue.path)).toEqual(["/environments/box/maxLifetime"]);
		const bad = { environments: { box: { provider: "daytona", maxLifetime: "soon" } } };
		expect(issuesOf(bad).map((issue) => issue.path)).toEqual(["/environments/box/maxLifetime"]);
	});

	it("refuses a reserved or malformed environment id", () => {
		expect(issuesOf({ environments: { auto: { provider: "local" } } }).map((issue) => issue.path)).toEqual([
			"/environments/auto",
		]);
		expect(issuesOf({ environments: { "My Box": { provider: "local" } } }).map((issue) => issue.path)).toEqual([
			"/environments/My Box",
		]);
	});

	it("reports a misspelled key together with the bad references and the missing lifetime", () => {
		const issues = issuesOf({ environments: { box: { provider: "docker" } }, home: "missing", typo: true });
		expect(issues.map((issue) => issue.path).sort()).toEqual(["/environments/box/maxLifetime", "/home", "/typo"]);
	});

	it("escapes a key that holds a slash or a tilde in the path", () => {
		expect(
			issuesOf({ environments: {}, "a/b": 1, "c~d": 2 })
				.map((issue) => issue.path)
				.sort(),
		).toEqual(["/a~1b", "/c~0d"]);
		const issues = issuesOf({
			environments: { "x/y": { provider: "local" } },
			hands: { default: "x/y", "r/s": "none" },
		});
		expect(issues.map((issue) => issue.path)).toContain("/environments/x~1y");
		expect(issues.map((issue) => issue.path)).toContain("/hands/r~1s");
	});

	it("reports every problem at once", () => {
		const issues = issuesOf({
			environments: { box: { provider: "daytona", image: "a", snapshot: "b" } },
			home: "nowhere",
			hands: "also-nowhere",
		});
		expect(issues.map((issue) => issue.path).sort()).toEqual([
			"/environments/box",
			"/environments/box/maxLifetime",
			"/hands",
			"/home",
		]);
	});

	it("refuses a wrong type with the path of the value", () => {
		const input = { environments: { box: { provider: "docker", maxLifetime: "1h", cpus: "two" } } };
		expect(issuesOf(input).map((issue) => issue.path)).toEqual(["/environments/box/cpus"]);
		expect(issuesOf({ environments: { box: { provider: "docker", maxLifetime: "1h", scope: "thread" } } })).toEqual([
			{ path: "/environments/box/scope", message: "has no allowed value or shape" },
		]);
	});
});

describe("parseDuration", () => {
	it("reads a whole number and a unit", () => {
		expect(parseDuration("500ms")).toBe(500);
		expect(parseDuration("90s")).toBe(90_000);
		expect(parseDuration("30m")).toBe(1_800_000);
		expect(parseDuration("6h")).toBe(21_600_000);
		expect(parseDuration("2d")).toBe(172_800_000);
	});

	it("refuses anything else", () => {
		for (const text of ["", "6", "h", "1.5h", "-1h", "0s", "6 h", "6hours"]) {
			expect(parseDuration(text)).toBeUndefined();
		}
	});
});
