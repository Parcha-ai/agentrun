// Guards of the launcher, each pinned by a case that fails by name when the guard is gone: the builtin printf a framed start
// needs, the launch frame's own checks, a discard only by the caller that holds the claim, a launch that meets a stop past its
// deadline, and a takeover that kills a hook still running.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { launch, launchStatus, launchStop } from "../src/launch/launch.ts";
import { LAUNCHER_SCRIPT, PTRACE_FILE_LINE } from "../src/launch/launcher-script.ts";
import { sh, spoolOf, until } from "./home-launch-support.ts";
import { guardLeaks } from "./leak-guard.ts";

const context = BACKGROUND_CONTEXT;
const { env: MARK } = guardLeaks();
const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-guards-"));
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", ...MARK };

const MAGIC = "PI-TRANSPORT-LAUNCH/1";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** A framed launch directory in a spool of its own, its ptrace scope read as 1, whose program records that it ran and exits 0. */
function framedLauncher(extraSpec = ""): { dir: string; marker: string } {
	const spool = mkdtempSync(join(root, "spool-"));
	const dir = join(spool, "d");
	mkdirSync(dir, { mode: 0o700 });
	const scope = join(spool, "scope");
	writeFileSync(scope, "1\n");
	expect(LAUNCHER_SCRIPT).toContain(PTRACE_FILE_LINE);
	writeFileSync(join(dir, "launcher.sh"), LAUNCHER_SCRIPT.replace(PTRACE_FILE_LINE, `PTRACE_FILE='${scope}'`));
	const marker = `${spool}.ran`;
	writeFileSync(
		join(dir, "spec.sh"),
		`GEN='g1'\nFRAMED=1\nISOLATION='none'\n${extraSpec}run_program() {\n  echo ran >> '${marker}'\n  exit 0\n}\n`,
	);
	return { dir, marker };
}

/** The launcher's start of `dir` with `frame` on its stdin, as the exec that starts a framed launch gives it. */
function start(dir: string, frame: string): { status: number | null; out: string } {
	const ran = spawnSync("sh", [join(dir, "launcher.sh"), "start", dir], {
		env,
		input: frame,
		encoding: "utf8",
		timeout: 30_000,
	});
	return { status: ran.status, out: ran.stdout };
}

describe("a framed start", () => {
	it("runs with a well-formed frame: the control the refusals below are measured against", async () => {
		const { dir, marker } = framedLauncher();
		const ran = start(dir, `${MAGIC}\n${b64('{"A":"b"}')}\n${b64("in")}\n`);
		expect(ran.status, ran.out).toBe(0);
		await until("the program", async () => (existsSync(marker) ? true : undefined));
		await until("the launch to end", async () => (existsSync(join(dir, "done")) ? true : undefined));
	});

	it("refuses where printf is not a shell builtin, before it reads the frame: the stdin could reach an argv", () => {
		// A function named printf, defined by the spec the launcher sources: what `command -V printf` sees is no builtin.
		const { dir, marker } = framedLauncher('printf() { command printf "$@"; }\n');
		const ran = start(dir, `${MAGIC}\n\n${b64("in")}\n`);
		expect(ran.status).toBe(10);
		expect(ran.out).toMatch(/^UNSUPPORTED printf is not a shell builtin in this box/m);
		expect(existsSync(join(dir, "launcher.pid"))).toBe(false);
		expect(existsSync(marker)).toBe(false);
	});

	it.each([
		["a wrong magic line", `PI-TRANSPORT-LAUNCH/2\n\n${b64("in")}\n`],
		["a character outside base64 in the secrets", `${MAGIC}\n${b64("s")}*\n${b64("in")}\n`],
		["a character outside base64 in the stdin", `${MAGIC}\n\n${b64("in")}$\n`],
		["a fourth line", `${MAGIC}\n\n${b64("in")}\nmore\n`],
		["an empty fourth line", `${MAGIC}\n\n${b64("in")}\n\n`],
		["a fourth line with no newline", `${MAGIC}\n\n${b64("in")}\nx`],
		["EOF after line 1", `${MAGIC}\n`],
		["EOF after line 2", `${MAGIC}\n\n`],
		["nothing in it", ""],
	])("refuses a frame with %s as invalid, and starts nothing", (_what, frame) => {
		const { dir, marker } = framedLauncher();
		const ran = start(dir, frame);
		expect(ran.status).toBe(7);
		expect(ran.out).toMatch(/^INVALID the launch frame is malformed/m);
		expect(existsSync(join(dir, "launcher.pid"))).toBe(false);
		expect(existsSync(marker)).toBe(false);
	});
});

async function aBox(): Promise<Box> {
	return getOrThrow(
		await localBoxes({ root: mkdtempSync(join(root, "box-")) }).create(
			{ maxLifetimeMs: 10 * 60_000, env: MARK },
			context,
		),
	);
}

