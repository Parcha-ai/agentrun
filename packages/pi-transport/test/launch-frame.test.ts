// The launch frame (T3): a launch's stdin (disk's mount token) and secrets reach the launcher on the ONE stdin of the exec
// that starts it, live only in the launcher's memory, and go to every incarnation on a pipe: the stdin part to the
// program's stdin, the secrets part to the fd PI_TRANSPORT_SECRETS_FD names. Neither rests in a file, an environ, an
// argv or the launcher's state; a box that cannot carry them refuses before anything runs.
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { localBoxes } from "../src/box/local.ts";
import { type LaunchSpec, launch, launchState, launchStop } from "../src/launch/index.ts";
import { sh, until } from "./home-launch-support.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

async function aBox(): Promise<{ box: Box; root: string }> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-launch-frame-"));
	roots.push(root);
	const box = getOrThrow(await localBoxes({ root }).create({ maxLifetimeMs: 10 * 60_000 }, context));
	return { box, root };
}

async function fileIn(box: Box, path: string): Promise<string | undefined> {
	const read = await box.download([path], context);
	return read.ok ? new TextDecoder().decode(read.value[0]!.bytes) : undefined;
}

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Every file under `dir` whose bytes hold `marker`, read strictly: an entry that cannot be listed or read fails the walk. The
 *  walk is of a private, quiescent tree (the test's own TMPDIR after its launch stopped), so nothing in it is another's or vanishing. */
function filesHolding(dir: string, marker: string): string[] {
	const found: string[] = [];
	const walk = (at: string) => {
		for (const name of readdirSync(at)) {
			const path = join(at, name);
			const info = lstatSync(path);
			if (info.isDirectory()) walk(path);
			else if (info.isFile() && readFileSync(path).includes(marker)) found.push(path);
		}
	};
	walk(dir);
	return found;
}

/** Process ids whose environment or command line holds `marker`, read from /proc, not from the provider. */
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

describe("a launch's stdin and secrets", () => {
	it("reach EVERY incarnation (stdin on its stdin, secrets on PI_TRANSPORT_SECRETS_FD), and rest nowhere: no file of the box, no environ, no argv", async () => {
		// The test's own TMPDIR is private for this test: the box's root, the launcher's TMPDIR (the box's) and every place the
		// launch writes by default are under it, and only it is walked (whole, strictly), once the launch has stopped.
		const shared = process.env.TMPDIR;
		const privateTmp = mkdtempSync(join(tmpdir(), "pi-transport-frame-private-"));
		roots.push(privateTmp);
		process.env.TMPDIR = privateTmp;
		try {
			const { box, root } = await aBox();
			expect(root.startsWith(`${privateTmp}/`)).toBe(true);
			const token = `tok-${randomBytes(12).toString("hex")}`;
			const secret = `sec-${randomBytes(12).toString("hex")}`;
			// Each incarnation keeps only HASHES of what it read; the first exits 3 (restarted), the second runs on.
			const program = [
				"sh",
				"-c",
				'n=$PI_TRANSPORT_INCARNATION; sha256sum | cut -c1-64 > in.$n; cat <&"$PI_TRANSPORT_SECRETS_FD" | sha256sum | cut -c1-64 > sec.$n; echo "$PI_TRANSPORT_SECRETS_FD" > fd.$n; [ "$n" -ge 2 ] && exec sleep 300; exit 3',
			];
			const stdin = new TextEncoder().encode(`${token}\n`);
			const secrets = { MODAL_TOKEN_ID: secret };
			const launched = getOrThrow(await launch(box, "framed", { argv: program, stdin, secrets }, context));
			// The launcher writes in the box's own TMPDIR, under its root: the root is walked whole.
			expect(launched.directory.startsWith(`${root}/`)).toBe(true);
			await until("the second incarnation", async () => {
				const read = getOrThrow(await launchState(box, { v: 1, name: "framed" }, context));
				return read?.phase === "running" && read.incarnation === 2 && (await fileIn(box, "sec.2"))
					? read
					: undefined;
			});
			for (const n of [1, 2]) {
				expect((await fileIn(box, `in.${n}`))?.trim()).toBe(sha(stdin));
				expect((await fileIn(box, `sec.${n}`))?.trim()).toBe(sha(JSON.stringify(secrets)));
				expect((await fileIn(box, `fd.${n}`))?.trim()).toBe("3");
			}
			// The raw values and the frame's own base64 of them: neither is in a file, an environ or an argv.
			const encoded = [
				Buffer.from(stdin).toString("base64"),
				Buffer.from(JSON.stringify(secrets)).toString("base64"),
			];
			// While the processes live: no environ or argv holds them.
			for (const marker of [token, secret, ...encoded]) expect(processesHolding(marker)).toEqual([]);
			// Then QUIESCENT: the launch stopped, every process the box ran closed (its pids/ empty), so nothing vanishes under the walk.
			getOrThrow(await launchStop(box, { v: 1, name: "framed" }, { graceMs: 1_000 }, context));
			const pids = readdirSync(root, { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isDirectory() && entry.name === "pids")
				.map((entry) => join(entry.parentPath, entry.name));
			expect(pids.length).toBe(1);
			await until("a quiescent box", async () => (readdirSync(pids[0]!).length === 0 ? true : undefined));
			for (const marker of [token, secret, ...encoded]) expect(filesHolding(privateTmp, marker)).toEqual([]);
			await box.destroy(context);
		} finally {
			// Unset stays unset: a process.env assignment of undefined would store the string "undefined".
			if (shared === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = shared;
		}
	});

	it("writes to no literal /tmp: the launcher's only /tmp is the fallback of an exec with no TMPDIR, which a local box never is", async () => {
		const sources = ["../src/launch/launch.ts", "../src/launch/launcher-script.ts"].map((path) =>
			readFileSync(new URL(path, import.meta.url), "utf8"),
		);
		const uses = sources.flatMap((text) => text.split("\n").filter((line) => line.includes("/tmp")));
		expect(uses.map((line) => line.trim())).toEqual([
			"'t=$TMPDIR; [ -n \"$t\" ] || t=/tmp',",
			"'t=$TMPDIR; [ -n \"$t\" ] || t=/tmp',",
		]);
		const { box, root } = await aBox();
		expect((await sh(box, 'printf %s "$TMPDIR"')).text.startsWith(`${root}/`)).toBe(true);
		await box.destroy(context);
	});

	it("are refused, before anything runs, on a box that cannot carry them (no secretsVia: fd)", async () => {
		const { box } = await aBox();
		// The same box, reporting no way to carry secrets (a Proxy, so its methods keep their receiver).
		const plain = new Proxy(box, {
			get(target, key) {
				if (key === "facts") return () => ({ ...target.facts(), secretsVia: undefined });
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		for (const extra of [{ stdin: new Uint8Array([1]) }, { secrets: { A: "b" } }]) {
			const refused = await launch(plain, "nofd", { argv: ["sleep", "300"], ...extra }, context);
			expect(refused.ok ? undefined : refused.error.code).toBe("unsupported");
		}
		expect(getOrThrow(await launchState(box, { v: 1, name: "nofd" }, context))).toBeUndefined();
		await box.destroy(context);
	});

	it("refuses a secret name that is not a name, a NUL, and a part over 64 KiB", async () => {
		const { box } = await aBox();
		const cases: Partial<LaunchSpec>[] = [
			{ secrets: { "not a name": "x" } },
			{ secrets: { A: "with\0nul" } },
			{ stdin: new Uint8Array(64 * 1024 + 1) },
			{ secrets: { A: "x".repeat(64 * 1024) } },
		];
		for (const extra of cases) {
			const refused = await launch(box, "badframe", { argv: ["sleep", "300"], ...extra }, context);
			expect(refused.ok ? undefined : refused.error.code).toBe("invalid");
		}
		await box.destroy(context);
	});

	it("is never brought back by the in-box watchdog: a framed launch whose supervisor died (its watchdog alive) reads lost, and only a launch that passes the stdin again revives it", async () => {
		const { box } = await aBox();
		const token = `tok-${randomBytes(12).toString("hex")}`;
		const program = ["sh", "-c", "sha256sum | cut -c1-64 > in.$PI_TRANSPORT_INCARNATION; exec sleep 300"];
		const spec = { argv: program, stdin: new TextEncoder().encode(token) };
		const first = getOrThrow(await launch(box, "revive", spec, context));
		await until("the program's read", () => fileIn(box, "in.1"));
		// Only the supervisor dies, as in a crash: its watchdog lives, and would bring back a plain launch's. It has no frame, so
		// it lets the launch go (the program runs on, unsupervised) and the launch reads lost.
		await sh(box, `D=${first.directory}; kill -9 "$(cat "$D/launcher.pid")" 2>/dev/null; true`);
		const lost = await until("lost", async () => {
			const read = getOrThrow(await launchState(box, first.launch, context));
			return read?.phase === "lost" ? read : undefined;
		});
		expect(lost.launcherAlive).toBe(false);
		const again = getOrThrow(await launch(box, "revive", spec, context));
		expect(again.launcherAlive).toBe(true);
		getOrThrow(await launchStop(box, first.launch, { graceMs: 1_000 }, context));
		await box.destroy(context);
	});
});

describe("a launch's user", () => {
	it("runs the program as the launcher's own user when named, and refuses another user from a launcher that is not root", async () => {
		const { box } = await aBox();
		const me = userInfo().username;
		getOrThrow(await launch(box, "self", { argv: ["sh", "-c", "id -u > uid; exec sleep 300"], user: me }, context));
		expect((await until("the program's uid", () => fileIn(box, "uid")))?.trim()).toBe(String(process.getuid?.()));
		const state = getOrThrow(await launchState(box, { v: 1, name: "self" }, context));
		expect(state?.user).toEqual({ name: me, uid: process.getuid?.() });
		getOrThrow(await launchStop(box, { v: 1, name: "self" }, { graceMs: 1_000 }, context));
		if (process.getuid?.() !== 0) {
			const other = await launch(box, "other", { argv: ["sleep", "300"], user: "root" }, context);
			expect(other.ok ? undefined : other.error.code).toBe("unsupported");
		}
		// A framed launch as uid 0 spelled with extra zeros is refused before any box call (the launcher refuses, in the box, a name
		// that RESOLVES to uid 0: launch-stop-ptrace.test.ts).
		const asRoot = await launch(
			box,
			"asroot",
			{ argv: ["sleep", "300"], user: "000", stdin: new Uint8Array([1]) },
			context,
		);
		expect(asRoot.ok ? undefined : asRoot.error.code).toBe("invalid");
		expect(asRoot.ok ? "" : asRoot.error.message).toMatch(/runs its program as root \(uid 0\) only with a toolsUser/);
		const unknown = await launch(box, "unknown", { argv: ["sleep", "300"], user: "no-such-user-here" }, context);
		expect(unknown.ok ? undefined : unknown.error.code).toBe("invalid");
		await box.destroy(context);
	});
});
