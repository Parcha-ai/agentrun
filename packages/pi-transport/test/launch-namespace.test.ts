// The launcher's shell namespace (T3): the program's settings, the box runtime's environment and the launcher's own variables
// share one shell, so neither of the first two may change what the launcher does or see what it holds.
//
// EVERY VARIABLE THE LAUNCHER'S SHELL READS, where it comes from, and whether a caller can set it:
// | variable                                             | from                                                  | program `env` / `inheritEnv` | box runtime        |
// |------------------------------------------------------|-------------------------------------------------------|------------------------------|--------------------|
// | MODE D SELF                                          | the script's argv ($1, $2, $0), set by the launcher   | refused (listed)             | unset at line 1    |
// | TICK STEP STEPS SETSID                               | the script, from `command -v`/`sleep` probes          | refused (listed)             | unset at line 1    |
// | PROC                                                 | one script line, like PTRACE_FILE (a test's /proc)    | refused (listed)             | unset at line 1    |
// | GEN RESTART DELAY BURST INTERVAL TERMINALS LOGMAX    | spec.sh, written by the host from the LaunchSpec      | refused (listed)             | unset at line 1    |
// | FRAMED RUNAS ISOLATION HOOK HOOK_TENTHS              | spec.sh, written by the host                          | refused (listed)             | unset at line 1    |
// | PTRACE_FILE                                          | one script line (no environment can change it)        | refused (listed)             | unset at line 1    |
// | MYGEN                                                | the script, from GEN                                  | refused (listed)             | unset at line 1    |
// | FSEC FIN                                             | the frame, read from the start's stdin (memory only)  | refused (listed)             | unset at line 1    |
// | the temporaries (n code pid line name uid gid home   | the script itself                                     | refused (listed)             | unset at line 1    |
// |   how me v hp hcode limit magic extra phase st ...)  |                                                       |                              |                    |
// | u_name u_id u_gid u_how u_home (run_program)         | the launcher's own user record, $D/user               | refused (listed)             | unset at line 1    |
// | PI_TRANSPORT_PROC                                    | nowhere: the launcher never reads it                  | refused (PI_TRANSPORT_*)     | never read         |
// | PATH HOME TMPDIR                                     | the box runtime (the exec's environment)              | PATH, HOME refused           | read: the box's    |
// | BASH_ENV ENV SHELLOPTS BASHOPTS PS4 LD_*             | the box runtime, cleared at the exec (`env -u`)       | refused (named)              | cleared at exec    |
// | glibc's UNSECURE_ENVVARS (GCONV_PATH, GLIBC_TUNABLES, | the box runtime, cleared at the exec (`env -u`)       | refused (named)              | cleared at exec    |
// |   LOCPATH, ...; TMPDIR excepted), musl's MUSL_LOCPATH |                                                       |                              |                    |
// So no program setting assigns a launcher variable; no runtime export keeps an export flag on one; and the shell's, the
// loader's and the C library's variables are gone before the script's first line. A requested user switch that cannot happen fails (exit 126).
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { launch, launchState, launchStop, specScript } from "../src/launch/launch.ts";
import { LAUNCHER_SCRIPT, LAUNCHER_SHELL_NAMES } from "../src/launch/launcher-script.ts";
import { sh, UNSECURE, until } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function aBox(env?: Readonly<Record<string, string>>): Promise<{ box: Box; root: string }> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-ns-"));
	roots.push(root);
	const box = getOrThrow(
		await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000, ...(env ? { env } : {}) }, context),
	);
	return { box, root };
}
async function fileIn(box: Box, path: string): Promise<string | undefined> {
	const read = await box.download([path], context);
	return read.ok ? new TextDecoder().decode(read.value[0]!.bytes) : undefined;
}
/** Process ids whose environ or cmdline holds `marker`, read from /proc. */
function processesHolding(marker: string): number[] {
	const found: number[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		for (const part of ["environ", "cmdline"]) {
			try {
				if (readFileSync(`/proc/${name}/${part}`).includes(marker)) found.push(Number(name));
			} catch {
				// Another user's process, or one that ended.
			}
		}
	}
	return found;
}

