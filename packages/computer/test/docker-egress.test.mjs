// DockerProvider's network "allow" against the fake docker in test/fake-docker.mjs: the egress proxy container and its
// volume, made, read back, held to the computer and removed with it. No Docker and no network are needed.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerProvider, EGRESS_IMAGE, sweep } from "../dist/index.js";
import { checkAddress } from "../dist/docker/egress-table.js";
import { allowed, CODE_DIR, container, fakeDocker, idOf, PACKAGE_JSON, proxyReport, valuesOf } from "./fake-docker.mjs";

const ALLOW = ["pypi.org", "*.pythonhosted.org", "93.184.215.0/24"];
const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: { allow: ALLOW } };
const DEFAULT_USER = process.getuid() !== 0 && process.getgid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
const FIXED = /a Docker computer's network is fixed at create; create a new computer/;
const A = "computer-0000000000aa";
const PRIVATE_RANGE = "10.0.0.0/8"; // key-gate: denylist an allowlist entry check refuses
/** This host's own public addresses, as the provider hands them to the proxy to refuse (this-host). */
const LOCAL = [...new Set(Object.values(networkInterfaces()).flat().map((entry) => entry.address).filter((address) => checkAddress(address, []).ok))];

const runs = (calls) => calls.filter((args) => args[0] === "run");
const proxyRunOf = (calls) => runs(calls).find((args) => valuesOf(args, "--entrypoint")[0] === "node");
const computerRunOf = (calls) => runs(calls).find((args) => valuesOf(args, "--entrypoint")[0] === "/opt/agentrun/computerd");
const ref = (name) => ({ id: idOf(name), name });

test("capabilities: network none, open and allow; an allowlist holds names and CIDRs together, 256 of each, on ports 80 and 443; read back from Docker", () => {
	const { provider } = fakeDocker();
	const declared = provider.capabilities();
	assert.deepEqual(declared.network, ["none", "open", "allow"]);
	assert.deepEqual(declared.allow, { domains: { max: 256, ports: [80, 443] }, cidrs: { max: 256, ports: [80, 443] }, mixed: true });
	assert.equal(declared.networkReadBack, true);
});

test("check() takes an allowlist of names and CIDRs, and refuses one that is empty, not a list, too long, or holds an entry the proxy would not take, in words, with no docker call", () => {
	const { provider, calls } = fakeDocker();
	assert.deepEqual(provider.check(SPEC), []);
	assert.deepEqual(provider.check({ ...SPEC, network: { allow: ["PyPI.org.", "2606:4700::/32"] } }), []);
	const refusal = (allow) => provider.check({ ...SPEC, network: { allow } });
	assert.deepEqual(refusal([]), [{ field: "network", message: 'an allowlist needs at least one name or CIDR; for no network ask for "none"' }]);
	assert.deepEqual(refusal("pypi.org"), [{ field: "network", message: "an allowlist is a list of names and CIDRs, such as [\"pypi.org\", \"*.pythonhosted.org\", \"93.184.215.0/24\"]" }]);
	assert.deepEqual(refusal(["pypi.org", 443]), [{ field: "network", message: "an allowlist is a list of names and CIDRs, such as [\"pypi.org\", \"*.pythonhosted.org\", \"93.184.215.0/24\"]" }]);
	for (const [bad, words] of [
		["*", /is not a name with at least two labels/],
		["pypi.org:443", /is not a name with at least two labels/],
		["https://pypi.org", /is not a name with at least two labels/],
		["93.184.215.14", /is not a name with at least two labels/],
		["93.184.215.1/24", /host bits/],
		["10.0.0.0/8", /refused range 10\.0\.0\.0\/8/], // key-gate: denylist a refused test entry
	]) {
		const [only, ...rest] = refusal(["pypi.org", bad]);
		assert.deepEqual(rest, [], bad);
		assert.equal(only.field, "network", bad);
		assert.match(only.message, words, bad);
		assert.ok(only.message.startsWith(`the network list's entry ${JSON.stringify(bad)} `), only.message);
	}
	const names = Array.from({ length: 257 }, (_, i) => `host${i}.example.com`);
	assert.deepEqual(refusal(names), [{ field: "network", message: "a Docker allowlist holds at most 256 names, not 257" }]);
	assert.deepEqual(refusal(names.slice(0, 256)), []);
	const cidrs = Array.from({ length: 257 }, (_, i) => `93.${Math.floor(i / 256)}.${i % 256}.0/24`);
	assert.deepEqual(refusal(cidrs), [{ field: "network", message: "a Docker allowlist holds at most 256 CIDRs, not 257" }]);
	assert.deepEqual(calls(), []);
});

