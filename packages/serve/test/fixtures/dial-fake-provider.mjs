// A conformance module for scripts/dial-conformance.mjs's test: a dial host (computer's fake host, facts.connect "dial")
// whose machines dial the server over the network as agentrun-dial does. A create's machine fetches the daemon from
// AGENTRUN_DAEMON_URL with its token, takes it only when its sha256 is AGENTRUN_DAEMON_SHA256, and runs its
// `computerd version` (its hello says that version, so the drift case's changed copy is run too), then dials
// AGENTRUN_ATTACH_URL with AGENTRUN_ATTACH_TOKEN, where the fake's daemon answers. uname -m answers the machine's arch, and the janitor ends a
// machine past its deadline. Every provider the script makes is over one host, as every provider of a vendor is. The
// host's timers run on computer's test clock (the wall clock, moved on by every wait on it), which the module exports as
// its conformanceClock: the deadline case waits out its 45 s lifetime on it, at once.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACH_SUBPROTOCOL, HostedProvider } from "@parcha/agentrun-computer";
import WebSocket from "ws";
import { testClock } from "../../../computer/test/fake-device.mjs";
import { fakeHost } from "../../../computer/test/fake-host.mjs";

const MACHINE = { amd64: "x86_64", arm64: "aarch64" };

const fake = fakeHost({ facts: { connect: "dial", lifetime: "janitor" }, clock: testClock, onBoot: (m) => void boot(m).catch(() => undefined) });

/** What the machine's daemon answers: the fake's, with uname -m the machine's own. */
function answerOf(m, request) {
	if (request.method === "exec.run" && request.params.argv.join(" ") === "uname -m") {
		const stdout = Buffer.from(`${MACHINE[fake.host.facts.arch]}\n`).toString("base64");
		return { result: { exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false } };
	}
	return fake.answer(m, request);
}

/** The version the fetched daemon says (`computerd version`, run once per build): its hello's. */
const versions = new Map();
function versionOf(sha256, bytes) {
	if (!versions.has(sha256)) {
		const dir = mkdtempSync(join(tmpdir(), "dial-fake-machine-"));
		try {
			const file = join(dir, "computerd");
			writeFileSync(file, bytes, { mode: 0o755 });
			versions.set(sha256, execFileSync(file, ["version"], { encoding: "utf8", env: {} }).trim());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	return versions.get(sha256);
}

/** The machine's agentrun-dial: the daemon fetched and held to its sha256, then the dial. */
async function boot(m) {
	const env = m.boot;
	const authorization = `Bearer ${env.AGENTRUN_ATTACH_TOKEN}`;
	const fetched = await fetch(env.AGENTRUN_DAEMON_URL, { headers: { authorization } });
	if (!fetched.ok) return;
	const bytes = Buffer.from(await fetched.arrayBuffer());
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	if (sha256 !== env.AGENTRUN_DAEMON_SHA256) return;
	m.box.hello = { ...m.box.hello, arch: fake.host.facts.arch, version: versionOf(sha256, bytes) };
	const ws = new WebSocket(env.AGENTRUN_ATTACH_URL, ATTACH_SUBPROTOCOL, { headers: { authorization } });
	ws.on("error", () => undefined);
	ws.on("message", (data) => {
		const request = JSON.parse(String(data));
		if (typeof request.id !== "number") return;
		const reply = answerOf(m, request);
		if (reply !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }));
	});
}

/**
 * The adapter's polls at the fake's pace, as computer's own fake-host tests set them: the fake lists a machine at once
 * and has no listing to settle, where a vendor's poll waits 1 s between reads and a 1 s window for its listing.
 */
const TIMEOUTS = { pollMs: 5, listedStableMs: 0 };

export function createProvider({ dial, daemonPath } = {}) {
	return new HostedProvider(fake.host, { timeouts: TIMEOUTS, ...(dial ? { dial } : {}), ...(daemonPath ? { daemonPath } : {}) });
}

export const conformanceImage = () => "img";

export const conformanceClock = testClock;
