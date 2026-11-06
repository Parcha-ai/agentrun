// `npm run conformance -w @parcha/agentrun-computer -- --provider docker | ./module.js [--image <image>] [--only <groups>] [--json]`
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Case } from "./types.js";

export interface CliIo {
	stdout?: { write(text: string): unknown };
	stderr?: { write(text: string): unknown };
	/** Where a module path is resolved from; default the directory npm was run in. */
	cwd?: string;
	cases?: Case[];
	signal?: AbortSignal;
}

export async function main(_argv: string[], { stderr = process.stderr }: CliIo = {}): Promise<number> {
	stderr.write("computer conformance is not built yet\n");
	return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	process.exitCode = await main(process.argv.slice(2));
}