test("create() with an allowlist makes the volume, starts the proxy and waits for its ready line, then runs the computer with no network, the volume read-only, the proxy variables and init's relay", async () => {
	const { provider, calls, names, volumeNames } = fakeDocker();
	const made = await provider.create({ ...SPEC, labels: { team: "a" } });
	assert.equal(made.ok, true, JSON.stringify(made));
	const { name } = made.value;
	const volume = `${name}-egress`;
	assert.deepEqual(calls().map((args) => args.slice(0, 2).join(" ")), ["info --format", "volume create", "run --detach", `logs ${volume}`, "run --detach", "inspect --type", "inspect --type", "exec -i"]);
	const [uid, gid] = DEFAULT_USER.split(":");
	assert.deepEqual(calls()[1], ["volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", `o=size=1m,uid=${uid},gid=${gid},mode=0700`, "--label", `agentrun.computer.egress=${name}`, volume]);
	const computer = computerRunOf(calls());
	const deadline = valuesOf(computer, "--label").find((label) => label.startsWith("agentrun.computer.deadline="))?.split("=")[1];
	assert.deepEqual(proxyRunOf(calls()), [
		"run", "--detach", "--name", volume,
		"--label", `agentrun.computer.egress=${name}`, "--label", `agentrun.computer.deadline=${deadline}`, "--label", "team=a",
		"--user", DEFAULT_USER, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--ipc", "private", "--cgroupns", "private",
		"--pids-limit", "64", "--memory", "256m", "--memory-swap", "256m", "--log-driver", "json-file", "--log-opt", "max-size=1m", "--log-opt", "max-file=2",
		"--network", "bridge",
		"--mount", `type=volume,src=${volume},dst=/egress`,
		"--mount", `type=bind,src=${CODE_DIR},dst=/code/docker,readonly`,
		"--mount", `type=bind,src=${PACKAGE_JSON},dst=/code/package.json,readonly`,
		"--entrypoint", "node", EGRESS_IMAGE,
		"/code/docker/egress-main.js", "--socket", "/egress/egress.sock", "--deadline", deadline, "--allow", ALLOW.join(","), ...(LOCAL.length ? ["--local", LOCAL.join(",")] : []),
	]);
	assert.match(EGRESS_IMAGE, /^node:22\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}$/, "the proxy's image is pinned by digest");
	assert.deepEqual(valuesOf(computer, "--network"), ["none"], "the computer itself has no network");
	assert.deepEqual(valuesOf(computer, "--env"), ["HOME=/work"], "init's relay gives every program its proxy variables, not docker run");
	assert.deepEqual(valuesOf(computer, "--mount").at(-1), `type=volume,src=${volume},dst=/opt/agentrun/egress,readonly`);
	assert.deepEqual(computer.slice(-6), ["debian:bookworm-slim", "init", "--deadline", deadline, "--egress", "/opt/agentrun/egress/egress.sock"]);
	assert.deepEqual(names().sort(), [name, volume].sort());
	assert.deepEqual(volumeNames(), [volume]);
	assert.deepEqual(await provider.network(made.value), { ok: true, value: { allow: ALLOW } });
	const listed = await provider.list({ team: "a" });
	assert.deepEqual(listed.ok && listed.value.map((info) => [info.ref.name, info.network]), [[name, { allow: ALLOW }]], "the proxy is never listed as a computer");
	const attached = await provider.attach({ id: name });
	assert.equal(attached.ok, true, JSON.stringify(attached));
	assert.deepEqual(attached.value.spec.network, { allow: ALLOW });
});

