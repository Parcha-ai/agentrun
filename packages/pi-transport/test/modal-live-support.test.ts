import { describe, expect, it, vi } from "vitest";
import { isReservedLabel } from "../src/box/box.ts";

describe("the labels of the Modal live suites", () => {
	it("name each live file's run apart, so one file's cleanup never touches another's boxes", async () => {
		vi.resetModules();
		const first = await import("./modal-live-support.ts");
		vi.resetModules();
		const second = await import("./modal-live-support.ts");
		expect(first.SPEC_LABELS["live-run"]).toBeTruthy();
		expect(first.SPEC_LABELS["live-run"]).not.toBe(second.SPEC_LABELS["live-run"]);
		expect(first.LABELS).toMatchObject({ "pi-transport": "1", "live-run": first.SPEC_LABELS["live-run"] });
	});

	it("keeps the provider's own label out of what a spec carries", async () => {
		const support = await import("./modal-live-support.ts");
		expect(Object.keys(support.SPEC_LABELS).filter(isReservedLabel)).toEqual([]);
		expect(support.kindSpec({ name: "sandbox" }).labels).toBe(support.SPEC_LABELS);
	});
});
