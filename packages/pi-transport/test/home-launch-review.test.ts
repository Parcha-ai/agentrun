import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import { type Box, BoxError } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { launch, launchStatus, stopLaunch } from "../src/home/launch.ts";
import { LAUNCHER_SCRIPT } from "../src/home/launcher-script.ts";
import { recording, sh, until } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const HAS_PROC = existsSync("/proc/self/stat");

async function withLocalBox(use: (box: Box) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-review-"));
	const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
	try {
		await use(box);
	} finally {
		await box.destroy(context);
		rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

const spoolOf = async (box: Box): Promise<string> =>
	`${(await sh(box, 't=$TMPDIR; [ -n "$t" ] || t=/tmp; echo "$t"')).text.trim()}/.pi-transport-launch`;

describe("a launch in a box: callers that meet", () => {
	it("starts over a claim whose caller never filled it", async () => {
		await withLocalBox(async (box) => {
			const spool = await spoolOf(box);
			// A caller that claimed the directory long ago and died before its upload.
			await sh(box, `mkdir -p -m 700 ${spool}/abandoned && echo 1 > ${spool}/abandoned/claimed.at`);
			const state = getOrThrow(
				(await launch(box, "abandoned", { argv: ["sh", "-c", recording("exec sleep 300")] }, context)) as never,
			) as { phase: string; starts: number };
			expect(state.phase).toBe("running");
			expect(state.starts).toBe(1);
		});
	}, 60_000);

	it("gives a claim back when the upload fails, so the next launch of the name does not wait", async () => {
		await withLocalBox(async (box) => {
			const broken: Box = {
				id: box.id,
				facts: () => box.facts(),
				exec: (command, options, ctx) => box.exec(command, options, ctx),
				upload: async () => err(new BoxError("unknown", "disk full")),
				download: (paths, ctx) => box.download(paths, ctx),
				status: (ctx) => box.status(ctx),
				destroy: (ctx) => box.destroy(ctx),
			};
			const failed = await launch(broken, "refused", { argv: ["sleep", "300"] }, context);
			expect(failed.ok).toBe(false);
			const state = getOrThrow((await launch(box, "refused", { argv: ["sleep", "300"] }, context)) as never) as {
				phase: string;
			};
			expect(state.phase).toBe("running");
		});
	}, 60_000);

	it("starts one program when several callers relaunch a launch that ended", async () => {
		await withLocalBox(async (box) => {
			getOrThrow((await launch(box, "again", { argv: ["sh", "-c", "exit 0"], restart: false }, context)) as never);
			await until("the first launch to end", async () => {
				const status = getOrThrow((await launchStatus(box, "again", context)) as never) as
					| { phase: string }
					| undefined;
				return status?.phase === "exited" ? true : undefined;
			});
			const results = await Promise.all(
				[1, 2, 3, 4].map(() => launch(box, "again", { argv: ["sh", "-c", recording("exec sleep 300")] }, context)),
			);
			for (const result of results) expect(getOrThrow(result as never)).toMatchObject({ phase: "running" });
			await until("one recorded program", async () =>
				(await sh(box, "cat prog.pids")).text.trim() !== "" ? true : undefined,
			);
			expect((await sh(box, "cat prog.pids | wc -l")).text.trim()).toBe("1");
		});
	}, 120_000);

	it("starts one program when several callers revive a launch whose launcher was killed", async () => {
		await withLocalBox(async (box) => {
			const spec = { argv: ["sh", "-c", recording("exec sleep 300")] };
			const first = getOrThrow((await launch(box, "revive", spec, context)) as never) as { directory: string };
			// The launcher, its watchdog and the program all die, as in a restarted sandbox.
			const killed = await sh(
				box,
				`D=${first.directory}; kill -s KILL $(cat $D/launcher.pid) $(cat $D/watch.pid) 2>/dev/null; kill -s KILL -- -$(cat $D/pid.1) 2>/dev/null; sleep 0.5; echo done`,
			);
			expect(killed.text).toContain("done");
			const results = await Promise.all([1, 2, 3, 4].map(() => launch(box, "revive", spec, context)));
			for (const result of results) expect(getOrThrow(result as never)).toMatchObject({ phase: expect.any(String) });
			await until("the program to run again", async () =>
				(await sh(box, "cat prog.pids | wc -l")).text.trim() === "2" ? true : undefined,
			);
			await new Promise((resolve) => setTimeout(resolve, 1500));
			expect((await sh(box, "cat prog.pids | wc -l")).text.trim()).toBe("2");
			const stopped = getOrThrow((await stopLaunch(box, "revive", undefined, context)) as never) as {
				phase: string;
			};
			expect(stopped.phase).toBe("stopped");
		});
	}, 120_000);

	it("replaces an ended launch even when another launch is named like its lock", async () => {
		await withLocalBox(async (box) => {
			getOrThrow((await launch(box, "runner", { argv: ["sh", "-c", "exit 0"], restart: false }, context)) as never);
			getOrThrow((await launch(box, "runner.lock", { argv: ["sleep", "300"] }, context)) as never);
			await until("the first launch to end", async () => {
				const status = getOrThrow((await launchStatus(box, "runner", context)) as never) as
					| { phase: string }
					| undefined;
				return status?.phase === "exited" ? true : undefined;
			});
			const again = getOrThrow((await launch(box, "runner", { argv: ["sleep", "300"] }, context)) as never) as {
				phase: string;
			};
			expect(again.phase).toBe("running");
		});
	}, 120_000);

	it("does not let a caller whose slow upload lost its claim publish over the one that took it", async () => {
		await withLocalBox(async (box) => {
			const spool = await spoolOf(box);
			let second: Promise<unknown> | undefined;
			const slow: Box = {
				id: box.id,
				facts: () => box.facts(),
				exec: (command, options, ctx) => box.exec(command, options, ctx),
				upload: async (files, ctx) => {
					// While this upload is under way its claim looks a minute old, and another caller takes it over.
					await sh(box, `echo 1 > ${spool}/slowpoke/claimed.at`);
					second = launch(
						box,
						"slowpoke",
						{ argv: ["sh", "-c", "echo second >> prog.pids; exec sleep 300"] },
						context,
					);
					await second;
					return box.upload(files, ctx);
				},
				download: (paths, ctx) => box.download(paths, ctx),
				status: (ctx) => box.status(ctx),
				destroy: (ctx) => box.destroy(ctx),
			};
			const first = await launch(
				slow,
				"slowpoke",
				{ argv: ["sh", "-c", "echo first >> prog.pids; exec sleep 300"] },
				context,
			);
			expect(first.ok).toBe(false);
			const state = getOrThrow((await launchStatus(box, "slowpoke", context)) as never) as { phase: string };
			expect(state.phase).toBe("running");
			await new Promise((resolve) => setTimeout(resolve, 1500));
			expect((await sh(box, "cat prog.pids")).text.trim()).toBe("second");
			expect(await sh(box, `ls ${spool}/slowpoke/launcher.sh`)).toMatchObject({ exitCode: 0 });
		});
	}, 120_000);

	it("keeps the output of a program that wrote more than the limit and exited at once under the limit", async () => {
		await withLocalBox(async (box) => {
			const state = getOrThrow(
				(await launch(
					box,
					"chatty",
					{ argv: ["sh", "-c", "head -c 3000000 /dev/zero | tr '\\0' x; exit 0"], logMaxBytes: 4096 },
					context,
				)) as never,
			) as { directory: string };
			await until("a log within the limit", async () => {
				const size = Number((await sh(box, `wc -c < ${state.directory}/out.log`)).text.trim());
				return size <= 4096 ? size : undefined;
			});
		});
	}, 60_000);
});

describe("stopping a launch", () => {
	it("gives the stop call the grace period and more, and refuses a grace that is not a sensible number", async () => {
		await withLocalBox(async (box) => {
			getOrThrow((await launch(box, "slow", { argv: ["sh", "-c", "exec sleep 300"] }, context)) as never);
			const seen: (number | undefined)[] = [];
			const watching: Box = {
				id: box.id,
				facts: () => box.facts(),
				exec: (command, options, ctx) => {
					if (command.join(" ").includes(" stop ")) seen.push(options?.timeoutMs);
					return box.exec(command, options, ctx);
				},
				upload: (files, ctx) => box.upload(files, ctx),
				download: (paths, ctx) => box.download(paths, ctx),
				status: (ctx) => box.status(ctx),
				destroy: (ctx) => box.destroy(ctx),
			};
			getOrThrow((await stopLaunch(watching, "slow", { graceMs: 60_000 }, context)) as never);
			expect(seen).toHaveLength(1);
			expect(seen[0] ?? 0).toBeGreaterThan(60_000);
			for (const graceMs of [-1, Number.NaN, 1e12]) {
				const refused = await stopLaunch(box, "slow", { graceMs }, context);
				expect(refused.ok ? "ok" : (refused.error as { code: string }).code).toBe("invalid");
			}
		});
	}, 60_000);
});

describe.skipIf(!HAS_PROC)("the launcher's own sections", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-launcher-sections-"));
	const dir = (name: string, spec: string): string => {
		const d = join(root, name);
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, "launcher.sh"), LAUNCHER_SCRIPT);
		writeFileSync(join(d, "spec.sh"), spec);
		return d;
	};
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

	it("starts nothing for a wrapper that comes up after a stop was asked for", () => {
		const d = dir("stopped-first", "GEN='g1'\nrun_program() {\n  echo started >> marker\n  exec sleep 1\n}\n");
		writeFileSync(join(d, "stop.req"), "1\n");
		spawnSync("sh", [join(d, "launcher.sh"), "run", d, "1"], { env, timeout: 10_000 });
		expect(existsSync(join(d, "marker"))).toBe(false);
		expect(existsSync(join(d, "pid.1"))).toBe(false);
	});

	it("keeps the tail of the output when the watchdog and the end of a launch trim at the same moment", async () => {
		const d = dir("trim", "GEN='g3'\nLOGMAX=4096\n");
		for (let round = 0; round < 6; round++) {
			writeFileSync(join(d, "out.log"), `${"x".repeat(299_999)}\n`);
			await Promise.all(
				Array.from(
					{ length: 8 },
					() =>
						new Promise<void>((resolve) => {
							spawn("sh", [join(d, "launcher.sh"), "trim", d], { env, stdio: "ignore" }).on("close", () =>
								resolve(),
							);
						}),
				),
			);
			const size = statSync(join(d, "out.log")).size;
			expect(size).toBeGreaterThan(0);
			expect(size).toBeLessThanOrEqual(4096);
		}
	}, 120_000);

	it("signals a group only when its saved id still names the process this launch started", () => {
		const child = spawnSync("sh", ["-c", "setsid sleep 30 >/dev/null 2>&1 & echo $!"], { env, encoding: "utf8" });
		const pid = child.stdout.trim();
		try {
			const ticks = spawnSync("sh", ["-c", `sed 's/^.*) //' /proc/${pid}/stat | cut -d' ' -f20`], {
				encoding: "utf8",
			}).stdout.trim();
			const d = dir("own-group", "GEN='g2'\n");
			const owns = (id: string, saved: string) =>
				spawnSync("sh", [join(d, "launcher.sh"), "own-group", d, id, saved], { env }).status;
			expect(owns(pid, ticks)).toBe(0);
			// The id was reused by another job: a live process with another start time.
			expect(owns(pid, String(Number(ticks) + 1))).toBe(1);
			// Nothing holds the id: leftover children of a program whose leader ended are the launch's to clean up.
			expect(owns("2147483000", ticks)).toBe(0);
			expect(owns("", ticks)).toBe(1);
		} finally {
			spawnSync("kill", ["-s", "KILL", pid]);
		}
	});
});
