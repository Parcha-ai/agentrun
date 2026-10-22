// T5: a Modal box takes T3's launch frame on the stdin of the exec that starts the launcher (secretsVia "fd"). Over the fake Modal
// client, whose sandboxes run real local processes: the frame round trip, EOF with no bytes, the exec's stdin whole and in order,
// and nothing but the program's pipes holding a value.
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { afterAll, describe, expect, it } from "vitest";
import type { Box } from "../src/box/box.ts";
import { finish } from "../src/box/files.ts";
import { modalBoxes } from "../src/box/modal.ts";
import { launch, launchState, launchStop } from "../src/launch/index.ts";
import { sh, until } from "./home-launch-support.ts";
import { FakeModal } from "./modal-fake.ts";

const context = BACKGROUND_CONTEXT;
const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

async function aBox(): Promise<{ box: Box; sdk: FakeModal; root: string }> {
	const root = mkdtempSync(join(tmpdir(), "pi-transport-modal-frame-"));
	roots.push(root);
	const sdk = new FakeModal();
	// The box's TMPDIR is inside its root, so the launcher writes (and the walk reads) nowhere shared.
	const box = getOrThrow(
		await modalBoxes(sdk, { appName: "a" }).create(
			{ maxLifetimeMs: 10 * 60_000, workspace: join(root, "ws"), env: { TMPDIR: root } },
			context,
		),
	);
	return { box, sdk, root };
}

async function fileIn(box: Box, path: string): Promise<string | undefined> {
	const read = await box.download([path], context);
	return read.ok ? new TextDecoder().decode(read.value[0]?.bytes) : undefined;
}

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