/** Whether a process runs in the box (a zombie does not). */
async function alive(box: Box, pid: string): Promise<boolean> {
	return (
		(await sh(box, `kill -0 ${pid} 2>/dev/null && [ "$(sed 's/^.*) //' /proc/${pid}/stat | cut -c1)" != Z ]`))
			.exitCode === 0
	);
}

describe("a start the launcher refused", () => {
	// A user the box has not: the launcher refuses it in the box (INVALID), and the caller discards its claim.
	const spec = { argv: ["sleep", "300"], user: "zz-no-such-user" };
	const discards = (command: readonly string[]) => command.join(" ").includes('launcher.pid" ] && rm -rf');

	it("discards the claim of the caller that holds it: the name is free", async () => {
		const box = await aBox();
		try {
			const refused = await launch(box, "refused", spec, context);
			expect(refused.ok ? "ok" : refused.error.code).toBe("invalid");
			expect(getOrThrow(await launchStatus(box, "refused", context))).toBeUndefined();
		} finally {
			await box.destroy(context);
		}
	});

	it("leaves a claim another caller took over in between: a discard checks the owner token first", async () => {
		const box = await aBox();
		try {
			let seen = false;
			const overtaken: Box = {
				id: box.id,
				facts: () => box.facts(),
				exec: async (command, options, ctx) => {
					if (discards(command)) {
						seen = true;
						await sh(box, `echo another-callers-token > "${command[command.length - 2]}/owner"`);
					}
					return box.exec(command, options, ctx);
				},
				upload: (files, ctx) => box.upload(files, ctx),
				download: (paths, ctx) => box.download(paths, ctx),
				status: (ctx) => box.status(ctx),
				destroy: (ctx) => box.destroy(ctx),
			};
			const refused = await launch(overtaken, "overtaken", spec, context);
			expect(refused.ok ? "ok" : refused.error.code).toBe("invalid");
			expect(seen).toBe(true);
			const dir = `${await spoolOf(box)}/overtaken`;
			expect((await sh(box, `cat "${dir}/owner"`)).text.trim()).toBe("another-callers-token");
		} finally {
			await box.destroy(context);
		}
	});
});

describe("a stop that died", () => {
	/** What a stop that claimed `directory` and died leaves: its claim and a deadline long past, and no end. */
	const plantDeadStop = (box: Box, directory: string) =>
		sh(box, `: > "${directory}/stop.claimed" && echo 0 > "${directory}/stop.deadline"`);

	it("makes a launch of the name fail ('stop it again') past its deadline, and start nothing beside it", async () => {
		const box = await aBox();
		try {
			const spec = { argv: ["sh", "-c", "echo start >> starts; exit 0"], restart: false };
			const first = getOrThrow(await launch(box, "late", spec, context));
			await until("the first launch to end", async () =>
				getOrThrow(await launchStatus(box, "late", context))?.phase === "exited" ? true : undefined,
			);
			await plantDeadStop(box, first.directory);
			const answer = await Promise.race([
				launch(box, "late", spec, context),
				new Promise<"still waiting">((resolve) => setTimeout(() => resolve("still waiting"), 20_000)),
			]);
			expect(answer === "still waiting" ? answer : answer.ok ? "ok" : answer.error.code).toBe("failed");
			if (answer !== "still waiting" && !answer.ok)
				expect(answer.error.message).toMatch(/did not finish: stop it again/);
			expect((await sh(box, "cat starts")).text.trim().split("\n")).toEqual(["start"]);
			// Once that stop is ended, the name starts anew.
			await sh(box, `: > "${first.directory}/stop.done"`);
			getOrThrow(await launch(box, "late", spec, context));
			await until("the second start", async () =>
				(await sh(box, "cat starts")).text.trim().split("\n").length === 2 ? true : undefined,
			);
		} finally {
			await box.destroy(context);
		}
	});

	it("is taken over by a later stop, which kills the dead stop's hook if it still runs", async () => {
		const box = await aBox();
		try {
			const started = getOrThrow(await launch(box, "orphan-hook", { argv: ["sleep", "300"] }, context));
			const dir = started.directory;
			// The dead stop's hook: a process in a session of its own, recorded as a stop records its hook.
			const hook = (await sh(box, "setsid sleep 301 </dev/null >/dev/null 2>&1 & echo $!")).text.trim();
			await until("the hook", async () => ((await alive(box, hook)) ? true : undefined));
			await sh(
				box,
				`echo ${hook} > "${dir}/hook.pid" && sed 's/^.*) //' /proc/${hook}/stat | cut -d' ' -f20 > "${dir}/hook.ticks"`,
			);
			await plantDeadStop(box, dir);
			const stopped = getOrThrow(await launchStop(box, started.launch, { graceMs: 300 }, context));
			expect(stopped.phase).toBe("stopped");
			await until("the hook to be killed", async () => ((await alive(box, hook)) ? undefined : true), 10_000);
		} finally {
			await box.destroy(context);
		}
	});
});
