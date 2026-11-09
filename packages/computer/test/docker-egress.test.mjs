// DockerProvider's network "allow" against the fake docker in test/fake-docker.mjs: the egress proxy container and its
// volume, made, read back, held to the computer and removed with it. No Docker and no network are needed.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DockerProvider, EGRESS_IMAGE, sweep } from "../dist/index.js";
import { allowed, CODE_DIR, container, egressVolume, fakeDocker, idOf, LOCAL, PACKAGE_JSON, proxyReport, valuesOf } from "./fake-docker.mjs";

const ALLOW = ["pypi.org", "*.pythonhosted.org", "93.184.215.0/24"];
const SPEC = { image: "debian:bookworm-slim", lifetimeMs: 600_000, network: { allow: ALLOW } };
const DEFAULT_USER = process.getuid() !== 0 && process.getgid() !== 0 ? `${process.getuid()}:${process.getgid()}` : "1000:1000";
const FIXED = /a Docker computer's network is fixed at create; create a new computer/;
const A = "computer-0000000000aa";
const PRIVATE_RANGE = "10.0.0.0/8"; // key-gate: denylist an allowlist entry check refuses
/** A Docker host's own address given as egress.hostAddresses, which the proxy must refuse beside this machine's (LOCAL). */
const HOST = "93.184.215.20";

const runs = (calls) => calls.filter((args) => args[0] === "run");
const proxyRunOf = (calls) => runs(calls).find((args) => valuesOf(args, "--entrypoint")[0] === "node");
const computerRunOf = (calls) => runs(calls).find((args) => valuesOf(args, "--entrypoint")[0] === "/opt/agentrun/computerd");
const ref = (name) => ({ id: idOf(name), name });

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
	assert.deepEqual(calls().map((args) => args.slice(0, 2).join(" ")), ["info --format", "context inspect", "image inspect", "image inspect", "volume create", "run --detach", `logs ${volume}`, "run --detach", "inspect --type", "inspect --type", "exec -i"]);
	assert.deepEqual(calls()[1], ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], "where the docker CLI's daemon is, as the CLI itself resolves it");
	// Both images are on the host before anything is made: the computer's, then the proxy's.
	assert.deepEqual(calls().slice(2, 4), [["image", "inspect", "--format", "{{.Id}}", "debian:bookworm-slim"], ["image", "inspect", "--format", "{{.Id}}", EGRESS_IMAGE]]);
	const [uid, gid] = DEFAULT_USER.split(":");
	const computer = computerRunOf(calls());
	const deadline = valuesOf(computer, "--label").find((label) => label.startsWith("agentrun.computer.deadline="))?.split("=")[1];
	assert.deepEqual(valuesOf(computer, "--pull"), ["never"], "the computer's run never pulls");
	// The volume carries the computer's name, its deadline and the spec's labels, so the janitor finds it with no computer.
	assert.deepEqual(calls()[4], [
		"volume", "create", "--driver", "local", "--opt", "type=tmpfs", "--opt", "device=tmpfs", "--opt", `o=size=1m,uid=${uid},gid=${gid},mode=0700`,
		"--label", `agentrun.computer.egress=${name}`, "--label", `agentrun.computer.deadline=${deadline}`, "--label", "team=a", volume,
	]);
	assert.deepEqual(proxyRunOf(calls()), [
		"run", "--detach", "--name", volume,
		"--label", `agentrun.computer.egress=${name}`, "--label", `agentrun.computer.deadline=${deadline}`, "--label", "team=a",
		"--user", DEFAULT_USER, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--ipc", "private", "--cgroupns", "private",
		"--pids-limit", "64", "--memory", "256m", "--memory-swap", "256m", "--cpu-period", "100000", "--cpu-quota", "50000", "--ulimit", "nofile=1024:1024",
		"--log-driver", "json-file", "--log-opt", "max-size=1m", "--log-opt", "max-file=2",
		"--network", "bridge",
		"--mount", `type=volume,src=${volume},dst=/egress`,
		"--mount", `type=bind,src=${CODE_DIR},dst=/code/docker,readonly`,
		"--mount", `type=bind,src=${PACKAGE_JSON},dst=/code/package.json,readonly`,
		"--pull", "never", "--entrypoint", "node", EGRESS_IMAGE,
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
		// The image is not on the host: docker run pulls it, as before, with no image inspect or pull of its own.
		const { provider, calls, volumeNames } = fakeDocker({ images: [] });
		const made = await provider.create({ ...SPEC, network });
		assert.equal(made.ok, true, JSON.stringify(made));
		assert.deepEqual(calls().map((args) => args[0]), ["info", "run", "inspect", "exec"], network);
		const run = computerRunOf(calls());
		assert.deepEqual(valuesOf(run, "--env"), ["HOME=/work"]);
		assert.equal(run.includes("--pull"), false, network);
		assert.equal(run.includes("--egress"), false);
		assert.equal(valuesOf(run, "--mount").some((mount) => mount.includes("egress")), false);
		assert.deepEqual(volumeNames(), []);
	}
});

