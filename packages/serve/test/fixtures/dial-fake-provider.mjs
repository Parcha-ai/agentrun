// A conformance module for scripts/dial-conformance.mjs's test: a dial host (computer's fake host, facts.connect "dial")
// whose machines dial the server over the network as agentrun-dial does. A create's machine fetches the daemon from
// AGENTRUN_DAEMON_URL with its token, runs it only when its sha256 is AGENTRUN_DAEMON_SHA256 (its hello says the
// package's version when the bytes hold it, another when the server changed it), and dials AGENTRUN_ATTACH_URL with
// AGENTRUN_ATTACH_TOKEN, where the fake's daemon answers. uname -m answers the machine's arch, and the janitor ends a
// machine past its deadline. Every provider the script makes is over one host, as every provider of a vendor is.
import { createHash } from "node:crypto";
import { ATTACH_SUBPROTOCOL, HostedProvider } from "@parcha/agentrun-computer";
import WebSocket from "ws";
import { fakeHost, VERSION } from "../../../computer/test/fake-host.mjs";

const MACHINE = { amd64: "x86_64", arm64: "aarch64" };

const fake = fakeHost({ facts: { connect: "dial", lifetime: "janitor" }, onBoot: (m) => void boot(m).catch(() => undefined) });

/** What the machine's daemon answers: the fake's, with uname -m the machine's own. */
function answerOf(m, request) {
	if (request.method === "exec.run" && request.params.argv.join(" ") === "uname -m") {
		const stdout = Buffer.from(`${MACHINE[fake.host.facts.arch]}\n`).toString("base64");
		return { result: { exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false } };
	}
	return fake.answer(m, request);
}

/** The machine's agentrun-dial: the daemon fetched and held to its sha256, then the dial. */
async function boot(m) {
	const env = m.boot;
	const authorization = `Bearer ${env.AGENTRUN_ATTACH_TOKEN}`;
	const fetched = await fetch(env.AGENTRUN_DAEMON_URL, { headers: { authorization } });
	if (!fetched.ok) return;
	const bytes = Buffer.from(await fetched.arrayBuffer());
	if (createHash("sha256").update(bytes).digest("hex") !== env.AGENTRUN_DAEMON_SHA256) return;
	m.box.hello = { ...m.box.hello, arch: fake.host.facts.arch, version: bytes.includes(Buffer.from(VERSION)) ? VERSION : `${VERSION}-another` };
	const ws = new WebSocket(env.AGENTRUN_ATTACH_URL, ATTACH_SUBPROTOCOL, { headers: { authorization } });
	ws.on("error", () => undefined);
	ws.on("message", (data) => {
		const request = JSON.parse(String(data));
		if (typeof request.id !== "number") return;
		const reply = answerOf(m, request);
		if (reply !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...reply }));
	});
}

export function createProvider({ dial, daemonPath } = {}) {
	return new HostedProvider(fake.host, { ...(dial ? { dial } : {}), ...(daemonPath ? { daemonPath } : {}) });
}

export const conformanceImage = () => "img";
