import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { describe, expect, it, vi } from "vitest";
import { openHome } from "../src/home/run.ts";

const context = BACKGROUND_CONTEXT;

/** Every rename and every sync of a file handle the home makes, in order. */
const calls = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: async (...args: Parameters<typeof actual.rename>) => {
			calls.push(`rename ${String(args[1])}`);
			return actual.rename(...args);
		},
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const sync = handle.sync.bind(handle);
			handle.sync = async () => {
				calls.push(`sync ${String(args[0])}`);
				return sync();
			};
			return handle;
		},
	};
});

describe("a home's marker", () => {
	// A rename reaches the disk with its directory: a seal whose marker was renamed and not synced can be lost.
	it("is written whole and kept: the directory that holds it is synced after the rename", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-marker-"));
		try {
			const store = join(directory, "session", "run.sqlite");
			const workspace = join(directory, "workspace");
			mkdirSync(workspace);
			const home = getOrThrow(
				await openHome({
					app: () => ({ registry: createRegistry() }),
					session: "s",
					store,
					workspace,
					where: { environment: "a", provider: "local" },
					models: createModels(),
				}),
			);
			calls.length = 0;
			getOrThrow(await home.resume({ epoch: 1 }, context));
			const renamed = calls.indexOf(`rename ${store}.home.json`);
			expect(renamed, calls.join("; ")).toBeGreaterThanOrEqual(0);
			expect(calls.slice(renamed + 1), calls.join("; ")).toContain(`sync ${dirname(store)}`);
			await home.close(context);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
