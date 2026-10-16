// A runner for the box place's pool case: its tool box comes from the host (`AppContext.boxes`), never from a
// credential of its own. It writes what it was given (its process's environment and the order's) into its workspace,
// makes a pool box, writes a tile there, starts a long program in it and asks to be killed with that program running.
// A runner that comes back finds the pool box by the label its store kept, and reads the tile.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry, defineDocFamily, type JsonObject } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { readStream } from "../src/box/files.ts";
import type { App } from "../src/home/app.ts";
import { runMain } from "../src/home/main.ts";

const Pool = defineDocFamily<JsonObject, null>({
	kind: "fixture.pool",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({}),
});

const app: App = (ctx) => ({
	registry: createRegistry(),
	async onResumed(harness, context) {
		const { env } = ctx;
		writeFileSync(
			join(ctx.workspace, `seen-${ctx.epoch}.json`),
			JSON.stringify({ process: process.env, order: env, boxes: Object.keys(ctx.boxes) }),
		);
		const provider = ctx.boxes.secret;
		if (provider === undefined) throw new Error("the host serves no 'secret' provider");
		const label = ((await harness.snapshot(Pool, "pool", context)) as { label?: string } | undefined)?.label;
		if (label === undefined) {
			const box = getOrThrow(await provider.create({ maxLifetimeMs: 10 * 60_000 }, context));
			await harness.commit(async (tx) => {
				(await tx.doc(Pool, "pool", null)).label = box.id;
			}, context);
			const tile = getOrThrow(await box.exec(["sh", "-c", "echo tile-1 > tile.txt"], undefined, context));
			await Promise.all([readStream(tile.stdout), readStream(tile.stderr)]);
			getOrThrow(await tile.wait());
			// The next tile runs when the home box is lost.
			void box.exec(["sleep", "30"], undefined, context);
			if (env.KILL_REQUEST !== undefined) {
				writeFileSync(
					`${env.KILL_REQUEST}.tmp`,
					JSON.stringify({ point: "fixture.tile", n: 2, nonce: env.KILL_NONCE }),
				);
				renameSync(`${env.KILL_REQUEST}.tmp`, env.KILL_REQUEST);
			}
			return await new Promise<never>(() => {});
		}
		const found = getOrThrow(await provider.attach(label, context));
		let tile: string | null = null;
		if (found !== undefined) {
			const read = getOrThrow(await found.exec(["cat", "tile.txt"], undefined, context));
			const [out] = await Promise.all([readStream(read.stdout), readStream(read.stderr)]);
			getOrThrow(await read.wait());
			tile = new TextDecoder().decode(out).trim();
		}
		console.log(
			JSON.stringify({
				outcome: {
					status: "complete",
					generation: ctx.epoch,
					record: { label, attached: found !== undefined, tile, boxes: Object.keys(ctx.boxes) },
				},
			}),
		);
	},
});

await runMain(app);
