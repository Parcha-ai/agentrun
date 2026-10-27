import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import type { BoxSpec } from "../src/box/box.ts";
import { dockerBoxes } from "../src/box/docker.ts";

const context = BACKGROUND_CONTEXT;
// A program that does not exist: a spec that is refused must be refused before Docker is asked for anything.
const provider = dockerBoxes({ docker: "/nonexistent/pi-transport-docker" });

async function refusal(fields: Partial<BoxSpec>): Promise<string> {
	const refused = await provider.create({ maxLifetimeMs: 60_000, ...fields }, context);
	if (refused.ok) throw new Error("the spec was accepted");
	return refused.error.code;
}

describe("docker boxes: what is refused before Docker is asked", () => {
	it("refuses a snapshot, a region and an isolation a container cannot give", async () => {
		expect(await refusal({ snapshot: "s" })).toBe("unsupported");
		expect(await refusal({ region: "us" })).toBe("unsupported");
		expect(await refusal({ isolation: "vm" })).toBe("unsupported");
		expect(await refusal({ isolation: "gvisor" })).toBe("unsupported");
	});

	it("refuses an allowlist, a port and a capability as unsupported, and a malformed network or port as invalid", async () => {
		expect(await refusal({ network: { allow: ["example.com"] } })).toBe("unsupported");
		expect(await refusal({ ports: [8080] })).toBe("unsupported");
		expect(await refusal({ capabilities: ["fuse"] })).toBe("unsupported");
		expect(await refusal({ network: { allow: [] } })).toBe("invalid");
		expect(await refusal({ ports: [0] })).toBe("invalid");
	});

	it("passes network none to Docker as --network none, and an open network as nothing, and says so in the facts", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-docker-args-"));
		try {
			const log = join(directory, "args.log");
			const script = join(directory, "docker");
			writeFileSync(
				script,
				`#!/bin/sh\necho "$@" >> ${log}\necho 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n`,
				{ mode: 0o755 },
			);
			const fake = dockerBoxes({ docker: script });
			const none = await fake.create({ maxLifetimeMs: 60_000, network: "none" }, context);
			const open = await fake.create({ maxLifetimeMs: 60_000 }, context);
			const [first, second] = readFileSync(log, "utf8").trim().split("\n");
			expect(first).toContain("--network none");
			expect(second).not.toContain("--network");
			expect(none.ok && none.value.facts()).toMatchObject({
				network: "none",
				ports: [],
			});
			// What a docker box does not report stays absent, which a caller reads as unknown (see readFacts).
			for (const key of ["fuse", "ptraceScope", "diskGb"])
				expect(none.ok && none.value.facts()).not.toHaveProperty(key);
			expect(open.ok && open.value.facts().network).toBe("open");
			expect(open.ok && open.value.facts().startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("refuses a label in the providers' own namespace, which would replace the box's stored facts", async () => {
		expect(await refusal({ labels: { "pi-transport.facts": '{"provider":"docker"}' } })).toBe("invalid");
		expect(await refusal({ labels: { "pi-transport.box": "0" } })).toBe("invalid");
		expect(await refusal({ labels: { "pi-transport": "1" } })).toBe("invalid");
	});

	it("refuses a lifetime that is not positive", async () => {
		expect(await refusal({ maxLifetimeMs: 0 })).toBe("invalid");
	});

	it("reports a docker program that cannot start as a spawn error, not a throw", async () => {
		const created = await provider.create({ maxLifetimeMs: 60_000 }, context);
		expect(created.ok).toBe(false);
		if (!created.ok) expect(created.error.code).toBe("spawn");
		const attached = await provider.attach("0123456789ab", context);
		expect(attached.ok).toBe(false);
	});
});
