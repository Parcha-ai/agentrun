import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { App } from "./app.ts";
import { streamLink } from "./link.ts";
import { createRunner } from "./runner.ts";

/** The lowest Node a runner runs on: pi-durable's own floor. */
const NODE_FLOOR = [22, 19] as const;
/** The exit code of a runner that was started wrong: no use starting it again the same way. */
export const EXIT_USAGE = 64;

/**
 * The whole program of a runner file. A customer's entry imports their app and this function, calls `runMain(app)`,
 * and bundles the two into one file (the README shows it).
 *
 * It speaks the link on its own input and output, so it writes nothing else there: what the app logs with
 * `console.log` goes to the error output. Arguments: `--session`, `--store`, `--workspace`, `--environment`,
 * `--provider`. When the link closes the runner closes the session in order and exits; a runner started again opens
 * nothing until a host says so. It returns the exit code and sets it: the process ends once nothing is left to run.
 */
export async function runMain(app: App, argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	if (major < NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor < NODE_FLOOR[1])) {
		process.stderr.write(`pi-transport: Node ${process.versions.node} is below ${NODE_FLOOR.join(".")}\n`);
		return finish(EXIT_USAGE);
	}
	let values: Record<string, string | undefined>;
	try {
		values = parseArgs({
			args: [...argv],
			options: {
				session: { type: "string" },
				store: { type: "string" },
				workspace: { type: "string" },
				environment: { type: "string" },
				provider: { type: "string" },
			},
			strict: true,
		}).values;
	} catch (cause) {
		process.stderr.write(`pi-transport: ${cause instanceof Error ? cause.message : String(cause)}\n`);
		return finish(EXIT_USAGE);
	}
	const { session, store, workspace, environment, provider } = values;
	if (session === undefined || store === undefined || workspace === undefined) {
		process.stderr.write("pi-transport: --session, --store and --workspace are required\n");
		return finish(EXIT_USAGE);
	}
	// The output is the link.
	console.log = (...args: unknown[]) => console.error(...args);
	const runner = createRunner({
		app,
		session,
		store,
		workspace,
		where: { environment: environment ?? "unknown", provider: provider ?? "unknown" },
	});
	const link = streamLink(process.stdin, process.stdout);
	const closed = new Promise<number>((resolve) => {
		link.onClose(async () => {
			await runner.home?.close(BACKGROUND_CONTEXT);
			resolve(0);
		});
	});
	runner.attach(link);
	const ended = await Promise.race([runner.ended.then((end) => end.exitCode), closed]);
	return finish(ended);
}

function finish(code: number): number {
	process.exitCode = code;
	// Nothing more comes in: once the session is closed, the process has nothing left that keeps it alive.
	process.stdin.destroy();
	return code;
}
