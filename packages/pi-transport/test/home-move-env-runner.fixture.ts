// A runner for the move tests whose app writes the environment it is given at each open beside its workspace.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../src/home/app.ts";
import { runMain } from "../src/home/main.ts";
import { moveConformanceApp } from "../src/testing/move-conformance.ts";

const app: App = async (ctx) => {
	writeFileSync(join(ctx.root, `env-${ctx.epoch}.json`), JSON.stringify(ctx.env));
	return moveConformanceApp(ctx);
};

await runMain(app);
