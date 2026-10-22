// The launcher's own subpath (`@parcha/pi-transport/launch`, T3): the handle a caller keeps, the state's incarnation and
// restarts, the program's environment (nothing of the box's own unless named), the refusal of key-shaped settings, and a
// Box that launches natively (`box.launcher`, read on every call).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow, ok } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import * as api from "../src/launch/index.ts";
import {
	type Launch,
	LaunchError,
	type LaunchSpec,
	type LaunchState,
	launch,
	launchState,
	launchStop,
} from "../src/launch/index.ts";
import { until } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function aBox(env?: Readonly<Record<string, string>>): Promise<Box> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-api-"));
	roots.push(root);
	return getOrThrow(
		await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000, ...(env ? { env } : {}) }, context),
	);
}

async function fileIn(box: Box, path: string): Promise<string | undefined> {
	const read = await box.download([path], context);
	return read.ok ? new TextDecoder().decode(read.value[0]!.bytes) : undefined;
}

describe("the launcher's subpath", () => {
	it("exports launch, launchState and launchStop beside today's names, and the package names ./launch", () => {
		for (const name of ["launch", "launchState", "launchStop", "launchStatus", "stopLaunch"]) {
			expect(typeof (api as Record<string, unknown>)[name]).toBe("function");
		}
		expect(api.LaunchError).toBe(LaunchError);
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			exports: Record<string, unknown>;
		};
		expect(manifest.exports["./launch"]).toEqual({
			source: "./src/launch/index.ts",
			types: "./dist/launch/index.d.ts",
			import: "./dist/launch/index.js",
			default: "./dist/launch/index.js",
		});
	});
});

describe("a launch's handle and state", () => {
	it("carries the handle { v: 1, name }, and counts incarnations and restarts", async () => {
		const box = await aBox();
		// The first incarnation exits 3 (restarted), the second keeps running.
		const spec: LaunchSpec = { argv: ["sh", "-c", "if [ -e once ]; then exec sleep 300; fi; : > once; exit 3"] };
		const first = getOrThrow(await launch(box, "counted", spec, context));
		expect(first.launch).toEqual({ v: 1, name: "counted" });
		const handle: Launch = first.launch;
		const second = await until("the second incarnation", async () => {
			const read = getOrThrow(await launchState(box, handle, context));
			return read?.phase === "running" && read.incarnation === 2 ? read : undefined;
		});
		expect(second.restarts).toBe(1);
		expect(second.starts).toBe(2);
		expect(second.lastExit).toBe(3);
		const stopped = getOrThrow(await launchStop(box, handle, { graceMs: 1_000 }, context));
		expect(stopped.phase).toBe("stopped");
		expect(stopped.launch).toEqual(handle);
		expect(getOrThrow(await launchState(box, { v: 1, name: "never-launched" }, context))).toBeUndefined();
		await box.destroy(context);
	});
});

