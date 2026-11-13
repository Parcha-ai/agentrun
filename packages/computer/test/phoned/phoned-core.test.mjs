// The TypeScript client against phoned's real Java core (FakeMain, over its scripted phone): the wire the phone harness
// speaks to a phone, end to end through a child JVM. Run by `npm run test:phoned`, which builds the classes first.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DaemonClient } from "../../dist/client.js";
import { startFakeMain } from "./fake-main.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

/** A client of a fresh FakeMain, and how to end it: closing its stdin, as the phone harness does. */
function phoned() {
	const main = startFakeMain();
	const client = new DaemonClient({ readable: main.stream, writable: main.stream });
	return { client, main, end: async () => (client.close(), main.exited) };
}

test("phoned's hello is protocol 0.2 with this package's version, the phone's groups, its screen in points, the device and each feature", async () => {
	const { client, end } = phoned();
	try {
		const hello = await client.call("hello", { client: "test" });
		assert.equal(hello.ok, true, JSON.stringify(hello));
		const { protocol, version, os, osVersion, kind, arch, groups, screen, device, features } = hello.value;
		assert.deepEqual({ protocol, version, os, osVersion, kind, arch }, { protocol: "0.2", version: VERSION, os: "android", osVersion: "15 (API 35)", kind: "android", arch: "arm64" });
		assert.deepEqual(groups, ["exec", "screen", "input.keys", "input.touch", "apps", "ui"]);
		assert.deepEqual(screen, { width: 540, height: 1200, scale: 2 });
		assert.deepEqual(device, { maker: "Google", model: "Pixel 9" });
		assert.equal(features["ui.tree"], true);
		assert.equal(features["ui.foreground"], true);
		assert.match(features["ui.background"].off, /window in front/);
		assert.deepEqual(await client.call("ping", {}), { ok: true, value: {} });
	} finally {
		assert.deepEqual(await end(), { code: 0, signal: null }, "closing its stdin ends it");
	}
});

test("observe names the Settings row from its texts, and a press by ref with expect is semantic and met", async () => {
	const { client, end } = phoned();
	try {
		const seen = await client.call("ui.observe", {});
		assert.equal(seen.ok, true, JSON.stringify(seen));
		const row = seen.value.nodes.find((node) => node.name === "Network & internet");
		assert.ok(row, JSON.stringify(seen.value.nodes));
		assert.match(row.ref, /^@e\d+$/);
		assert.equal(row.desc, "Mobile, Wi-Fi, hotspot");
		// "Internet" is the next page's: no element of Settings holds it (an expect matches names, values and descs, by case),
		// so a met expect says the press went through.
		assert.equal(seen.value.nodes.filter((node) => [node.name, node.value, node.desc].some((text) => text?.includes("Internet"))).length, 0);
		const acted = await client.call("ui.act", { state: seen.value.state, steps: [{ press: row.ref }], expect: { text: "Internet" } });
		assert.equal(acted.ok, true, JSON.stringify(acted));
		assert.deepEqual(acted.value.steps[0], { route: "semantic", verified: true });
		assert.equal(acted.value.expect, "met");
	} finally {
		await end();
	}
});

test("exec.run runs a program on the phone side and answers its output in base64; a refused user is denied in words", async () => {
	const { client, end } = phoned();
	try {
		const ran = await client.call("exec.run", { argv: ["sh", "-c", "echo hi; echo oops >&2; exit 3"], timeoutMs: 10_000 });
		assert.equal(ran.ok, true, JSON.stringify(ran));
		assert.deepEqual(
			{ ...ran.value, stdout: Buffer.from(ran.value.stdout, "base64").toString(), stderr: Buffer.from(ran.value.stderr, "base64").toString() },
			{ exitCode: 3, stdout: "hi\n", stderr: "oops\n", timedOut: false, truncated: false },
		);
		const root = await client.call("exec.run", { argv: ["id"], user: "root", timeoutMs: 10_000 });
		assert.equal(root.error.code, "denied");
		assert.match(root.error.message, /runs as the shell user/);
	} finally {
		await end();
	}
});

test("exec.run ends a program's background child with the run, the shell that started it gone already", async () => {
	const { client, end } = phoned();
	try {
		const ran = await client.call("exec.run", { argv: ["sh", "-c", "sleep 613 >/dev/null 2>&1 & echo started"], timeoutMs: 10_000 });
		assert.equal(ran.ok, true, JSON.stringify(ran));
		assert.equal(ran.value.exitCode, 0);
		const left = await client.call("exec.run", { argv: ["sh", "-c", "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < $f 2>/dev/null; echo; done | grep -c 'slee[p] 613'; true"], timeoutMs: 10_000 });
		assert.equal(left.ok, true, JSON.stringify(left));
		assert.equal(Buffer.from(left.value.stdout, "base64").toString().trim(), "0", "the background child is gone with its run");
		const mark = await client.call("exec.run", { argv: ["sh", "-c", "echo $PHONED_RUN"], timeoutMs: 10_000 });
		assert.equal(mark.ok, true, JSON.stringify(mark));
		assert.match(Buffer.from(mark.value.stdout, "base64").toString(), /^[0-9a-f-]{36}\n$/, "a run carries its own mark");
	} finally {
		await end();
	}
});

test("two shots are both held: reading the first after the second still answers it", async () => {
	const { client, end } = phoned();
	try {
		const first = await client.call("screen.shot", {});
		const second = await client.call("screen.shot", {});
		assert.equal(first.ok && second.ok, true, JSON.stringify([first, second]));
		assert.notEqual(first.value.id, second.value.id);
		for (const shot of [first.value, second.value]) {
			if (shot.eof) continue;
			const rest = await client.call("screen.read", { id: shot.id, offset: Buffer.from(shot.data, "base64").length });
			assert.equal(rest.ok, true, JSON.stringify(rest));
		}
	} finally {
		await end();
	}
});

test("a key chord's last key may be + itself: shift++ and + are keys, not an empty name", async () => {
	const { client, end } = phoned();
	try {
		const seen = await client.call("ui.observe", {});
		const acted = await client.call("ui.act", { state: seen.value.state, foreground: true, steps: [{ key: "shift++" }, { key: "+" }] });
		assert.equal(acted.ok, true, JSON.stringify(acted));
		for (const step of acted.value.steps) assert.equal(step.error, undefined, JSON.stringify(step));
	} finally {
		await end();
	}
});
