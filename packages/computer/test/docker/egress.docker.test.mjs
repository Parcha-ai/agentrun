// A Docker computer whose network is an allowlist, on real Docker (AGENTRUN_COMPUTER_LIVE_DOCKER=1 only): a listed host
// is reached through the proxy, an unlisted one is refused before any lookup, and a listed name that resolves to a
// private, loopback or link-local address is refused; a program that ignores the proxy reaches nothing; the allowlist
// reads back from Docker; a crashed proxy fails closed; release, and the proxy's own deadline, leave nothing.
//
// No lookup or connection leaves this machine: the proxy runs in an image built here from the pinned proxy image with
// the tests' fake network (fixtures/egress/preload.mjs, loaded with NODE_OPTIONS), given to the provider as its egress
// image. Every name resolves there as the fake says, and every connection the proxy makes reaches the fake's origin on
// the proxy container's own loopback. The proxy's code is this package's own build, bound read-only as in production.
// Needs `npm run build` and `npm run build:daemon` first. Every container and volume this file makes carries this run's
// label and is removed in the after hook.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { DockerProvider, EGRESS_IMAGE, sweep } from "../../dist/index.js";

const LIVE = process.env.AGENTRUN_COMPUTER_LIVE_DOCKER === "1";
const RUN_LABEL = "agentrun.test.run";
const FIXTURE = fileURLToPath(new URL("../fixtures/egress/", import.meta.url));
const ALLOW = ["origin.example", "inner.example", "loop.example", "meta.example", "93.184.215.0/24"];
const HINT = "ask the operator to add it";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" });

/** Talks to the computer's proxy from inside it, by the address HTTP_PROXY names: a plain GET, or a CONNECT and then a
 *  GET through the tunnel. Prints all it got back, or the socket's error. */
const CLIENT = `
const net = require("node:net");
const [mode, target] = process.argv.slice(1);
const proxy = new URL(process.env.HTTP_PROXY);
const socket = net.connect(Number(proxy.port), proxy.hostname);
let got = "";
let tunnelled = false;
socket.on("data", (chunk) => {
	got += chunk;
	if (mode === "connect" && !tunnelled && got.includes("\\r\\n\\r\\n") && got.startsWith("HTTP/1.1 200")) {
		tunnelled = true;
		socket.write("GET /through HTTP/1.1\\r\\nHost: " + target.split(":")[0] + "\\r\\nConnection: close\\r\\n\\r\\n");
	}
});
socket.on("error", (error) => { got += "socket error " + error.code; });
socket.on("close", () => process.stdout.write(got));
socket.on("connect", () => {
	if (mode === "get") socket.write("GET http://" + target + "/hello HTTP/1.1\\r\\nHost: " + target + "\\r\\nConnection: close\\r\\n\\r\\n");
	else socket.write("CONNECT " + target + " HTTP/1.1\\r\\nHost: " + target + "\\r\\n\\r\\n");
});
`;

