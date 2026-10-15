import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { App } from "../src/home/app.ts";
import { runMain } from "../src/home/main.ts";
import { textResult } from "../src/testing/tool-result.ts";

/** An app whose one tool leaves a line in the workspace, run as a whole runner program. */
const app: App = (ctx) => {
	const work = defineTool({
		name: "work",
		description: "Do one unit of work with an effect.",
		parameters: Type.Object({ n: Type.Number() }),
		async execute(args) {
			await appendFile(join(ctx.workspace, "effects.log"), `${args.n}\n`);
			// Said on the output to show that it does not reach the link.
			console.log(`did ${args.n}`);
			return textResult(`did ${args.n}`);
		},
	});
	const registry = createRegistry();
	registry.install(defineExtension({ name: "work", tools: [work] }));
	return { registry, root: { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: ctx.workspace } } };
};

await runMain(app);
