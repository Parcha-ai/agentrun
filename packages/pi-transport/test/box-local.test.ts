import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { localBoxes } from "../src/box/local.ts";
import { registerBoxConformance } from "../src/testing/index.ts";

const CANARY = "PI_TRANSPORT_HOST_CANARY";
process.env[CANARY] = "the host's environment reached a box";

registerBoxConformance(
	{ describe, expect, it },
	"local boxes",
	async (use) => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-local-"));
		try {
			await use(localBoxes({ root }));
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		}
	},
	{ absentEnv: [CANARY], lifetime: { maxLifetimeMs: 1_500, graceMs: 3_000 } },
);

describe("local boxes and isolation", () => {
	it("refuses a spec that asks for more isolation than a directory gives", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-transport-local-"));
		try {
			const provider = localBoxes({ root });
			const refused = await provider.create({ maxLifetimeMs: 60_000, isolation: "vm" }, BACKGROUND_CONTEXT);
			expect(refused.ok).toBe(false);
			if (!refused.ok) expect(refused.error.code).toBe("unsupported");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
