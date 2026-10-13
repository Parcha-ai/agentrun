import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	{ absentEnv: [CANARY] },
);
