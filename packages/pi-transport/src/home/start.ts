import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { err, ok, type Result } from "@earendil-works/pi-durable/env";
import type { Box } from "../box/box.ts";
import { finish } from "../box/files.ts";
import { type Crossing, type CrossingCounter, crossingCounter } from "./crossing.ts";
import { connectHome, type HomeHandle } from "./host.ts";
import { processLink } from "./link.ts";
import { MoveError, type Place, type StartRunner } from "./move.ts";
import type { RecordSink } from "./records.ts";

/** The lowest Node a runner runs on: pi-durable's own floor. */
const NODE_FLOOR = [22, 19] as const;

/**
 * The runner a host starts: a file on this machine, uploaded once by its SHA-256 and run with the box's `node`; or
 * a program the image already holds, started by its argv.
 */
export type RunnerProgram = { readonly file: string } | { readonly argv: readonly string[] };

export type BoxRunnerOptions = {
	readonly program: RunnerProgram;
	readonly session: string;
	/** The host's models: the runner gets their catalog, the host answers its requests with them. */
	readonly models: Models;
	/** What the runner writes on its error output, for the host's log. */
	readonly onErrors?: (text: string) => void;
	/** Where the session's record stream goes: the same sink for every runner of the session, wherever it runs. */
	readonly records?: RecordSink;
	/** Announced when a tool of a runner this starts begins (`transport.tool.started`): see `ConnectOptions.crossing`. */
	readonly crossing?: Crossing;
	/** The place's counter, shared with its `pullCheckpoint`s, so that `n` counts across restarts and points of one session. */
	readonly crossingCount?: CrossingCounter;
};

/** The output of one short program in a box, or why it did not run. */
async function output(box: Box, argv: readonly string[], context: Context): Promise<Result<string, MoveError>> {
	const started = await box.exec(argv, { timeoutMs: 60_000 }, context);
	if (!started.ok)
		return err(new MoveError("prepare", `could not run ${argv[0]} in ${box.id}: ${started.error.message}`));
	const finished = await finish(started.value);
	if (!finished.ok) return err(new MoveError("prepare", `${argv[0]} in ${box.id} failed: ${finished.error.message}`));
	if (finished.value.exitCode !== 0) {
		const said = `${new TextDecoder().decode(finished.value.stdout)}${finished.value.stderr}`.trim().slice(-200);
		return err(new MoveError("prepare", `${argv[0]} in ${box.id} exited with ${finished.value.exitCode}: ${said}`));
	}
	return ok(new TextDecoder().decode(finished.value.stdout).trim());
}

/** The box's Node, refused when it is missing or below the floor. */
async function checkNode(box: Box, context: Context): Promise<Result<string, MoveError>> {
	const found = await output(
		box,
		["sh", "-c", "command -v node >/dev/null || exit 127; node -p process.versions.node"],
		context,
	);
	if (!found.ok) {
		return err(
			new MoveError(
				"no_runtime",
				`the box ${box.id} has no usable node, which a home needs: ${found.error.message}`,
			),
		);
	}
	const [major = 0, minor = 0] = found.value.split(".").map(Number);
	if (major < NODE_FLOOR[0] || (major === NODE_FLOOR[0] && minor < NODE_FLOOR[1])) {
		return err(
			new MoveError(
				"no_runtime",
				`the box ${box.id} has Node ${found.value}; a home needs ${NODE_FLOOR.join(".")} or newer`,
			),
		);
	}
	return ok(found.value);
}

/**
 * Start a runner in each place's box and hold it over the box's own `exec`. A runner file goes to the store's
 * directory as `runner-<sha256>.mjs`, uploaded only when the box does not hold that file yet; Node is checked first.
 */
export function boxRunner(options: BoxRunnerOptions): StartRunner {
	// One count for every runner this starts: a restarted runner goes on counting.
	const counter = options.crossingCount ?? crossingCounter();
	let file: Promise<{ readonly bytes: Uint8Array; readonly sha256: string }> | undefined;
	return async (place: Place, epoch: number, context: Context): Promise<Result<HomeHandle, MoveError>> => {
		const { box } = place;
		const node = await checkNode(box, context);
		if (!node.ok) return node;
		let argv: readonly string[];
		const { program } = options;
		if ("file" in program) {
			file ??= readFile(program.file).then((bytes) => ({
				bytes,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			}));
			let read: { readonly bytes: Uint8Array; readonly sha256: string };
			try {
				read = await file;
			} catch (cause) {
				// Not kept: a later start reads the file again, once it is there.
				file = undefined;
				const message = cause instanceof Error ? cause.message : String(cause);
				return err(new MoveError("prepare", `could not read the runner file ${program.file}: ${message}`));
			}
			const { bytes, sha256 } = read;
			const target = posix.join(posix.dirname(place.store), `runner-${sha256}.mjs`);
			const held = await output(
				box,
				["sh", "-c", 'test -f "$1" && sha256sum "$1" | cut -d" " -f1', "sh", target],
				context,
			);
			if (!held.ok || held.value !== sha256) {
				const uploaded = await box.upload([{ path: target, bytes }], context);
				if (!uploaded.ok) {
					return err(
						new MoveError("prepare", `could not upload the runner to ${box.id}: ${uploaded.error.message}`),
					);
				}
			}
			argv = ["node", target];
		} else {
			argv = program.argv;
		}
		const started = await box.exec(
			[
				...argv,
				...["--session", options.session, "--store", place.store, "--workspace", place.workspace],
				...["--environment", place.environment, "--provider", place.provider],
			],
			undefined,
			context,
		);
		if (!started.ok)
			return err(new MoveError("prepare", `could not start the runner in ${box.id}: ${started.error.message}`));
		const process = started.value;
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of process.stderr) options.onErrors?.(decoder.decode(chunk, { stream: true }));
		})().catch(() => {});
		return ok(
			connectHome(processLink(process), {
				models: options.models,
				epoch,
				...(options.records === undefined ? {} : { records: options.records }),
				...(options.crossing === undefined
					? {}
					: {
							crossing: options.crossing,
							crossingFor: { session: options.session, box: place.box.id },
							crossingCount: counter,
						}),
			}),
		);
	};
}
