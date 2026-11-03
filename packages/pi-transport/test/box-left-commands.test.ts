import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, describe, expect, it } from "vitest";
import { dockerBoxes } from "../src/box/docker.ts";
import { endLeftCommands } from "../src/box/left-commands.ts";
import { localBoxes } from "../src/box/local.ts";
import { boxEnv } from "../src/hands/box-env.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-left-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const until = async (done: () => boolean, ms = 10_000) => {
	const end = Date.now() + ms;
	while (!done()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};

describe("endLeftCommands: the commands a gone host left running in its box", () => {
	it("kills each command group boxEnv wrote down, which then never finishes, and forgets it", async () => {
		const provider = localBoxes({ root });
		const made = await provider.create({ maxLifetimeMs: 60_000 }, context);
		if (!made.ok) throw made.error;
		const box = made.value;
		const late = join(box.facts().workspace, "late.txt");
		// The host that started it: its command runs until something ends it.
		const left = boxEnv(box).exec(`sleep 20; touch ${late}`, {}, context);
		const pids = join(root, box.id, "tmp", ".pi-transport");
		await until(() => existsSync(pids) && readdirSync(pids).some((name) => name.endsWith(".pid")));
		// The host that takes the box over.
		const attached = await provider.attach(box.id, context);
		if (!attached.ok || attached.value === undefined) throw new Error("not attached");
		const ended = await endLeftCommands(attached.value, context);
		expect(ended).toEqual({ ok: true, value: 1 });
		const result = await left;
		expect(result.ok ? result.value.exitCode : result.error.code).not.toBe(0);
		expect(readdirSync(pids).filter((name) => name.endsWith(".pid"))).toEqual([]);
		expect(existsSync(late)).toBe(false);
		// None left: a second call kills nothing.
		expect(await endLeftCommands(attached.value, context)).toEqual({ ok: true, value: 0 });
		await box.destroy(context);
	});
});

describe("endLeftCommands: a command whose session has not written its group yet", () => {
	it("leaves it a tombstone, so the session never runs its command, and kills nothing it cannot see", async () => {
		const provider = localBoxes({ root });
		const made = await provider.create({ maxLifetimeMs: 60_000 }, context);
		if (!made.ok) throw made.error;
		const box = made.value;
		const state = join(root, box.id, "tmp", ".pi-transport");
		mkdirSync(state, { recursive: true });
		// The session opened its group file and was cut before it wrote its group.
		writeFileSync(join(state, "cut.pid"), "");
		expect(await endLeftCommands(box, context)).toEqual({ ok: true, value: 0 });
		expect(existsSync(join(state, "cut.cancel"))).toBe(true);
		// The session goes on as boxEnv's does: it writes its group, finds the tombstone and ends without its command.
		const ran = join(box.facts().workspace, "ran.txt");
		const lead = await box.exec(
			[
				"sh",
				"-c",
				`echo $$ > "$1"; if [ -e "$2" ]; then rm -f "$1" "$2"; exit 130; fi; touch ${ran}`,
				"lead",
				join(state, "cut.pid"),
				join(state, "cut.cancel"),
			],
			undefined,
			context,
		);
		if (!lead.ok) throw lead.error;
		expect(await lead.value.wait()).toEqual({ ok: true, value: 130 });
		expect(existsSync(ran)).toBe(false);
		await box.destroy(context);
	});
});

describe("docker boxes: the user programs run as", () => {
	it("passes --user as given, and refuses a user that is not uid or uid:gid", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-transport-docker-user-"));
		try {
			const log = join(directory, "args.log");
			const script = join(directory, "docker");
			writeFileSync(script, `#!/bin/sh\necho "$@" >> ${log}\necho 0123456789abcdef\n`, { mode: 0o755 });
			const made = await dockerBoxes({ docker: script, user: "1000:1000" }).create(
				{ maxLifetimeMs: 60_000 },
				context,
			);
			expect(made.ok).toBe(true);
			expect(readFileSync(log, "utf8")).toContain("--user 1000:1000");
			expect(() => dockerBoxes({ docker: script, user: "root" })).toThrow(/not uid or uid:gid/);
			expect(() => dockerBoxes({ docker: script, user: "1000:1000 --privileged" })).toThrow(/not uid or uid:gid/);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