test("create() with an allowlist pulls an image the host lacks before it makes anything, and both runs take --pull never: no pull happens between the egress volume and the computer", async () => {
	for (const [images, pulled] of [[[EGRESS_IMAGE], ["debian:bookworm-slim"]], [["debian:bookworm-slim"], [EGRESS_IMAGE]], [[], ["debian:bookworm-slim", EGRESS_IMAGE]]]) {
		const { provider, calls, names, volumeNames } = fakeDocker({ images });
		const made = await provider.create(SPEC);
		assert.equal(made.ok, true, JSON.stringify(made));
		const all = calls();
		const volume = all.findIndex((args) => args[0] === "volume" && args[1] === "create");
		assert.deepEqual(all.filter((args) => args[0] === "pull"), pulled.map((image) => ["pull", image]), `on a host with ${JSON.stringify(images)}`);
		for (const image of pulled) assert.ok(all.findIndex((args) => args[0] === "pull" && args[1] === image) < volume, `${image} is pulled before the egress volume is made`);
		assert.deepEqual(valuesOf(proxyRunOf(all), "--pull"), ["never"], "the proxy's run never pulls");
		assert.deepEqual(valuesOf(computerRunOf(all), "--pull"), ["never"], "the computer's run never pulls");
		assert.deepEqual([names().length, volumeNames().length], [2, 1]);
	}
});

test("create() with an allowlist fails in words naming the image when its pull fails, before any volume or container is made", async () => {
	const { provider, calls, names, volumeNames } = fakeDocker({ images: [EGRESS_IMAGE], pull: "fails" });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, false, JSON.stringify(made));
	assert.equal(made.error.code, "docker");
	assert.match(made.error.message, /^docker pull debian:bookworm-slim failed, so nothing was made: .*pull access denied for debian:bookworm-slim/);
	assert.deepEqual(calls().filter((args) => args[0] === "volume" || args[0] === "run"), [], "no volume, no proxy, no computer");
	assert.deepEqual([names(), volumeNames()], [[], []]);
});