describe("a Docker computer whose network is an allowlist", { skip: LIVE ? false : "set AGENTRUN_COMPUTER_LIVE_DOCKER=1 to run on real Docker" }, () => {
	const run = randomBytes(6).toString("hex");
	/** The names of the computers this file made. */
	const made = new Set();
	let provider;
	let image;
	let ref;
	let connection;

	const ours = () => docker("ps", "-a", "--filter", `label=${RUN_LABEL}=${run}`, "--format", "{{.Names}}").split("\n").filter(Boolean);
	const egressOf = (name) => ({
		containers: docker("ps", "-a", "--filter", `label=agentrun.computer.egress=${name}`, "--format", "{{.Names}}").split("\n").filter(Boolean),
		volumes: docker("volume", "ls", "--filter", `label=agentrun.computer.egress=${name}`, "--format", "{{.Name}}").split("\n").filter(Boolean),
	});
	const inComputer = async (connected, argv) => {
		const ran = await connected.client.call("exec.run", { argv, timeoutMs: 30_000 });
		assert.equal(ran.ok, true, JSON.stringify(ran));
		return { ...ran.value, out: Buffer.from(ran.value.stdout, "base64").toString("utf8"), err: Buffer.from(ran.value.stderr, "base64").toString("utf8") };
	};
	const through = async (mode, target) => (await inComputer(connection, ["node", "-e", CLIENT, mode, target])).out;
	const create = async (extra = {}) => {
		const created = await provider.create({ image: EGRESS_IMAGE, lifetimeMs: 10 * 60_000, network: { allow: ALLOW }, labels: { [RUN_LABEL]: run }, ...extra });
		assert.equal(created.ok, true, JSON.stringify(created));
		made.add(created.value.name);
		return created.value;
	};

	before(async () => {
		const arch = docker("version", "--format", "{{.Server.Arch}}").trim();
		const daemonPath = fileURLToPath(new URL(`../../dist/computerd-linux-${arch}`, import.meta.url));
		assert.ok(existsSync(daemonPath), `no daemon for Docker's arch at ${daemonPath}: run npm run build:daemon`);
		const recipe = `FROM ${EGRESS_IMAGE}\nCOPY preload.mjs /fake/preload.mjs\nENV NODE_OPTIONS=--import=/fake/preload.mjs\n`;
		const hash = createHash("sha256").update(recipe).update(readFileSync(join(FIXTURE, "preload.mjs"))).digest("hex").slice(0, 12);
		image = `agentrun-computer-egress-test:${hash}`;
		execFileSync("docker", ["build", "--quiet", "--tag", image, "-f", "-", FIXTURE], { input: recipe, stdio: ["pipe", "ignore", "inherit"] });
		provider = new DockerProvider({ daemonPath, egress: { image, hint: HINT } });
		ref = await create();
		const connected = await provider.connect(ref);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		connection = connected.value;
	});

	// Every computer and proxy carries this run's label; each volume is found by the label naming its computer.
	after(async () => {
		await connection?.close();
		for (const name of ours()) execFileSync("docker", ["rm", "--force", "--volumes", name], { stdio: "ignore" });
		for (const computer of made) for (const volume of egressOf(computer).volumes) execFileSync("docker", ["volume", "rm", "--force", volume], { stdio: "ignore" });
	});

	it("reads the allowlist back from Docker in network(), list() and attach(); the computer has no network, and its proxy is hardened and on the bridge alone", async () => {
		assert.deepEqual(await provider.network(ref), { ok: true, value: { allow: ALLOW } });
		const listed = await provider.list({ [RUN_LABEL]: run });
		assert.deepEqual(listed.ok && listed.value.map((info) => [info.ref.name, info.network]), [[ref.name, { allow: ALLOW }]], "the proxy is never listed as a computer");
		const attached = await provider.attach({ id: ref.name });
		assert.equal(attached.ok, true, JSON.stringify(attached));
		assert.deepEqual(attached.value.spec.network, { allow: ALLOW });
		const computer = JSON.parse(docker("inspect", "--format", "{{json .}}", ref.name));
		assert.equal(computer.HostConfig.NetworkMode, "none");
		assert.deepEqual(Object.keys(computer.NetworkSettings.Networks), ["none"]);
		const proxy = JSON.parse(docker("inspect", "--format", "{{json .}}", `${ref.name}-egress`));
		assert.equal(proxy.HostConfig.NetworkMode, "bridge");
		assert.deepEqual(proxy.HostConfig.CapDrop, ["ALL"]);
		assert.equal(proxy.HostConfig.ReadonlyRootfs, true);
		assert.equal(proxy.HostConfig.Privileged, false);
		assert.deepEqual(proxy.HostConfig.PortBindings ?? {}, {}, "it publishes no port");
		assert.equal(proxy.Config.User, computer.Config.User, "it runs as the computer's user");
		assert.ok(!proxy.Mounts.some((mount) => /docker\.sock/.test(mount.Source ?? "")), "no Docker socket");
	});

	it("a listed host is reached: plain HTTP, a CONNECT tunnel, and an address inside a listed CIDR", async () => {
		const plain = await through("get", "origin.example");
		assert.match(plain, /^HTTP\/1\.1 200 /, plain);
		assert.match(plain, /fake origin: GET origin\.example\/hello/);
		const tunnel = await through("connect", "origin.example:443");
		assert.match(tunnel, /^HTTP\/1\.1 200 Connection Established\r\n\r\nHTTP\/1\.1 200 /, tunnel);
		assert.match(tunnel, /fake origin: GET origin\.example\/through/);
		const ranged = await through("connect", "93.184.215.14:443");
		assert.match(ranged, /^HTTP\/1\.1 200 Connection Established/, ranged);
	});

	it("an unlisted host is refused in words before any lookup: the name never leaves the proxy", async () => {
		const refused = await through("connect", "other.example:443");
		assert.match(refused, new RegExp(`^HTTP/1\\.1 403 other\\.example is not on this box's network list: ${HINT}\r\n`), refused);
		const plain = await through("get", "other.example");
		assert.match(plain, /^HTTP\/1\.1 403 /, plain);
		const outside = await through("connect", "8.8.8.8:443");
		assert.match(outside, /^HTTP\/1\.1 403 8\.8\.8\.8 is not on this box's network list/, outside);
		const port = await through("connect", "origin.example:22");
		assert.match(port, /^HTTP\/1\.1 403 origin\.example:22 is not open on this box's network list/, port);
		const logs = execFileSync("docker", ["logs", `${ref.name}-egress`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		assert.match(logs, /^fake lookup origin\.example$/m, "a listed name was looked up");
		assert.doesNotMatch(logs, /fake lookup other\.example/, "the unlisted name was never looked up");
		assert.match(logs, /^egress connect host="other\.example" port=443 ip=- class=not-listed$/m);
	});

	it("a listed name that resolves to a private, loopback or link-local address is refused by the address rule, never dialled", async () => {
		for (const [name, kind] of [["inner.example", "private"], ["loop.example", "loopback"], ["meta.example", "link-local"]]) {
			const refused = await through("connect", `${name}:443`);
			assert.match(refused, new RegExp(`^HTTP/1\\.1 403 Egress refused: ${kind}\r\n`), `${name}: ${refused}`);
			const plain = await through("get", name);
			assert.match(plain, new RegExp(`^HTTP/1\\.1 403 Egress refused: ${kind}\r\n`), `${name}: ${plain}`);
		}
	});

	it("a program that ignores the proxy reaches nothing: no route to a public address, the Docker bridge's gateway, or the proxy container", async () => {
		const bridge = JSON.parse(docker("network", "inspect", "--format", "{{json .IPAM.Config}}", "bridge"));
		const gateway = bridge.find((config) => config.Gateway)?.Gateway;
		const proxyAddress = docker("inspect", "--format", "{{.NetworkSettings.Networks.bridge.IPAddress}}", `${ref.name}-egress`).trim();
		const targets = ["93.184.215.14:443", "8.8.8.8:53", ...(gateway ? [`${gateway}:22`] : []), ...(proxyAddress ? [`${proxyAddress}:3128`] : [])];
		const probe = await inComputer(connection, ["/opt/agentrun/computerd", "probe", ...targets.flatMap((target) => ["--connect", target])]);
		assert.equal(probe.exitCode, 0, probe.err);
		assert.deepEqual(JSON.parse(probe.out).reached, [], `reached from a computer whose network is an allowlist: ${probe.out}`);
		const resolver = await inComputer(connection, ["node", "-e", "require('node:dns').lookup('origin.example', (e, a) => console.log(e ? e.code : a))"]);
		assert.notEqual(resolver.out.trim(), "93.184.215.14", "the computer has no resolver of its own");
	});

	it("a crashed proxy fails closed: the computer reaches nothing, the network reads back other, attach refuses it, and release removes it all", async () => {
		const crashed = await create();
		docker("kill", `${crashed.name}-egress`);
		const read = await provider.network(crashed);
		assert.equal(read.ok, true, JSON.stringify(read));
		assert.match(read.value.other, /egress proxy .* is not running/);
		const attached = await provider.attach({ id: crashed.name });
		assert.equal(attached.ok, false);
		assert.match(attached.error.message, /egress proxy .* is not running/);
		const connected = await provider.connect(crashed);
		assert.equal(connected.ok, true, JSON.stringify(connected));
		try {
			const answer = (await inComputer(connected.value, ["node", "-e", CLIENT, "get", "origin.example"])).out;
			assert.doesNotMatch(answer, /^HTTP\/1\.1 200/, `through a crashed proxy: ${answer}`);
		} finally {
			await connected.value.close();
		}
		assert.deepEqual(await provider.release(crashed, "delete"), { ok: true, value: undefined });
		assert.deepEqual(egressOf(crashed.name), { containers: [], volumes: [] });
		assert.ok(!ours().includes(crashed.name));
	});

	it("release(delete) removes the computer, its proxy and its volume", async () => {
		const other = await create();
		assert.deepEqual(egressOf(other.name), { containers: [`${other.name}-egress`], volumes: [`${other.name}-egress`] });
		assert.deepEqual(await provider.release(other, "delete"), { ok: true, value: undefined });
		assert.deepEqual(egressOf(other.name), { containers: [], volumes: [] });
		assert.ok(!ours().includes(other.name));
	});

	it("the proxy ends itself at the computer's deadline, and the janitor's sweep then removes the computer, its proxy and its volume", async () => {
		const short = await create({ lifetimeMs: 15_000 });
		const bound = Date.now() + 120_000;
		let state;
		for (;;) {
			state = JSON.parse(docker("inspect", "--format", "{{json .State}}", `${short.name}-egress`));
			if (!state.Running || Date.now() > bound) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		assert.equal(state.Running, false, "the proxy still ran two minutes past its deadline");
		assert.equal(state.ExitCode, 0);
		const swept = await sweep(provider, { labels: { [RUN_LABEL]: run }, now: new Date(Date.now() + 1000) });
		assert.equal(swept.ok, true, JSON.stringify(swept));
		assert.ok(swept.value.deleted.includes(short.name), JSON.stringify(swept.value));
		assert.deepEqual(egressOf(short.name), { containers: [], volumes: [] });
	});
});