describe("the program's environment", () => {
	const program = ["sh", "-c", "env > seen-env; exec sleep 300"];

	it("is PATH, HOME, LANG, the incarnation and the spec's settings: nothing of the box's own (inheritEnv false by default)", async () => {
		const box = await aBox({ BOX_PLAIN_SETTING: "from-the-box" });
		getOrThrow(await launch(box, "bare", { argv: program, env: { APP_MODE: "home" } }, context));
		const seen = await until("the program's environment", () => fileIn(box, "seen-env"));
		const names = seen
			.split("\n")
			.filter(Boolean)
			.map((line) => line.slice(0, line.indexOf("=")))
			.sort();
		expect(names).toEqual(["APP_MODE", "HOME", "LANG", "PATH", "PI_TRANSPORT_INCARNATION", "PWD"].sort());
		expect(seen).toContain("LANG=C.UTF-8\n");
		expect(seen).toContain("PI_TRANSPORT_INCARNATION=1\n");
		expect(seen).toContain("APP_MODE=home\n");
		getOrThrow(await launchStop(box, { v: 1, name: "bare" }, { graceMs: 1_000 }, context));
		await box.destroy(context);
	});

	it("passes exactly the names inheritEnv lists, and refuses a name it also sets", async () => {
		const box = await aBox({ BOX_PLAIN_SETTING: "from-the-box", BOX_OTHER: "not-asked" });
		getOrThrow(
			await launch(box, "inherits", { argv: program, inheritEnv: ["BOX_PLAIN_SETTING", "BOX_ABSENT"] }, context),
		);
		const seen = await until("the program's environment", () => fileIn(box, "seen-env"));
		expect(seen).toContain("BOX_PLAIN_SETTING=from-the-box\n");
		expect(seen).not.toContain("BOX_OTHER");
		expect(seen).not.toContain("BOX_ABSENT");
		getOrThrow(await launchStop(box, { v: 1, name: "inherits" }, { graceMs: 1_000 }, context));
		const both = await launch(box, "both", { argv: program, env: { SHARED: "a" }, inheritEnv: ["SHARED"] }, context);
		expect(both.ok ? undefined : both.error.code).toBe("invalid");
		const named = await launch(box, "badname", { argv: program, inheritEnv: ["not a name"] }, context);
		expect(named.ok ? undefined : named.error.code).toBe("invalid");
		await box.destroy(context);
	});

	it("refuses a key-shaped setting, naming the variable and never its value, and the names the launcher sets", async () => {
		const box = await aBox();
		for (const name of [
			"MODAL_TOKEN_ID",
			"ANTHROPIC_API_KEY",
			"DB_PASSWORD",
			"GH_TOKEN",
			"app_secret",
			"AWS_CREDENTIALS",
		]) {
			const refused = await launch(box, "keyed", { argv: program, env: { [name]: "zz-the-value-zz" } }, context);
			expect(refused.ok).toBe(false);
			if (refused.ok) continue;
			expect(refused.error.code).toBe("invalid");
			expect(refused.error.message).toContain(name);
			expect(refused.error.message).not.toContain("zz-the-value-zz");
		}
		for (const name of ["PATH", "HOME", "LANG", "PI_TRANSPORT_INCARNATION"]) {
			const refused = await launch(box, "reserved", { argv: program, env: { [name]: "x" } }, context);
			expect(refused.ok ? undefined : refused.error.code).toBe("invalid");
		}
		// A name with a key-like word that is not a segment passes.
		getOrThrow(await launch(box, "keyboard", { argv: program, env: { KEYBOARD: "us", MONKEY: "yes" } }, context));
		getOrThrow(await launchStop(box, { v: 1, name: "keyboard" }, { graceMs: 1_000 }, context));
		await box.destroy(context);
	});
});

describe("a Box that launches natively", () => {
	it("is used for every call, read again each time: a Box an attach returns is a new object", async () => {
		const calls: string[] = [];
		const state = (name: string): LaunchState => ({
			launch: { v: 1, name },
			phase: "running",
			incarnation: 1,
			restarts: 0,
			starts: 1,
			since: 0,
			launcherAlive: true,
			directory: "native",
		});
		const native = (tag: string) => ({
			launch: async (name: string) => {
				calls.push(`${tag} launch ${name}`);
				return ok(state(name));
			},
			state: async (handle: Launch) => {
				calls.push(`${tag} state ${handle.name}`);
				return ok(state(handle.name));
			},
			stop: async (handle: Launch) => {
				calls.push(`${tag} stop ${handle.name}`);
				return ok({ ...state(handle.name), phase: "stopped" as const });
			},
		});
		const holder: { id: string; launcher: unknown } = { id: "native-box", launcher: native("first") };
		const box = holder as unknown as Box;
		getOrThrow(await launch(box, "n", { argv: ["true"] }, context));
		holder.launcher = native("second");
		getOrThrow(await launchState(box, { v: 1, name: "n" }, context));
		getOrThrow(await api.launchStatus(box, "n", context));
		getOrThrow(await launchStop(box, { v: 1, name: "n" }, undefined, context));
		getOrThrow(await api.stopLaunch(box, "n", undefined, context));
		expect(calls).toEqual(["first launch n", "second state n", "second state n", "second stop n", "second stop n"]);
	});
});