/** Every name a shell text assigns: `NAME=` at a word's start, `read -r A B`, `for NAME in`. */
function assigned(text: string): Set<string> {
	const names = new Set<string>();
	for (const m of text.matchAll(/(?:^|[\s;(|&{])([A-Za-z_][A-Za-z0-9_]*)=/gm)) names.add(m[1]!);
	for (const m of text.matchAll(/\bread\s+-r\s+([A-Za-z_][A-Za-z0-9_ ]*?)(?:\s*<|\s*\|\||\s*;|\s*$|\s*\))/gm))
		for (const n of m[1]!.trim().split(/\s+/)) names.add(n);
	for (const m of text.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) names.add(m[1]!);
	return names;
}

describe("the launcher's names", () => {
	it("NO DRIFT: every name the script or a generated spec assigns is in LAUNCHER_SHELL_NAMES (IFS only as a read's prefix), and the script's first statement unsets them all", () => {
		const spec = specScript(
			{
				argv: ["sh", "-c", "true"],
				env: { APP: "x" },
				inheritEnv: ["BOX_THING"],
				user: "nobody",
				// A spec the check would refuse (a tools user beside another user): here only its generated names matter.
				toolsUser: "pda",
				stdin: new Uint8Array([1]),
				secrets: { A: "b" },
				beforeStop: { argv: ["true"] },
				cwd: "/tmp",
			},
			"vm",
		);
		const listed = new Set(LAUNCHER_SHELL_NAMES);
		const missing = [...assigned(LAUNCHER_SCRIPT), ...assigned(spec)].filter(
			(name) => !listed.has(name) && name !== "IFS" && !/^(APP|PI_TRANSPORT_[A-Z_]+|LANG|HOME|PATH)$/.test(name),
		);
		expect([...new Set(missing)]).toEqual([]);
		expect(LAUNCHER_SCRIPT.split("\n")[0]).toBe(`unset ${LAUNCHER_SHELL_NAMES.join(" ")}`);
	});

	it("refuses each of them, and the shell's and the loader's, as a program setting and as an inherited name", async () => {
		const stub = { id: "stub", facts: () => ({ secretsVia: "fd" }) } as unknown as Box;
		for (const name of [
			...LAUNCHER_SHELL_NAMES,
			"IFS",
			"BASH_ENV",
			"ENV",
			"SHELLOPTS",
			"BASHOPTS",
			"PS4",
			"LD_PRELOAD",
			"LD_LIBRARY_PATH",
			"LD_AUDIT",
			"LD_ANYTHING",
		]) {
			const set = await launch(stub, "ns", { argv: ["true"], env: { [name]: "x" } }, context);
			expect(set.ok ? undefined : set.error.code, `env ${name}`).toBe("invalid");
			const inherited = await launch(stub, "ns", { argv: ["true"], inheritEnv: [name] }, context);
			expect(inherited.ok ? undefined : inherited.error.code, `inheritEnv ${name}`).toBe("invalid");
		}
	});
});

describe("a box runtime that exports the launcher's names", () => {
	it("cannot make them carry the frame: with every listed name exported (FSEC and FIN among them), no process's environ or cmdline holds the stdin or the secrets, raw or base64, the program sees none of the names, and it still gets both", async () => {
		// Every listed name, and FSEC and FIN by name whatever the list says (the frame's own variables).
		const runtime = {
			...Object.fromEntries(LAUNCHER_SHELL_NAMES.map((name) => [name, `rt-${name}`])),
			FSEC: "rt-FSEC",
			FIN: "rt-FIN",
		};
		const { box } = await aBox(runtime);
		const token = `tok-${randomBytes(12).toString("hex")}`;
		const secret = `sec-${randomBytes(12).toString("hex")}`;
		const stdin = new TextEncoder().encode(`${token}\n`);
		const secrets = { MODAL_TOKEN_ID: secret };
		const program = [
			"sh",
			"-c",
			'env > seen-env; sha256sum | cut -c1-64 > in; cat <&"$PI_TRANSPORT_SECRETS_FD" | sha256sum | cut -c1-64 > sec; exec sleep 300',
		];
		const started = getOrThrow(await launch(box, "exported", { argv: program, stdin, secrets }, context));
		expect((await until("its stdin", () => fileIn(box, "in")))?.trim()).toBe(sha(stdin));
		expect((await until("its secrets", () => fileIn(box, "sec")))?.trim()).toBe(sha(JSON.stringify(secrets)));
		const encoded = [Buffer.from(stdin).toString("base64"), Buffer.from(JSON.stringify(secrets)).toString("base64")];
		for (const marker of [token, secret, ...encoded])
			expect(processesHolding(marker), marker.slice(0, 8)).toEqual([]);
		const seen = (await fileIn(box, "seen-env")) ?? "";
		const names = seen.split("\n").map((line) => line.slice(0, line.indexOf("=")));
		expect(names.filter((name) => LAUNCHER_SHELL_NAMES.includes(name))).toEqual([]);
		getOrThrow(await launchStop(box, started.launch, { graceMs: 1_000 }, context));
		await box.destroy(context);
	});

	it("cannot act on the launcher's shell or the commands below it: BASH_ENV/ENV, SHELLOPTS=xtrace with PS4 and LD_PRELOAD exported to a box whose sh is bash leave no marker, no trace, no loader error and no frame data, and the launch works", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-transport-launch-shim-"));
		roots.push(scratch);
		const bin = join(scratch, "bin");
		mkdirSync(bin);
		// A box whose sh is bash: the launcher's shell then reads BASH_ENV and SHELLOPTS at startup, before its first line.
		// Plain bash, not bash invoked as sh: in POSIX mode bash reads no startup file, so BASH_ENV would never act.
		writeFileSync(join(bin, "sh"), '#!/usr/bin/bash\nexec /usr/bin/bash "$@"\n');
		chmodSync(join(bin, "sh"), 0o755);
		const marker = join(scratch, "sourced");
		writeFileSync(join(scratch, "hook.sh"), `: > ${JSON.stringify(marker)}\n`);
		const { box } = await aBox({
			PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
			BASH_ENV: join(scratch, "hook.sh"),
			ENV: join(scratch, "hook.sh"),
			SHELLOPTS: "xtrace",
			PS4: "+PS4MARK ",
			LD_PRELOAD: join(scratch, "missing-library.so"),
		});
		const token = `tok-${randomBytes(12).toString("hex")}`;
		const stdin = new TextEncoder().encode(`${token}\n`);
		const program = ["sh", "-c", "sha256sum | cut -c1-64 > in; exec sleep 300"];
		const started = getOrThrow(
			await launch(box, "shellvars", { argv: program, stdin, secrets: { A: "secret-value" } }, context),
		);
		expect((await until("its stdin", () => fileIn(box, "in")))?.trim()).toBe(sha(stdin));
		const log = (await fileIn(box, `${started.directory}/out.log`)) ?? "";
		expect(log).not.toContain("PS4MARK");
		expect(log).not.toMatch(/LD_PRELOAD|cannot be preloaded/);
		expect(readdirSync(scratch)).not.toContain("sourced");
		for (const value of [token, Buffer.from(stdin).toString("base64")]) expect(processesHolding(value)).toEqual([]);
		getOrThrow(await launchStop(box, started.launch, { graceMs: 1_000 }, context));
		await box.destroy(context);
	});
});

