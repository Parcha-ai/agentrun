import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: { conditions: ["source"] },
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
