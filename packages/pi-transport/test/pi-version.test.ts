import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// A CI leg that reruns the suite on another pi version sets one of these, so a run that resolved a different copy fails.
// `PI_EXPECT_VERSION` is what scripts/pi-leg.mjs sets; the older name still works for a local run.
const expected = process.env.PI_EXPECT_VERSION ?? process.env.PI_TRANSPORT_EXPECT_PI_DURABLE;
const require = createRequire(import.meta.url);

describe("the pi packages this run resolved", () => {
	it.skipIf(expected === undefined)("are the version the job asked for", () => {
		for (const name of ["@earendil-works/pi-durable", "@earendil-works/chord"]) {
			expect(require(`${name}/package.json`).version, name).toBe(expected);
		}
	});
});
