import { describe, expect, it } from "vitest";
import type { BoxFacts } from "../src/box/box.ts";
import { readFacts } from "../src/facts.ts";

// A provider that reports only what this package always had: every newer fact is absent.
const bare: BoxFacts = {
	provider: "custom",
	isolation: "vm",
	cpus: null,
	memoryMb: null,
	gpu: null,
	workspace: "/w",
	maxLifetimeMs: null,
	snapshot: null,
};

describe("an absent fact never grants anything", () => {
	it("fuse absent is false", () => {
		expect(readFacts(bare).fuse).toBe(false);
		expect(readFacts({ ...bare, fuse: false }).fuse).toBe(false);
		expect(readFacts({ ...bare, fuse: true }).fuse).toBe(true);
	});

	it("network absent is unknown, which is not open, not none and not an allowlist", () => {
		expect(readFacts(bare).network).toBe("unknown");
		expect(
			(["open", "none", "allowlist"] as const).map((network) => readFacts({ ...bare, network }).network),
		).toEqual(["open", "none", "allowlist"]);
	});

	it("ports absent is unknown, and noPortExposed is true only for a list that is empty", () => {
		expect(readFacts(bare)).toMatchObject({ ports: "unknown", noPortExposed: false });
		expect(readFacts({ ...bare, ports: [] })).toMatchObject({ ports: [], noPortExposed: true });
		expect(readFacts({ ...bare, ports: [{ port: 80, kind: "https" }] }).noPortExposed).toBe(false);
	});

	it("ptraceScope absent is not an assumption of 1 or more", () => {
		expect(readFacts(bare).ptraceAtLeast1).toBe(false);
		expect(([0, 1, 2, 3] as const).map((ptraceScope) => readFacts({ ...bare, ptraceScope }).ptraceAtLeast1)).toEqual([
			false,
			true,
			true,
			true,
		]);
	});

	it("diskGb and startedAt absent are unknown (null), the receipt's cue to fall back to the create time", () => {
		expect(readFacts(bare)).toMatchObject({ diskGb: null, startedAt: null });
		expect(readFacts({ ...bare, diskGb: 40, startedAt: "2026-10-22T18:00:00.000Z" })).toMatchObject({
			diskGb: 40,
			startedAt: "2026-10-22T18:00:00.000Z",
		});
	});
});