test("create() with none or open makes no volume, no proxy, no proxy variables and no relay: the computer is as it was", async () => {
	for (const network of ["none", "open"]) {
		const { provider, calls, volumeNames } = fakeDocker();
		const made = await provider.create({ ...SPEC, network });
		assert.equal(made.ok, true, JSON.stringify(made));
		assert.deepEqual(calls().map((args) => args[0]), ["info", "run", "inspect", "exec"], network);
		const run = computerRunOf(calls());
		assert.deepEqual(valuesOf(run, "--env"), ["HOME=/work"]);
		assert.equal(run.includes("--egress"), false);
		assert.equal(valuesOf(run, "--mount").some((mount) => mount.includes("egress")), false);
		assert.deepEqual(volumeNames(), []);
	}
});

test("the egress option: another image for the proxy, a hint after its refusal's words, and how long create waits for it; a hint a status line cannot carry is refused when the provider is made", async () => {
	const { provider, calls } = fakeDocker({ egressOptions: { image: "node:22.23.4-bookworm-slim", hint: "ask the operator to add it" } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	const proxy = proxyRunOf(calls());
	assert.equal(proxy[proxy.indexOf("--entrypoint") + 2], "node:22.23.4-bookworm-slim");
	assert.deepEqual(proxy.slice(-2), ["--hint", "ask the operator to add it"]);
	for (const egress of [{ hint: "add it\r\nx: y" }, { hint: "café" }, { image: "" }, { image: "-x" }, { readyMs: 0 }, { readyMs: 2 ** 31 }]) {
		assert.throws(() => new DockerProvider({ daemonPath: "/nonexistent", egress }), /egress/, JSON.stringify(egress));
	}
});

test("the proxy's code must be built and readable by the computer's user, its directory searchable: the proxy runs as that user", async () => {
	const { egressCodeProblem } = await import("../dist/docker/egress.js");
	const dir = mkdtempSync(join(tmpdir(), "computer-egress-code-"));
	const mine = `${process.getuid()}:${process.getgid()}`;
	const other = "4242:4242";
	try {
		const packageJson = join(dir, "package.json");
		const code = { dir, packageJson };
		assert.match(egressCodeProblem(code, mine), /is not built .*egress-main\.js.*npm run build/);
		for (const file of ["egress-main.js", "egress-proxy.js", "egress-table.js", "package.json"]) {
			writeFileSync(join(dir, file), "");
			chmodSync(join(dir, file), 0o644);
		}
		chmodSync(dir, 0o755);
		assert.equal(egressCodeProblem(code, other), undefined);
		chmodSync(join(dir, "egress-proxy.js"), 0o600);
		chmodSync(dir, 0o700);
		assert.equal(egressCodeProblem(code, mine), undefined, "the owner reads its own 0600 build");
		const problem = egressCodeProblem(code, other);
		assert.match(problem, /not readable by the computer's user 4242:4242/);
		assert.ok(problem.includes(join(dir, "egress-proxy.js")) && problem.includes(`${dir},`), problem);
		assert.match(egressCodeProblem({ dir: `${dir},x`, packageJson }, mine), /not built|a comma/);
	} finally {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("create() fails closed when the proxy ends before it is ready: the computer is never run, and the proxy and its volume are removed", async () => {
	const { provider, calls, names, volumeNames } = fakeDocker({ egress: "exits" });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "docker");
	assert.match(made.error.message, /egress proxy .* ended .*: egress: no host list/);
	assert.equal(computerRunOf(calls()), undefined, "the computer was never run");
	assert.deepEqual([names(), volumeNames()], [[], []]);
});

test("create() fails closed when the proxy never says it is ready within its bound", async () => {
	const { provider, calls, names, volumeNames } = fakeDocker({ egress: "never", egressOptions: { readyMs: 300 } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "timeout");
	assert.match(made.error.message, /egress proxy .* was not ready within 0\.3 s/);
	assert.equal(computerRunOf(calls()), undefined);
	assert.deepEqual([names(), volumeNames()], [[], []]);
});

test("create() removes the proxy and its volume with a computer that is not running after its start, or that drifts", async () => {
	const stopped = fakeDocker({ running: false });
	const made = await stopped.provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.deepEqual([stopped.names(), stopped.volumeNames()], [[], []]);
	const drifted = fakeDocker({ proxyPatch: { HostConfig: { ReadonlyRootfs: false } } });
	const refused = await drifted.provider.create(SPEC);
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "refused");
	assert.match(refused.error.message, /network: declared \{"allow":.*\}, read back .*egress proxy .*read-only root/);
	assert.deepEqual([drifted.names(), drifted.volumeNames()], [[], []]);
});

test("create() refuses a computer whose init does not relay to the proxy: its network reads back other", async () => {
	const relayless = fakeDocker({ patch: { Config: { Cmd: ["init", "--deadline", "2030-01-01T00:00:00.000Z"] } } });
	const made = await relayless.provider.create(SPEC);
	assert.equal(made.ok, false);
	assert.equal(made.error.code, "refused");
	assert.match(made.error.message, /network: declared \{"allow":.*\}, read back an egress volume .* but no relay/);
	assert.deepEqual([relayless.names(), relayless.volumeNames()], [[], []]);
});

test("release(delete) removes the computer, then its proxy and its volume, each found by its label; a container or volume with the proxy's name but not its label stays", async () => {
	const seeded = allowed({ name: A, allow: ALLOW });
	const impostor = "computer-0000000000bb-egress";
	const { provider, calls, names, volumeNames } = fakeDocker({
		containers: [...seeded.containers, proxyReport({ id: idOf(impostor), name: impostor, labels: {}, cmd: [] })],
		volumes: [...seeded.volumes, { Name: "computer-0000000000bb-egress", Labels: {} }],
	});
	assert.deepEqual(await provider.release(ref(A), "delete"), { ok: true, value: undefined });
	assert.deepEqual(calls(), [
		["rm", "--force", "--volumes", A],
		["ps", "-a", "--no-trunc", "--filter", `label=agentrun.computer.egress=${A}`, "--format", "{{.ID}}"],
		["rm", "--force", idOf(`${A}-egress`)],
		["volume", "ls", "--filter", `label=agentrun.computer.egress=${A}`, "--format", "{{.Name}}"],
		["volume", "rm", "--force", `${A}-egress`],
	]);
	assert.deepEqual([names(), volumeNames()], [[impostor], ["computer-0000000000bb-egress"]]);
	const again = await provider.release(ref(A), "delete");
	assert.deepEqual(again, { ok: true, value: undefined }, "a second delete is ok");
	const bad = await provider.release({ id: "x", name: `${A}-egress` }, "delete");
	assert.equal(bad.ok, false, "a proxy is never released as a computer");
	assert.equal(bad.error.code, "invalid");
});

test("release(stop) stops the computer and its proxy; a stopped computer with its stopped proxy still reads back its allowlist", async () => {
	const { provider, calls } = fakeDocker(allowed({ name: A, allow: ALLOW }));
	assert.deepEqual(await provider.release(ref(A), "stop"), { ok: true, value: undefined });
	assert.deepEqual(calls(), [
		["stop", A],
		["ps", "-a", "--no-trunc", "--filter", `label=agentrun.computer.egress=${A}`, "--format", "{{.ID}}"],
		["stop", idOf(`${A}-egress`)],
	]);
	assert.deepEqual(await provider.network(ref(A)), { ok: true, value: { allow: ALLOW } });
	const listed = await provider.list({});
	assert.deepEqual(listed.ok && listed.value.map((info) => [info.state, info.network]), [["stopped", { allow: ALLOW }]]);
});

test("the janitor's sweep removes an expired computer's proxy and volume too, since it releases through the provider", async () => {
	const past = "2026-01-01T00:00:00.000Z";
	const { provider, names, volumeNames } = fakeDocker(allowed({ name: A, allow: ALLOW, deadline: past, running: false }));
	const swept = await sweep(provider, { now: new Date() });
	assert.deepEqual(swept, { ok: true, value: { deleted: [A], kept: 0 } });
	assert.deepEqual([names(), volumeNames()], [[], []]);
});

test("a crashed proxy fails closed: the computer reaches nothing, network() and list() read back other in words, and attach refuses it and leaves it", async () => {
	const { provider, alter, names } = fakeDocker(allowed({ name: A, allow: ALLOW }));
	alter(`${A}-egress`, (proxy) => Object.assign(proxy.State, { Running: false, Status: "exited", ExitCode: 137 }));
	const read = await provider.network(ref(A));
	assert.equal(read.ok, true);
	assert.match(read.value.other, /network allow, but its egress proxy computer-0000000000aa-egress is not running \(exit code 137\): the computer reaches nothing/);
	const listed = await provider.list({});
	assert.match(listed.value[0].network.other, /is not running/);
	const attached = await provider.attach({ id: A });
	assert.equal(attached.ok, false);
	assert.equal(attached.error.code, "refused");
	assert.match(attached.error.message, /egress proxy .* is not running/);
	assert.ok(names().includes(A), "attach leaves it as it is");
	const refused = await provider.network(ref(A), { allow: ALLOW });
	assert.equal(refused.ok, false, "asking for the allowlist it no longer has is refused");
	assert.match(refused.error.message, FIXED);
});

test("a proxy that is gone, or that is not as create makes one, reads back other, never an allowlist", async () => {
	const cases = [
		[null, /egress proxy computer-0000000000aa-egress is gone/],
		[{ HostConfig: { Privileged: true } }, /privileged/],
		[{ HostConfig: { NetworkMode: "host" } }, /network mode host/],
		[{ HostConfig: { CapDrop: [] } }, /capabilities/],
		[{ HostConfig: { SecurityOpt: [] } }, /no-new-privileges/],
		[{ Config: { User: "0:0" } }, /runs as 0:0, not the computer's 1000:1000/],
		[{ Config: { Labels: { "agentrun.computer.egress": "computer-0000000000ff" } } }, /label agentrun\.computer\.egress/],
		[{ Config: { Entrypoint: ["sh"] } }, /entrypoint/],
		[{ Config: { Cmd: ["/code/docker/egress-main.js", "--socket", "/egress/egress.sock"] } }, /no host list/],
		[{ Mounts: [] }, /mounts/],
	];
	for (const [proxy, words] of cases) {
		const seeded = allowed({ name: A, allow: ALLOW, proxy: proxy === null ? null : {} });
		if (proxy !== null) {
			const [, made] = seeded.containers;
			for (const [section, value] of Object.entries(proxy)) made[section] = Array.isArray(value) ? value : { ...made[section], ...value };
		}
		const { provider } = fakeDocker(seeded);
		const read = await provider.network(ref(A));
		assert.equal(read.ok, true, JSON.stringify(read));
		assert.equal(typeof read.value.other, "string", `${JSON.stringify(proxy)}: ${JSON.stringify(read.value)}`);
		assert.match(read.value.other, words, JSON.stringify(proxy));
	}
});

test("a computer with no network but the egress volume, or the relay, without the rest, reads back other: never none, never an allowlist", async () => {
	const relayOnly = container({ name: A, cmd: ["init", "--deadline", new Date(Date.now() + 600_000).toISOString(), "--egress", "/opt/agentrun/egress/egress.sock"] });
	const read = await fakeDocker({ containers: [relayOnly] }).provider.network(ref(A));
	assert.match(read.value.other, /relay .* but no egress volume/);
	const seeded = allowed({ name: A, allow: ALLOW });
	const [computer] = seeded.containers;
	computer.Mounts.at(-1).RW = true;
	const rw = await fakeDocker(seeded).provider.network(ref(A));
	assert.match(rw.value.other, /egress volume .* read-write/);
	const open = allowed({ name: A, allow: ALLOW });
	Object.assign(open.containers[0].HostConfig, { NetworkMode: "bridge" });
	open.containers[0].NetworkSettings = { Networks: { bridge: {} } };
	const wide = await fakeDocker(open).provider.network(ref(A));
	assert.equal(typeof wide.value.other, "string", "an egress volume on a computer with a network of its own is never an allowlist");
});

test("network() returns an allowlist the computer has, in any order and case; any other policy is refused in words, the network unchanged", async () => {
	const { provider } = fakeDocker(allowed({ name: A, allow: ALLOW }));
	assert.deepEqual(await provider.network(ref(A), { allow: ["93.184.215.0/24", "PyPI.org.", "*.pythonhosted.org"] }), { ok: true, value: { allow: ALLOW } });
	for (const policy of ["none", "open", { allow: ["pypi.org"] }, { allow: [...ALLOW, "example.com"] }]) {
		const refused = await provider.network(ref(A), policy);
		assert.equal(refused.ok, false, JSON.stringify(policy));
		assert.equal(refused.error.code, "refused");
		assert.match(refused.error.message, FIXED);
		assert.deepEqual(await provider.network(ref(A)), { ok: true, value: { allow: ALLOW } });
	}
	const none = fakeDocker({ containers: [container({ name: A })] });
	const widen = await none.provider.network(ref(A), { allow: ALLOW });
	assert.equal(widen.ok, false);
	assert.match(widen.error.message, FIXED);
	const bad = await none.provider.network(ref(A), { allow: [PRIVATE_RANGE] });
	assert.equal(bad.ok, false);
	assert.match(bad.error.message, /refused range/);
});

test("attach() reports an allowlist read back from the proxy, and refuses a computer whose proxy's deadline is not its own", async () => {
	const { provider } = fakeDocker(allowed({ name: A, allow: ALLOW, labels: { team: "a" } }));
	const byLabels = await provider.attach({ labels: { team: "a" } });
	assert.equal(byLabels.ok, true, JSON.stringify(byLabels));
	assert.deepEqual(byLabels.value.spec.network, { allow: ALLOW });
	const seeded = allowed({ name: A, allow: ALLOW });
	seeded.containers[1].Config.Labels["agentrun.computer.deadline"] = "2030-01-01T00:00:00.000Z";
	const other = await fakeDocker(seeded).provider.attach({ id: A });
	assert.equal(other.ok, false);
	assert.match(other.error.message, /deadline/);
});

test("list() inspects the allowlist computers' proxies in one call, and none for computers with no allowlist", async () => {
	const B = "computer-0000000000bb";
	const { provider, calls } = fakeDocker({ containers: [...allowed({ name: A, allow: ALLOW, labels: { run: "1" } }).containers, ...allowed({ name: B, allow: ["pypi.org"], labels: { run: "1" } }).containers, container({ name: "computer-0000000000cc", labels: { run: "1" } })] });
	const listed = await provider.list({ run: "1" });
	assert.deepEqual(listed.value.map((info) => [info.ref.name, info.network]).sort(), [[A, { allow: ALLOW }], [B, { allow: ["pypi.org"] }], ["computer-0000000000cc", "none"]]);
	const inspects = calls().filter((args) => args[0] === "inspect");
	assert.equal(inspects.length, 2, "one for the computers, one for their proxies");
	assert.deepEqual(inspects[1].slice(5).sort(), [`${A}-egress`, `${B}-egress`]);
});
