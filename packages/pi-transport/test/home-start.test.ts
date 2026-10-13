import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import type { Place } from "../src/home/move.ts";
import { boxRunner } from "../src/home/start.ts";

const context = BACKGROUND_CONTEXT;

/** A runner file of a few lines: it answers the host's hello and nothing more, which is all starting needs. */
const STUB = `process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (text) => {
	buffer += text;
	for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
		const frame = JSON.parse(buffer.slice(0, at));
		buffer = buffer.slice(at + 1);
		if (frame.t === "hello") process.stdout.write(JSON.stringify({ t: "ready", v: 1, ok: true, session: "s", state: "closed", epoch: null }) + "\\n");
	}
});
`;

/** A local box whose programs find their tools on `path`, with a place in it, and a count of its uploads. */
async function withPlace(path: string | undefined, use: (place: Place, uploads: () => number) => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-start-"));
	const inner = getOrThrow(
		await localBoxes({ root, ...(path === undefined ? {} : { path }) }).create(
			{ maxLifetimeMs: 10 * 60_000 },
			context,
		),
	);
	let uploads = 0;
	const box: Box = {
		id: inner.id,
		facts: () => inner.facts(),
		exec: (command, options, execContext) => inner.exec(command, options, execContext),
		status: (statusContext) => inner.status(statusContext),
		upload: (files, uploadContext) => {
			uploads += files.length;
			return inner.upload(files, uploadContext);
		},
		download: (paths, downloadContext) => inner.download(paths, downloadContext),
		destroy: (destroyContext) => inner.destroy(destroyContext),
	};
	const workspace = box.facts().workspace;
	try {
		await use(
			{
				environment: "a",
				provider: "local",
				box,
				workspace,
				store: join(dirname(workspace), "session", "run.sqlite"),
			},
			() => uploads,
		);
	} finally {
		await inner.destroy(context);
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

describe("starting a runner in a box", () => {
	it("uploads the runner file once, by its hash, and starts it with the box's own node", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-runner-file-"));
		try {
			const file = join(directory, "runner.mjs");
			writeFileSync(file, STUB);
			// The box finds this machine's node on its path.
			await withPlace(`${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, async (place, uploads) => {
				const start = boxRunner({ program: { file }, session: "s", models: createModels() });
				const first = getOrThrow(await start(place, 1, context));
				expect(getOrThrow(await first.ready).state).toBe("closed");
				first.close("done");
				const second = getOrThrow(await start(place, 1, context));
				expect(getOrThrow(await second.ready).state).toBe("closed");
				second.close("done");
				expect(uploads()).toBe(1);
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	it("refuses a box with no node, and one whose node is older than 22.19, before anything is uploaded", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-old-node-"));
		try {
			mkdirSync(join(directory, "bin"));
			writeFileSync(join(directory, "bin", "node"), "#!/bin/sh\necho 22.18.0\n");
			chmodSync(join(directory, "bin", "node"), 0o755);
			const program = { file: join(directory, "runner.mjs") };
			writeFileSync(program.file, STUB);
			// A path that holds a shell and no node, and one whose node is too old.
			mkdirSync(join(directory, "shell"));
			symlinkSync("/bin/sh", join(directory, "shell", "sh"));
			for (const path of [join(directory, "shell"), `${join(directory, "bin")}:/usr/bin:/bin`]) {
				await withPlace(path, async (place, uploads) => {
					const started = await boxRunner({ program, session: "s", models: createModels() })(place, 1, context);
					expect(started.ok ? "" : started.error.code).toBe("no_runtime");
					expect(uploads()).toBe(0);
				});
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);
});