describe("the C library's own unsecure variables in the box runtime", () => {
	it("reach neither the launcher's processes nor the program: cleared at the exec that starts each launcher shell", async () => {
		const tag = randomBytes(6).toString("hex");
		// Each set to a value its library takes as harmless. LD_SHOW_AUXV is left out: glibc acts on it at any value, so every program
		// this runtime starts, the env that clears it among them, prints its auxv first.
		const value = (name: string) =>
			name.startsWith("LD_")
				? ""
				: name === "GLIBC_TUNABLES"
					? `glibc.zz.marker${tag}=1`
					: name.startsWith("MALLOC_") && name !== "MALLOC_TRACE"
						? "8"
						: name === "RES_OPTIONS"
							? "ndots:1"
							: `/nonexistent-zz-${tag}`;
		const set = UNSECURE.filter((name) => name !== "LD_SHOW_AUXV");
		const { box } = await aBox(Object.fromEntries(set.map((name) => [name, value(name)])));
		const program = ["sh", "-c", "env > seen-env; exec sleep 300"];
		const started = getOrThrow(await launch(box, "libc", { argv: program }, context));
		await until("the program's environment", () => fileIn(box, "seen-env"));
		const dir = started.directory;
		for (const file of ["launcher.pid", "watch.pid", "pid.1"]) {
			const pid = readFileSync(join(dir, file), "utf8").trim();
			const names = readFileSync(`/proc/${pid}/environ`, "utf8")
				.split("\0")
				.map((entry) => entry.slice(0, entry.indexOf("=")));
			expect(
				set.filter((name) => names.includes(name)),
				`${file} ${pid}`,
			).toEqual([]);
		}
		const seen = ((await fileIn(box, "seen-env")) ?? "").split("\n").map((line) => line.slice(0, line.indexOf("=")));
		expect(set.filter((name) => seen.includes(name))).toEqual([]);
		getOrThrow(await launchStop(box, started.launch, { graceMs: 1_000 }, context));
		await box.destroy(context);
	});
});