test("create() aborted while it pulls an image stays aborted, and nothing is made", async () => {
	const { provider, calls, names, volumeNames, proceed } = fakeDocker({ images: [EGRESS_IMAGE], hold: ["pull"] });
	const controller = new AbortController();
	try {
		const pending = provider.create(SPEC, { signal: controller.signal });
		for (let i = 0; i < 500 && !calls().some((args) => args[0] === "pull"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		const made = await pending;
		assert.equal(made.ok, false, JSON.stringify(made));
		assert.equal(made.error.code, "aborted", made.error.message);
		assert.match(made.error.message, /debian:bookworm-slim/);
		assert.deepEqual(calls().filter((args) => args[0] === "volume" || args[0] === "run"), [], "no volume, no proxy, no computer");
		assert.deepEqual([names(), volumeNames()], [[], []]);
	} finally {
		proceed("pull");
	}
});

test("the egress option: another image for the proxy, a hint after its refusal's words, and how long create waits for it; a hint a status line cannot carry is refused when the provider is made", async () => {
	const { provider, calls } = fakeDocker({ egressOptions: { image: "node:22.23.4-bookworm-slim", hint: "ask the operator to add it" } });
	const made = await provider.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	const proxy = proxyRunOf(calls());
	assert.equal(proxy[proxy.indexOf("--entrypoint") + 2], "node:22.23.4-bookworm-slim");
	assert.deepEqual(proxy.slice(-2), ["--hint", "ask the operator to add it"]);
	for (const egress of [{ hint: "add it\r\nx: y" }, { hint: "café" }, { image: "" }, { image: "-x" }, { readyMs: 0 }, { readyMs: 2 ** 31 }, { hostAddresses: "93.184.215.20" }, { hostAddresses: ["not-an-address"] }, { hostAddresses: ["93.184.215.0/24"] }, { hostAddresses: [7] }]) {
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

test("an allowlist on a host that remaps user ids is refused in words before any volume or container: the proxy's socket and code are owned by host ids the computer does not have", async () => {
	for (const [remap, words] of [["userns", "userns-remap"], ["rootless", "rootless Docker"]]) {
		const { provider, calls, names, volumeNames } = fakeDocker({ info: { SecurityOptions: ["name=seccomp,profile=builtin", `name=${remap}`, "name=cgroupns"] } });
		const result = await provider.create(SPEC);
		assert.equal(result.ok, false, `${remap}: ${JSON.stringify(result)}`);
		assert.equal(result.error.code, "refused");
		assert.match(result.error.message, new RegExp(`^network: this Docker host remaps user ids \\(${words}\\), so .*an allowlist.* ask for network none or open, or use a Docker host that does not remap ids$`), remap);
		assert.deepEqual(calls().map((args) => args[0]), ["info"], `${remap}: nothing is made`);
		assert.deepEqual([names(), volumeNames()], [[], []]);
		// Once the host is read, check() says so too, for an allowlist alone.
		assert.deepEqual(provider.check(SPEC).map((r) => r.field), ["network"], remap);
		assert.deepEqual(provider.check({ ...SPEC, network: "none" }), [], `${remap}: network none`);
		assert.equal((await provider.create({ ...SPEC, network: "open" })).ok, true, `${remap}: network open is made as before`);
	}
});

test("an allowlist whose Docker host is not where this provider runs (a daemon that is not a local unix socket) is refused in words before anything is made, unless egress.hostAddresses names the host's addresses", async () => {
	for (const [endpoint, said] of [["tcp://docker.example.com:2376", /talks to a Docker daemon at tcp:\/\/docker\.example\.com:2376, not a local unix socket/], ["ssh://builder@docker.example.com", /not a local unix socket/], [null, /could not say where its Docker daemon is/]]) {
		const { provider, calls, names, volumeNames } = fakeDocker({ endpoint });
		const refused = await provider.create(SPEC);
		assert.equal(refused.ok, false, `${endpoint}: ${JSON.stringify(refused)}`);
		assert.equal(refused.error.code, "refused");
		assert.match(refused.error.message, said, String(endpoint));
		assert.match(refused.error.message, /^network: .*so this provider's own interfaces are not the Docker host's, and the egress proxy could not refuse the host's own addresses: pass them as egress\.hostAddresses, or ask for network none or open$/, String(endpoint));
		assert.deepEqual(calls().map((args) => args[0]), ["info", "context"], `${endpoint}: nothing is made`);
		assert.deepEqual([names(), volumeNames()], [[], []]);
		// Once it is known, check() says so too, for an allowlist alone; none and open are made as before.
		assert.deepEqual(provider.check(SPEC).map((r) => r.field), ["network"], String(endpoint));
		assert.deepEqual(provider.check({ ...SPEC, network: "none" }), []);
		assert.equal((await provider.create({ ...SPEC, network: "open" })).ok, true, `${endpoint}: network open`);
	}
	const HOST = ["93.184.215.20", "2606:4700::20"];
	const given = fakeDocker({ endpoint: "tcp://docker.example.com:2376", egressOptions: { hostAddresses: HOST } });
	const made = await given.provider.create(SPEC);
	assert.equal(made.ok, true, JSON.stringify(made));
	assert.ok(!given.calls().some((args) => args[0] === "context"), "with the host's addresses given, where the daemon is does not matter");
	const proxy = proxyRunOf(given.calls());
	const local = proxy[proxy.indexOf("--local") + 1]?.split(",");
	for (const address of HOST) assert.ok(local?.includes(address), `${address} reaches the proxy's --local: ${proxy.join(" ")}`);
});

test("an allowlist from a provider whose host root shows it runs in a container (egress.hostRoot with /.dockerenv) is refused in words before anything is made, unless egress.hostAddresses names the host's addresses", async () => {
	const root = mkdtempSync(join(tmpdir(), "computer-in-container-"));
	try {
		writeFileSync(join(root, ".dockerenv"), "");
		const { provider, calls, names, volumeNames } = fakeDocker({ egressOptions: { hostRoot: root } });
		const refused = await provider.create(SPEC);
		assert.equal(refused.ok, false, JSON.stringify(refused));
		assert.equal(refused.error.code, "refused");
		assert.match(refused.error.message, /^network: this provider runs in a container \(\/\.dockerenv exists\), so this provider's own interfaces are not the Docker host's/);
		assert.deepEqual(calls().map((args) => args[0]), ["info"], "nothing is made, and the docker CLI is not asked where its daemon is");
		assert.deepEqual([names(), volumeNames()], [[], []]);
		assert.deepEqual(provider.check(SPEC).map((r) => r.field), ["network"]);
		const given = fakeDocker({ egressOptions: { hostRoot: root, hostAddresses: ["93.184.215.20"] } });
		assert.equal((await given.provider.create(SPEC)).ok, true, "with the host's addresses given");
		for (const hostRoot of ["", "relative/root", 7]) assert.throws(() => new DockerProvider({ daemonPath: "/nonexistent", egress: { hostRoot } }), /egress/, JSON.stringify(hostRoot));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("containerSigns() names what shows this provider runs in a container: /.dockerenv, /run/.containerenv, or a container's cgroup; a plain host shows none", async () => {
	const { containerSigns } = await import("../dist/docker/egress.js");
	const root = mkdtempSync(join(tmpdir(), "computer-container-signs-"));
	try {
		mkdirSync(join(root, "proc", "self"), { recursive: true });
		mkdirSync(join(root, "run"), { recursive: true });
		writeFileSync(join(root, "proc", "self", "cgroup"), "0::/user.slice/user-1000.slice/session-3.scope\n");
		assert.equal(containerSigns(root), undefined, "a host's cgroup");
		writeFileSync(join(root, "proc", "self", "cgroup"), "0::/\n");
		assert.equal(containerSigns(root), undefined, "a cgroup namespace's root is not evidence");
		for (const cgroup of ["0::/system.slice/docker-0123456789abcdef.scope\n", "12:pids:/docker/0123456789abcdef\n", "0::/kubepods/besteffort/pod1/abc\n", "0::/machine.slice/libpod-0123.scope\n"]) {
			writeFileSync(join(root, "proc", "self", "cgroup"), cgroup);
			assert.match(containerSigns(root) ?? "", /a container's cgroup/, cgroup);
		}
		writeFileSync(join(root, "proc", "self", "cgroup"), "0::/\n");
		writeFileSync(join(root, "run", ".containerenv"), "");
		assert.match(containerSigns(root) ?? "", /\/run\/\.containerenv/);
		writeFileSync(join(root, ".dockerenv"), "");
		assert.match(containerSigns(root) ?? "", /\/\.dockerenv/);
	} finally {
		rmSync(root, { recursive: true, force: true });
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

for (const step of ["logs", "inspect"]) {
	test(`create() keeps to the proxy's readiness bound when docker ${step} stops answering in the readiness poll: timeout in words, and the proxy and its volume removed`, async () => {
		// The proxy never says it is ready, so the poll asks docker logs, then docker inspect; the held step never answers.
		const { provider, calls, names, volumeNames, proceed } = fakeDocker({ egress: "never", hold: [step], egressOptions: { readyMs: 400 } });
		// The test's own bound, far under the held step's minute: a create that outwaits the 0.4 s readiness bound is
		// aborted here and answers aborted, not timeout. No wall-clock margin that a busy host can miss.
		const controller = new AbortController();
		const stop = setTimeout(() => controller.abort(), 30_000);
		try {
			const made = await provider.create(SPEC, { signal: controller.signal });
			assert.equal(made.ok, false, JSON.stringify(made));
			assert.equal(made.error.code, "timeout", made.error.message);
			assert.match(made.error.message, /egress proxy .* was not ready within 0\.4 s/);
			assert.ok(calls().some((args) => args[0] === step), `docker ${step} was called`);
			assert.equal(computerRunOf(calls()), undefined, "the computer was never run");
			assert.deepEqual([names(), volumeNames()], [[], []], "the proxy and its volume were removed");
		} finally {
			clearTimeout(stop);
			proceed(step);
		}
	});
}

test("create() aborted by its caller during the readiness poll stays aborted, not timeout", async () => {
	const { provider, calls, names, volumeNames, proceed } = fakeDocker({ egress: "never", hold: ["logs"], egressOptions: { readyMs: 60_000 } });
	const controller = new AbortController();
	try {
		const pending = provider.create(SPEC, { signal: controller.signal });
		for (let i = 0; i < 500 && !calls().some((args) => args[0] === "logs"); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		const made = await pending;
		assert.equal(made.ok, false);
		assert.equal(made.error.code, "aborted", made.error.message);
		assert.deepEqual([names(), volumeNames()], [[], []]);
	} finally {
		proceed("logs");
	}
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
	assert.deepEqual(swept, { ok: true, value: { deleted: [A], kept: 0, leftovers: [] } });
	assert.deepEqual([names(), volumeNames()], [[], []]);
});

test("the janitor's sweep also removes a proxy or volume whose computer is gone, or whose deadline has passed, by its label; a live computer's, and a proxy just made, stay", async () => {
	const live = allowed({ name: A, allow: ALLOW, labels: { run: "1" } });
	const B = "computer-0000000000bb"; // gone by hand: its proxy and volume stay behind
	const C = "computer-0000000000cc"; // the provider died after the volume, before the proxy
	const D = "computer-0000000000dd"; // its create is under way: the proxy is seconds old, with no computer yet
	const E = "computer-0000000000ee"; // its computer is gone and its deadline has passed, made moments ago
	const past = "2026-01-01T00:00:00.000Z";
	const now = new Date().toISOString();
	const proxyOf = (name, extra = {}) => proxyReport({ id: idOf(`${name}-egress`), name: `${name}-egress`, labels: { run: "1", "agentrun.computer.egress": name, "agentrun.computer.deadline": extra.deadline ?? new Date(Date.now() + 600_000).toISOString() }, cmd: [], ...extra });
	const impostor = proxyReport({ id: idOf("computer-0000000000ff-egress"), name: "computer-0000000000ff-egress", labels: { run: "1" }, cmd: [] });
	const { provider, calls, names, volumeNames } = fakeDocker({
		containers: [...live.containers, proxyOf(B), proxyOf(D, { created: now }), proxyOf(E, { created: now, deadline: past }), impostor],
		volumes: [...live.volumes, egressVolume({ computer: B, labels: { run: "1" } }), egressVolume({ computer: C, labels: { run: "1" } }), egressVolume({ computer: D, labels: { run: "1" }, created: now }), { Name: "computer-0000000000ff-egress", Labels: { run: "1" } }],
	});
	const swept = await sweep(provider, { labels: { run: "1" }, now: new Date() });
	assert.equal(swept.ok, true, JSON.stringify(swept));
	assert.deepEqual(swept.value.deleted, []);
	assert.equal(swept.value.kept, 1);
	assert.deepEqual(swept.value.leftovers.sort(), [`${B}-egress`, `${B}-egress (volume)`, `${C}-egress (volume)`, `${E}-egress`].sort());
	assert.deepEqual(names().sort(), [A, `${A}-egress`, `${D}-egress`, "computer-0000000000ff-egress"].sort(), "a live computer's proxy, one just made, and a container without the label stay");
	assert.deepEqual(volumeNames().sort(), [`${A}-egress`, `${D}-egress`, "computer-0000000000ff-egress"].sort());
	assert.ok(calls().every((args) => !(args[0] === "rm" && args.at(-1) === "computer-0000000000ff-egress")), "a container is never removed by its name alone");
	// A sweep scoped to other labels touches none of them.
	const other = fakeDocker({ containers: [proxyOf(B)], volumes: [egressVolume({ computer: C, labels: { run: "1" } })] });
	const scoped = await sweep(other.provider, { labels: { run: "2" }, now: new Date() });
	assert.deepEqual(scoped, { ok: true, value: { deleted: [], kept: 0, leftovers: [] } });
	assert.deepEqual([other.names(), other.volumeNames()], [[`${B}-egress`], [`${C}-egress`]]);
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
		// The bounds create sets: memory, swap, pids, its own IPC and cgroup namespaces, and a bounded json-file log.
		[{ HostConfig: { Memory: 0 } }, /memory 0, not 268435456/],
		[{ HostConfig: { Memory: 512 * 1024 * 1024 } }, /memory 536870912, not 268435456/],
		[{ HostConfig: { MemorySwap: -1 } }, /memory swap -1, not 268435456/],
		[{ HostConfig: { PidsLimit: 0 } }, /pids limit 0, not 64/],
		[{ HostConfig: { PidsLimit: null } }, /pids limit null, not 64/],
		[{ HostConfig: { IpcMode: "host" } }, /IPC mode "host", not "private"/],
		[{ HostConfig: { IpcMode: "shareable" } }, /IPC mode "shareable", not "private"/],
		[{ HostConfig: { CgroupnsMode: "host" } }, /cgroup namespace "host", not "private"/],
		[{ HostConfig: { LogConfig: { Type: "json-file", Config: {} } } }, /log .*not json-file with max-size 1m and max-file 2/],
		[{ HostConfig: { LogConfig: { Type: "json-file", Config: { "max-size": "1g", "max-file": "2" } } } }, /log .*not json-file with max-size 1m and max-file 2/],
		[{ HostConfig: { LogConfig: { Type: "syslog", Config: { "max-size": "1m", "max-file": "2" } } } }, /log .*not json-file/],
		// Half a CPU, and at most 1024 open files.
		[{ HostConfig: { CpuQuota: 0 } }, /CPU quota 0 of 100000, not 50000/],
		[{ HostConfig: { CpuQuota: 200_000 } }, /CPU quota 200000 of 100000, not 50000/],
		[{ HostConfig: { CpuPeriod: 0 } }, /CPU quota 50000 of 0, not 50000 of 100000/],
		[{ HostConfig: { Ulimits: [] } }, /open-file limit .*not nofile 1024:1024/],
		[{ HostConfig: { Ulimits: [{ Name: "nofile", Hard: 1048576, Soft: 1024 }] } }, /open-file limit .*not nofile 1024:1024/],
		[{ HostConfig: { Ulimits: [{ Name: "nofile", Hard: 1024, Soft: 1024 }, { Name: "nproc", Hard: 1, Soft: 1 }] } }, /open-file limit .*not nofile 1024:1024/],
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

/** A regular expression's source that matches `text` as it is. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("egressOf() holds the proxy's --local to every address required, in any order, more being fine; with none required a proxy with no --local is fine", async () => {
	const { egressOf } = await import("../dist/docker/egress.js");
	const deadline = new Date(Date.now() + 600_000).toISOString();
	const proxyWith = (local) => allowed({ name: A, allow: ALLOW, deadline, local }).containers[1];
	const owner = { name: A, user: "1000:1000", deadline, running: true };
	const required = ["93.184.215.20", "2606:4700::20"];
	assert.deepEqual(egressOf(proxyWith(required), owner, undefined, required), { allow: ALLOW });
	assert.deepEqual(egressOf(proxyWith([...required].reverse()), owner, undefined, required), { allow: ALLOW });
	assert.deepEqual(egressOf(proxyWith([...required, "93.184.215.21"]), owner, undefined, required), { allow: ALLOW });
	assert.deepEqual(egressOf(proxyWith([required[0]]), owner, undefined, required), {
		other: `network allow, but its egress proxy ${A}-egress does not refuse the Docker host's address 2606:4700::20 (its --local reads "93.184.215.20")`,
	});
	assert.deepEqual(egressOf(proxyWith([]), owner, undefined, required), {
		other: `network allow, but its egress proxy ${A}-egress does not refuse the Docker host's addresses 93.184.215.20, 2606:4700::20 (its --local reads nothing)`,
	});
	assert.deepEqual(egressOf(proxyWith([]), owner, undefined, []), { allow: ALLOW });
});

test("a proxy whose --local was removed, or lacks one of the Docker host's addresses the provider requires (this machine's and egress.hostAddresses), reads back other in network(), list() and attach()", async () => {
	const required = [...LOCAL, HOST];
	const read = async (local) => {
		const { provider } = fakeDocker({ ...allowed({ name: A, allow: ALLOW, local }), egressOptions: { hostAddresses: [HOST] } });
		return { network: await provider.network(ref(A)), listed: await provider.list({}), attached: await provider.attach({ id: A }) };
	};
	for (const local of [required, [...required].reverse(), [...required, "93.184.215.21"]]) {
		const { network, listed, attached } = await read(local);
		assert.deepEqual(network, { ok: true, value: { allow: ALLOW } }, `--local ${local.join(",")}`);
		assert.deepEqual(listed.ok && listed.value.map((info) => info.network), [{ allow: ALLOW }]);
		assert.equal(attached.ok, true, JSON.stringify(attached));
	}
	// Removed, short of egress.hostAddresses, and short of this machine's own (when it has public ones).
	for (const [local, missing] of [[[], required], [LOCAL, [HOST]], ...(LOCAL.length > 0 ? [[[HOST], LOCAL]] : [])]) {
		const words = new RegExp(`egress proxy ${A}-egress does not refuse the Docker host's address(es)? ${literal(missing.join(", "))} \\(its --local reads `);
		const { network, listed, attached } = await read(local);
		assert.equal(network.ok, true, JSON.stringify(network));
		assert.match(network.value.other ?? JSON.stringify(network.value), words, `--local ${local.join(",")}`);
		assert.match(listed.value[0].network.other ?? JSON.stringify(listed.value[0].network), words);
		assert.equal(attached.ok, false, JSON.stringify(attached));
		assert.equal(attached.error.code, "refused");
		assert.match(attached.error.message, words);
	}
});

test("create() refuses a proxy that does not run with the Docker host's addresses it was given, removed or shortened: the drift check reads other and removes it all", async () => {
	for (const proxyLocal of [[], LOCAL]) {
		const { provider, names, volumeNames } = fakeDocker({ proxyLocal, egressOptions: { hostAddresses: [HOST] } });
		const made = await provider.create(SPEC);
		assert.equal(made.ok, false, JSON.stringify(made));
		assert.equal(made.error.code, "refused", made.error.message);
		assert.match(made.error.message, new RegExp(`network: declared \\{"allow":.*\\}, read back .*does not refuse the Docker host's address(es)? .*${literal(HOST)}`));
		assert.deepEqual([names(), volumeNames()], [[], []]);
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
