// A box's watchdog, at the end of its lifetime, ends every program a launch started, whatever hid it: a box root reached
// through a symbolic link, a program that left the box's directory but shares its runner's process group, and never the
// process group of the host that made the box. Checked by process in /proc, never by time alone.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { launch } from "../src/launch/index.ts";
import { until } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const root = mkdtempSync(join(tmpdir(), "pi-transport-box-expiry-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

/** The fields of /proc/<pid>/stat after the name: [state, ppid, pgrp, ...], or undefined once the process is gone. */
function statFields(pid: number): string[] | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
		return stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
	} catch {
		return undefined;
	}
}
const running = (pid: number) => {
	const state = statFields(pid)?.[0];
	return state !== undefined && state !== "Z";
};

/** Every launcher of `box` still running, read from /proc: what a stop that died, or a runner killed under load, removes. */
function killRunners(box: Box, keep: number): void {
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name) || Number(name) === keep) continue;
		let cmd = "";
		try {
			cmd = readFileSync(`/proc/${name}/cmdline`, "latin1");
		} catch {
			continue;
		}
		if (cmd.includes(box.id) && cmd.includes("launcher.sh")) {
			try {
				process.kill(Number(name), "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
}

async function fileIn(box: Box, path: string): Promise<string | undefined> {
	const read = await box.download([path], context);
	return read.ok ? new TextDecoder().decode(read.value[0]!.bytes).trim() || undefined : undefined;
}

/** A PATH with every program of the system's directories but setsid, so a launch's program shares its runner's group. */
function pathWithoutSetsid(): string {
	const bin = mkdtempSync(join(root, "bin-"));
	for (const dir of ["/usr/local/bin", "/usr/bin", "/bin"].filter((dir) => existsSync(dir)))
		for (const name of readdirSync(dir))
			if (name !== "setsid" && !existsSync(join(bin, name))) symlinkSync(join(dir, name), join(bin, name));
	return bin;
}

const DEAF = "trap '' TERM; echo $$ > prog.pid; while :; do sleep 1; done";

describe("a box's watchdog at the end of its lifetime", () => {
	it("ends a program on a box root reached through a symbolic link, with its runner gone", async () => {
		const real = mkdtempSync(join(root, "real-"));
		const linked = join(root, `link-${Math.random().toString(16).slice(2)}`);
		symlinkSync(real, linked);
		const box = getOrThrow(await localBoxes({ root: linked }).create({ maxLifetimeMs: 6_000 }, context));
		getOrThrow(await launch(box, "deaf", { argv: ["sh", "-c", DEAF] }, context));
		const program = Number(await until("the program's id", () => fileIn(box, "prog.pid")));
		killRunners(box, program);
		await until("the box's end", async () => (existsSync(join(real, box.id)) ? undefined : true), 30_000);
		await until("the program's end", async () => (running(program) ? undefined : true), 10_000).catch(() => {});
		expect(running(program)).toBe(false);
	}, 60_000);

	it("ends a program that left the box's directory but shares its runner's group (no setsid)", async () => {
		const boxes = mkdtempSync(join(root, "boxes-"));
		const outside = mkdtempSync(join(root, "outside-"));
		const box = getOrThrow(
			await localBoxes({ root: boxes, path: pathWithoutSetsid() }).create({ maxLifetimeMs: 6_000 }, context),
		);
		getOrThrow(
			await launch(
				box,
				"away",
				{ argv: ["sh", "-c", `${DEAF.replace("prog.pid", `'${outside}/prog.pid'`)}`], cwd: outside },
				context,
			),
		);
		const program = Number(
			await until("the program's id", async () =>
				existsSync(join(outside, "prog.pid"))
					? readFileSync(join(outside, "prog.pid"), "utf8").trim() || undefined
					: undefined,
			),
		);
		await until("the box's end", async () => (existsSync(join(boxes, box.id)) ? undefined : true), 30_000);
		await until("the program's end", async () => (running(program) ? undefined : true), 10_000).catch(() => {});
		expect(running(program)).toBe(false);
	}, 60_000);

	it("never ends the host that made the box, even when a helper in the host's own group works inside it", async () => {
		const boxes = mkdtempSync(join(root, "host-"));
		const host = join(boxes, "host.mts");
		// The host: makes a box, starts a helper in its own process group working in the box's workspace, and stays.
		writeFileSync(
			host,
			`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { localBoxes } from ${JSON.stringify(join(import.meta.dirname, "../src/box/local.ts"))};
import { BACKGROUND_CONTEXT } from ${JSON.stringify(import.meta.resolve("@earendil-works/chord/context"))};
const created = await localBoxes({ root: ${JSON.stringify(boxes)} }).create({ maxLifetimeMs: 2_000 }, BACKGROUND_CONTEXT);
if (!created.ok) throw created.error;
const workspace = ${JSON.stringify(boxes)} + "/" + created.value.id + "/workspace";
const helper = spawn("sleep", ["120"], { cwd: workspace, stdio: "ignore" });
writeFileSync(${JSON.stringify(join(boxes, "ready"))}, created.value.id + " " + helper.pid);
setInterval(() => {}, 1000);
`,
		);
		// Its own process group (detached), so the test's own is never at stake, and the test ends it by that group.
		const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", host], {
			cwd: join(import.meta.dirname, ".."),
			stdio: "ignore",
			detached: true,
		});
		const hostPid = child.pid!;
		try {
			const ready = await until(
				"the host's box",
				async () => (existsSync(join(boxes, "ready")) ? readFileSync(join(boxes, "ready"), "utf8") : undefined),
				60_000,
			);
			const [id] = ready.split(" ");
			await until("the box's end", async () => (existsSync(join(boxes, id!)) ? undefined : true), 30_000);
			expect(running(hostPid)).toBe(true);
		} finally {
			try {
				process.kill(-hostPid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}, 120_000);
});