describe("a requested user switch that cannot happen", () => {
	it("FAILS the incarnation (exit 126) and never runs the program as the launcher's own user: its user record removed between two incarnations", async () => {
		const { box } = await aBox();
		const me = (await sh(box, "id -un")).text.trim();
		// The first incarnation runs and exits 3; the restart waits 3 s, in which the launcher's record of the user goes.
		const spec = {
			argv: ["sh", "-c", "echo ran >> runs; exit 3"],
			user: me,
			restartDelayMs: 3_000,
			restartLimit: { burst: 1, intervalMs: 60_000 },
		};
		const started = getOrThrow(await launch(box, "nouserfile", spec, context));
		await until("the first run", () => fileIn(box, "runs"));
		await sh(box, `rm -f ${started.directory}/user`);
		const after = await until("the second incarnation's end", async () => {
			const read = getOrThrow(await launchState(box, started.launch, context));
			return read !== undefined &&
				read.incarnation >= 2 &&
				read.phase !== "running" &&
				read.phase !== "starting" &&
				read.lastExit === 126
				? read
				: undefined;
		});
		expect(after.lastExit).toBe(126);
		expect((await fileIn(box, "runs"))?.trim().split("\n")).toEqual(["ran"]);
		expect(await fileIn(box, `${started.directory}/out.log`)).toContain(
			"refused, never run as the launcher's own user",
		);
		await launchStop(box, started.launch, { graceMs: 500 }, context);
		await box.destroy(context);
	});
});

describe("a start the launcher refused", () => {
	it("frees its name: the state reads no launch, and a good launch of the same name starts at once", async () => {
		const { box } = await aBox();
		const refused = await launch(box, "retry", { argv: ["sleep", "300"], user: "no-such-user-here" }, context);
		expect(refused.ok ? undefined : refused.error.code).toBe("invalid");
		expect(getOrThrow(await launchState(box, { v: 1, name: "retry" }, context))).toBeUndefined();
		const began = Date.now();
		const started = getOrThrow(await launch(box, "retry", { argv: ["sleep", "300"] }, context));
		expect(started.launcherAlive).toBe(true);
		expect(Date.now() - began).toBeLessThan(10_000);
		getOrThrow(await launchStop(box, started.launch, { graceMs: 500 }, context));
		await box.destroy(context);
	});
});