describe("a Modal box and T3's launch frame", () => {
	it("reports that it takes a stdin and secrets, on create and on attach", async () => {
		const { box, sdk } = await aBox();
		expect(box.facts().secretsVia).toBe("fd");
		expect(box.facts().liveProcesses).not.toBe(false);
		const again = getOrThrow(await modalBoxes(sdk, { appName: "a" }).attach(box.id, context));
		expect(again?.facts().secretsVia).toBe("fd");
		// A box made before this was reported has no such field in its tag: it is still reported.
		const tags = sdk.sandboxList[0]?.params.tags ?? {};
		const old = JSON.parse(tags["pi-transport.facts"] ?? "{}") as Record<string, unknown>;
		delete old.secretsVia;
		tags["pi-transport.facts"] = JSON.stringify(old);
		const found = getOrThrow(await modalBoxes(sdk, { appName: "a" }).attach(box.id, context));
		expect(found?.facts().secretsVia).toBe("fd");
		await box.destroy(context);
	});

	it("carries stdin and secrets to every incarnation, and they rest nowhere but the program's pipes", async () => {
		const { box, sdk, root } = await aBox();
		const token = `tok-${randomBytes(12).toString("hex")}`;
		const secret = `sec-${randomBytes(12).toString("hex")}`;
		const program = [
			"sh",
			"-c",
			'n=$PI_TRANSPORT_INCARNATION; sha256sum | cut -c1-64 > in.$n; cat <&"$PI_TRANSPORT_SECRETS_FD" | sha256sum | cut -c1-64 > sec.$n; echo "$PI_TRANSPORT_SECRETS_FD" > fd.$n; [ "$n" -ge 2 ] && exec sleep 300; exit 3',
		];
		const stdin = new TextEncoder().encode(`${token}\n`);
		const secrets = { MODAL_TOKEN_ID: secret };
		getOrThrow(await launch(box, "framed", { argv: program, stdin, secrets }, context));
		await until("the second incarnation", async () => {
			const read = getOrThrow(await launchState(box, { v: 1, name: "framed" }, context));
			return read?.phase === "running" && read.incarnation === 2 && (await fileIn(box, "sec.2")) ? read : undefined;
		});
		for (const n of [1, 2]) {
			expect((await fileIn(box, `in.${n}`))?.trim()).toBe(sha(stdin));
			expect((await fileIn(box, `sec.${n}`))?.trim()).toBe(sha(JSON.stringify(secrets)));
			expect((await fileIn(box, `fd.${n}`))?.trim()).toBe("3");
		}
		const encoded = [Buffer.from(stdin).toString("base64"), Buffer.from(JSON.stringify(secrets)).toString("base64")];
		const markers = [token, secret, ...encoded];
		// What the CLIENT controls: no exec carries an env or secrets param, and no argv, param, tag or fact holds a value.
		const sandbox = sdk.sandboxList[0];
		for (const exec of sandbox?.execs ?? []) {
			expect(exec.params).not.toHaveProperty("env");
			expect(exec.params).not.toHaveProperty("secrets");
		}
		const visible = JSON.stringify([sandbox?.execs, sandbox?.params, box.facts()]);
		for (const marker of markers) expect(visible).not.toContain(marker);
		// What the box holds, once quiescent: no file under its tree.
		getOrThrow(await launchStop(box, { v: 1, name: "framed" }, { graceMs: 1_000 }, context));
		await sh(box, "true");
		for (const marker of markers) expect(filesHolding(root, marker)).toEqual([]);
		await box.destroy(context);
	});

	it("gives a program EOF on its stdin when no byte was written, and when the frame's stdin part is empty", async () => {
		const { box } = await aBox();
		const started = getOrThrow(await box.exec(["cat"], undefined, context));
		await started.stdin.close();
		const done = await Promise.race([
			finish(started),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no EOF")), 20_000)),
		]);
		expect(done.ok && done.value.exitCode).toBe(0);
		expect(done.ok && done.value.stdout.length).toBe(0);
		const secrets = { SECRET_ONE: `sec-${randomBytes(6).toString("hex")}` };
		const program = ["sh", "-c", "n=$PI_TRANSPORT_INCARNATION; cat | wc -c > in.$n; exec sleep 300"];
		getOrThrow(await launch(box, "empty", { argv: program, secrets }, context));
		expect((await until("the program's read", () => fileIn(box, "in.1"))).trim()).toBe("0");
		getOrThrow(await launchStop(box, { v: 1, name: "empty" }, { graceMs: 1_000 }, context));
		await box.destroy(context);
	});

	it("takes a stdin of 1.3 MiB through the exec whole and in order, across the 512 KiB chunks", async () => {
		const { box } = await aBox();
		const big = randomBytes(1_300_000);
		const started = getOrThrow(await box.exec(["sha256sum"], undefined, context));
		const done = getOrThrow(await finish(started, big));
		expect(new TextDecoder().decode(done.stdout).slice(0, 64)).toBe(sha(big));
		await box.destroy(context);
	});

	it("refuses a frame part over 64 KiB as invalid, before anything runs", async () => {
		const { box } = await aBox();
		for (const extra of [{ stdin: new Uint8Array(64 * 1024 + 1) }, { secrets: { A: "x".repeat(64 * 1024) } }]) {
			const refused = await launch(box, "toobig", { argv: ["sleep", "300"], ...extra }, context);
			expect(refused.ok ? undefined : refused.error.code).toBe("invalid");
		}
		expect(getOrThrow(await launchState(box, { v: 1, name: "toobig" }, context))).toBeUndefined();
		await box.destroy(context);
	});

	it("returns a close that failed on a running program through wait(), and ignores one on a program that already exited", async () => {
		const { box, sdk } = await aBox();
		const sandbox = sdk.sandboxList[0];
		if (sandbox === undefined) throw new Error("no sandbox");
		sandbox.failClose = true;
		const running = getOrThrow(await box.exec(["cat"], undefined, context));
		await running.stdin.close();
		const failed = await Promise.race([
			running.wait(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("wait never answered")), 20_000)),
		]);
		expect(failed.ok ? "ok" : failed.error.code).toBe("unknown");
		expect(!failed.ok && failed.error.message).toMatch(/input/);
		const quick = getOrThrow(await box.exec(["true"], undefined, context));
		await new Promise((resolve) => setTimeout(resolve, 500));
		await quick.stdin.close();
		const exited = await quick.wait();
		expect(exited.ok && exited.value).toBe(0);
		await box.destroy(context);
	});
});
