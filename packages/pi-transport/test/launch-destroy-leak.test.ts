// A box that is destroyed ends every program a launch started in it, a program deaf to SIGTERM that cleared its environment
// included, with or without setsid, and whether or not the launch's runner is still there. Checked by process group in /proc,
// never by time: a destroy returns once what it killed is gone.
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
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
const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-destroy-"));
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

/** Every live (not zombie) process in process group `pgid`. */
function liveMembers(pgid: number): number[] {
	const members: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		const fields = statFields(Number(name));
		if (fields && Number(fields[2]) === pgid && fields[0] !== "Z") members.push(Number(name));
	}
	return members;
}

async function boxOn(setsid: boolean): Promise<Box> {
	const dirs = ["/usr/local/bin", "/usr/bin", "/bin"];
	let path: string | undefined;
	if (!setsid) {
		const bin = mkdtempSync(join(root, "bin-"));
		for (const dir of dirs.filter((dir) => existsSync(dir)))
			for (const name of readdirSync(dir))
				if (name !== "setsid" && !existsSync(join(bin, name))) symlinkSync(join(dir, name), join(bin, name));
		path = bin;
	}
	return getOrThrow(
		await localBoxes({ root: mkdtempSync(join(root, "box-")), ...(path ? { path } : {}) }).create(
			{ maxLifetimeMs: 600_000 },
			context,
		),
	);
}

async function fileIn(box: Box, path: string): Promise<string | undefined> {
	const read = await box.download([path], context);
	return read.ok ? new TextDecoder().decode(read.value[0]!.bytes).trim() || undefined : undefined;
}

describe("a destroyed box ends what its launches started", () => {
	for (const setsid of [true, false])
		for (const runnerGone of [false, true])
			it(`a program deaf to SIGTERM, never stopped, leaves no process of its group (${setsid ? "with" : "without"} setsid, its runner ${runnerGone ? "gone first" : "there"})`, async () => {
				const box = await boxOn(setsid);
				let pgid: number | undefined;
				try {
					getOrThrow(
						await launch(
							box,
							"deaf",
							{ argv: ["sh", "-c", "trap '' TERM; sleep 300 & echo $! > child.pid; echo $$ > prog.pid; while :; do sleep 1; done"] },
							context,
						),
					);
					const program = Number(await until("the program's id", () => fileIn(box, "prog.pid")));
					await until("the child's id", () => fileIn(box, "child.pid"));
					pgid = Number(statFields(program)?.[2]);
					expect(pgid).toBeGreaterThan(1);
					if (runnerGone) {
						// What a stop that died, or a runner killed under load, leaves: the program with no runner over it.
						for (const pid of liveMembers(pgid))
							if (pid !== program && !/^sleep\b/.test(readFileSync(`/proc/${pid}/cmdline`, "latin1"))) process.kill(pid, "SIGKILL");
						for (const name of readdirSync("/proc")) {
							if (!/^\d+$/.test(name)) continue;
							let cmd = "";
							try {
								cmd = readFileSync(`/proc/${name}/cmdline`, "latin1");
							} catch {
								continue;
							}
							if (cmd.includes(box.id) && cmd.includes("launcher.sh") && Number(name) !== program) {
								try {
									process.kill(Number(name), "SIGKILL");
								} catch {
									// already gone
								}
							}
						}
					}
				} finally {
					await box.destroy(context);
				}
				expect(liveMembers(pgid!)).toEqual([]);
			}, 60_000);
});

// Nothing this file started outlives it, whatever a test above did: no process works in a directory under its root.
afterAll(() => {
	const left: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		let cwd = "";
		try {
			cwd = readlinkSync(`/proc/${name}/cwd`);
		} catch {
			continue;
		}
		if (cwd.startsWith(root) && statFields(Number(name))?.[0] !== "Z") left.push(Number(name));
	}
	expect(left).toEqual([]);
});
