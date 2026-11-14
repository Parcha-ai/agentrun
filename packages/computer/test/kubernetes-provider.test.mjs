// The Kubernetes host (src/kubernetes.ts), its transport's WebSocket and status table (src/kubernetes-api.ts), its auth
// (src/kubernetes-auth.ts) and Google ADC (src/google-adc.ts). No cluster and no network: a fake transport answers the
// API, a socket pair carries the WebSocket, and a fake fetch answers Google. The live proof is test/kubernetes/.
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { KUBERNETES } from "../dist/descriptors/kubernetes.js";
import { GKE_SCOPES, googleAdc } from "../dist/google-adc.js";
import { CLAIM_API, KubernetesHost, LABELS_ANNOTATION, POD_NAME_ANNOTATION, processOf, SLEEPER, create } from "../dist/kubernetes.js";
import { answerError, EXEC_PROTOCOLS, execStatus, kubeCode, webSocket } from "../dist/kubernetes-api.js";
import { resolveEndpoint } from "../dist/kubernetes-auth.js";
import { failAs } from "../dist/result.js";

const ok = (value) => ({ ok: true, value });
/** A placeholder PEM block of `label` (no real key or certificate), base64 as a kubeconfig holds it. */
const pem = (label, body) => Buffer.from(["-----BEGIN", label + "-----\n" + body + "\n-----END", label + "-----"].join(" ")).toString("base64");
/** Fake token values, named by role. */
const FAKE = { federated: ["fed", "erated"].join(""), impersonated: ["imper", "sonated"].join(""), serviceAccount: ["sa", "token"].join("-") };

/** A fake transport: each call answered by the first route whose method and path match; every call recorded. */
function fakeApi(routes) {
	const calls = [];
	return {
		calls,
		call: async (method, path, init) => {
			calls.push({ method, path, init });
			for (const route of routes) {
				if (route.method === method && (typeof route.path === "string" ? route.path === path : route.path.test(path))) return route.answer(init, calls.length);
			}
			return { ok: false, error: answerError(`${method} ${path}`, 404, '{"message":"not found"}') };
		},
		stream: async (path, query, protocols) => {
			calls.push({ method: "STREAM", path, query, protocols });
			return routes.find((route) => route.method === "STREAM")?.answer(query) ?? { ok: false, error: { code: "not_found", message: "no exec" } };
		},
	};
}

const hostOf = (api, extra = {}) => new KubernetesHost({ api, namespace: "computers", object: "pod", image: "example.test/box:1", arch: "amd64", maxLifetimeMs: 86_400_000, requestMs: 1000, ...extra });
const ctx = { timeoutMs: 1000 };
const req = { name: "computer-0123456789ab", image: "default", labels: { "agentrun.computer": "1", "agentrun.computer.name": "computer-0123456789ab", "agentrun.computer.deadline": "2026-11-14T12:00:00.000Z", "agentrun.run": "r1" }, network: "none" };

test("the status table: 401/403 denied, a quota's 403 limit, 404 not_found, 409 exists, 429 limit, 504 timeout, and 429 and 5xx alone transient", () => {
	assert.equal(kubeCode(401, ""), "denied");
	assert.equal(kubeCode(403, 'pods "x" is forbidden: exceeded quota: q'), "limit");
	assert.equal(kubeCode(404, ""), "not_found");
	assert.equal(kubeCode(409, ""), "exists");
	assert.equal(kubeCode(422, ""), "invalid");
	for (const status of [429, 500, 502, 503, 504]) assert.equal(answerError("GET /x", status, "").transient, true, String(status));
	for (const status of [400, 401, 403, 404, 409, 422]) assert.equal(answerError("GET /x", status, "").transient, undefined, String(status));
	// The API server's own words, never the body's JSON.
	assert.equal(answerError("GET /x", 403, '{"kind":"Status","message":"pods is forbidden: User \\"u\\" cannot list"}').message, 'GET /x: 403 pods is forbidden: User "u" cannot list');
	// failAs keeps transient through a rewording of the same code, and drops it when the code changes.
	assert.equal(failAs(answerError("GET /x", 503, ""), "again").error.transient, true);
	assert.equal(failAs(answerError("GET /x", 503, ""), "again", "invalid").error.transient, undefined);
});

test("the descriptor: a sandbox, no mount (Archil refused in words), network none, every key optional, the server's in-cluster and Google variables", () => {
	assert.deepEqual(KUBERNETES.mounts, []);
	assert.match(KUBERNETES.unmounted.archil, /gVisor/);
	assert.deepEqual(KUBERNETES.network, ["none"]);
	assert.ok(KUBERNETES.keys.every((key) => key.required === false));
	assert.deepEqual(KUBERNETES.hostEnv, ["KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT", "GOOGLE_APPLICATION_CREDENTIALS"]);
	assert.equal(KUBERNETES.imageEnv, "AGENTRUN_KUBERNETES_IMAGE");
});

test("create makes a root pod that sleeps, with no service account token, the backstop deadline, the runtime class, and the labels in one annotation", async () => {
	const api = fakeApi([{ method: "POST", path: "/api/v1/namespaces/computers/pods", answer: () => ok({ status: 201, body: {} }) }]);
	const host = hostOf(api, { runtimeClass: "gvisor" });
	assert.equal(host.facts.isolation, "gvisor");
	assert.deepEqual(await host.create({ ...req, cpus: 2, memoryMb: 4096 }, ctx), ok({ id: req.name }));
	const pod = api.calls[0].init.json;
	assert.equal(pod.metadata.name, req.name);
	assert.deepEqual(pod.metadata.labels, { "agentrun.computer": "1", "agentrun.computer.name": req.name });
	assert.deepEqual(JSON.parse(pod.metadata.annotations[LABELS_ANNOTATION]), req.labels);
	assert.equal(pod.spec.automountServiceAccountToken, false);
	assert.equal(pod.spec.enableServiceLinks, false);
	assert.equal(pod.spec.restartPolicy, "Never");
	assert.equal(pod.spec.activeDeadlineSeconds, 86_400);
	assert.equal(pod.spec.runtimeClassName, "gvisor");
	assert.equal(pod.spec.containers[0].image, "example.test/box:1");
	assert.deepEqual(pod.spec.containers[0].command, SLEEPER);
	assert.deepEqual(pod.spec.containers[0].securityContext, { runAsUser: 0, runAsGroup: 0 });
	assert.deepEqual(pod.spec.containers[0].resources.limits, { cpu: "2", memory: "4096Mi" });
});

test("create of a name the namespace holds is exists; a refusal names the RBAC it needs; a 503 stays transient", async () => {
	const taken = hostOf(fakeApi([{ method: "POST", path: /pods$/, answer: () => ({ ok: false, error: answerError("POST /pods", 409, '{"message":"already exists"}') }) }]));
	assert.equal((await taken.create(req, ctx)).error.code, "exists");
	const denied = hostOf(fakeApi([{ method: "POST", path: /pods$/, answer: () => ({ ok: false, error: answerError("POST /pods", 403, '{"message":"forbidden"}') }) }]));
	const refused = await denied.create(req, ctx);
	assert.equal(refused.error.code, "denied");
	assert.match(refused.error.message, /needs create, get, list, delete and patch on pods/);
	const down = hostOf(fakeApi([{ method: "POST", path: /pods$/, answer: () => ({ ok: false, error: answerError("POST /pods", 503, "") }) }]));
	const failed = await down.create(req, ctx);
	assert.equal(failed.error.transient, true);
});

test("the claim model makes a SandboxClaim against the warm pool, with a shutdownTime backstop, and reads its pod through the Sandbox", async () => {
	const claimPath = `/apis/${CLAIM_API}/namespaces/computers/sandboxclaims`;
	const claim = { metadata: { name: req.name, creationTimestamp: "2026-11-14T10:00:00Z", annotations: { [LABELS_ANNOTATION]: JSON.stringify(req.labels) } }, spec: { warmPoolRef: { name: "pool-a" } }, status: { sandbox: { name: "sb-1" } } };
	const api = fakeApi([
		{ method: "POST", path: claimPath, answer: () => ok({ status: 201, body: {} }) },
		{ method: "GET", path: `${claimPath}/${req.name}`, answer: () => ok({ status: 200, body: claim }) },
		{ method: "GET", path: "/apis/agents.x-k8s.io/v1beta1/namespaces/computers/sandboxes/sb-1", answer: () => ok({ status: 200, body: { metadata: { name: "sb-1", annotations: { [POD_NAME_ANNOTATION]: "pod-xyz" } } } }) },
		{ method: "GET", path: "/api/v1/namespaces/computers/pods/pod-xyz", answer: () => ok({ status: 200, body: { metadata: { name: "pod-xyz" }, spec: { containers: [{ name: "main" }] }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } } }) },
	]);
	const host = new KubernetesHost({ api, namespace: "computers", object: "claim", warmPool: "pool-a", arch: "amd64", maxLifetimeMs: 3_600_000, requestMs: 1000 });
	assert.equal(host.facts.specFields, undefined);
	await host.create(req, ctx);
	const body = api.calls[0].init.json;
	assert.equal(body.kind, "SandboxClaim");
	assert.deepEqual(body.spec.warmPoolRef, { name: "pool-a" });
	assert.equal(body.spec.lifecycle.shutdownPolicy, "Delete");
	assert.ok(Math.abs(Date.parse(body.spec.lifecycle.shutdownTime) - Date.now() - 3_600_000) < 5_000);
	const machine = await host.get(req.name, ctx);
	assert.equal(machine.value.state, "running");
	assert.deepEqual(machine.value.labels, req.labels);
	assert.deepEqual(machine.value.image, { resolved: "pool-a" });
	// exec reaches the Sandbox's pod and its first container.
	await host.exec(req.name, ["true"], { stdin: false }, ctx);
	const stream = api.calls.find((call) => call.method === "STREAM");
	assert.equal(stream.path, "/api/v1/namespaces/computers/pods/pod-xyz/exec");
	assert.deepEqual(stream.query.slice(0, 3), [["container", "main"], ["stdout", "true"], ["stderr", "true"]]);
	assert.deepEqual(stream.protocols, [...EXEC_PROTOCOLS]);
});

test("get reads a pod's state: pending starting, ready running, a bad image failed with why, deleting going, gone undefined", async () => {
	const pods = {
		p1: { status: { phase: "Pending", conditions: [{ type: "PodScheduled", status: "False", message: "0/3 nodes are available" }] } },
		p2: { status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } },
		p3: { status: { phase: "Pending", containerStatuses: [{ name: "computer", state: { waiting: { reason: "ImagePullBackOff", message: "no such image" } } }] } },
		p4: { metadata: { deletionTimestamp: "2026-11-14T10:00:00Z" }, status: { phase: "Running" } },
		p5: { status: { phase: "Failed", reason: "DeadlineExceeded" } },
	};
	const api = fakeApi([{ method: "GET", path: /\/pods\/p\d$/, answer: (_init, n) => {
		const name = api.calls[n - 1].path.split("/").pop();
		return ok({ status: 200, body: { metadata: { name, ...(pods[name].metadata ?? {}) }, status: pods[name].status } });
	} }, { method: "GET", path: /\/pods\/gone$/, answer: () => ok({ status: 404, body: {} }) }]);
	const host = hostOf(api);
	const state = async (id) => (await host.get(id, ctx)).value;
	assert.equal((await state("p1")).state, "starting");
	assert.equal((await state("p2")).state, "running");
	assert.deepEqual([(await state("p3")).state, (await state("p3")).why], ["failed", "container computer is ImagePullBackOff: no such image"]);
	assert.equal((await state("p4")).state, "going");
	assert.match((await state("p5")).why, /DeadlineExceeded/);
	assert.equal(await state("gone"), undefined);
});

test("list selects by the computer label (and the name), reads every page, and filters by the annotation's labels", async () => {
	const item = (name, run) => ({ metadata: { name, annotations: { [LABELS_ANNOTATION]: JSON.stringify({ ...req.labels, "agentrun.run": run }) } }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } });
	const api = fakeApi([{ method: "GET", path: "/api/v1/namespaces/computers/pods", answer: (init) => ok({ status: 200, body: init.query.continue ? { items: [item("b", "r2")], metadata: {} } : { items: [item("a", "r1")], metadata: { continue: "tok" } } }) }]);
	const host = hostOf(api);
	const listed = await host.list({ "agentrun.computer": "1", "agentrun.run": "r2" }, ctx);
	assert.deepEqual(listed.value.map((one) => one.id), ["b"]);
	assert.equal(api.calls[0].init.query.labelSelector, "agentrun.computer=1");
	await host.list({ "agentrun.computer": "1", "agentrun.computer.name": "computer-x" }, ctx);
	assert.equal(api.calls[2].init.query.labelSelector, "agentrun.computer=1,agentrun.computer.name=computer-x");
});

test("delete takes a 404 as done; setLabels merges into the annotation under its resourceVersion and reads again on a 409", async () => {
	let patches = 0;
	const api = fakeApi([
		{ method: "DELETE", path: /pods\/x$/, answer: () => ok({ status: 404, body: {} }) },
		{ method: "GET", path: /pods\/x$/, answer: () => ok({ status: 200, body: { metadata: { name: "x", resourceVersion: String(patches), annotations: { [LABELS_ANNOTATION]: '{"a":"1","b":"2"}' } } } }) },
		{ method: "PATCH", path: /pods\/x$/, answer: () => (++patches === 1 ? { ok: false, error: answerError("PATCH /x", 409, "") } : ok({ status: 200, body: {} })) },
	]);
	const host = hostOf(api);
	assert.deepEqual(await host.delete("x", ctx), ok(undefined));
	assert.deepEqual(await host.setLabels("x", { b: "3" }, ctx), ok(undefined));
	const last = api.calls.filter((call) => call.method === "PATCH").at(-1);
	assert.equal(last.init.contentType, "application/merge-patch+json");
	assert.equal(last.init.json.metadata.resourceVersion, "1");
	assert.deepEqual(JSON.parse(last.init.json.metadata.annotations[LABELS_ANNOTATION]), { a: "1", b: "3" });
});

test("check: \"default\" with no image or warm pool set is refused in words; a claim's image is a warm pool's name", () => {
	assert.match(hostOf(fakeApi([]), { image: undefined }).check({ image: "default" })[0].message, /AGENTRUN_KUBERNETES_IMAGE/);
	const claims = new KubernetesHost({ api: fakeApi([]), namespace: "n", object: "claim", arch: "amd64", maxLifetimeMs: 60_000, requestMs: 1000 });
	assert.match(claims.check({ image: "Not A Pool" })[0].message, /SandboxWarmPool/);
	assert.deepEqual(claims.check({ image: "pool-b" }), []);
});

/** A fake KubeStream: the test pushes channel messages and reads what was sent. */
function fakeStream(protocol = EXEC_PROTOCOLS[0]) {
	const sent = [];
	let onMessage;
	let onEnd;
	return {
		sent,
		push: (channel, text) => onMessage(channel, new TextEncoder().encode(text)),
		end: (error) => onEnd(error),
		stream: { protocol, send: async (channel, bytes) => void sent.push([channel, Buffer.from(bytes)]), onMessage: (fn) => (onMessage = fn), onEnd: (fn) => (onEnd = fn), close() {} },
	};
}

test("an exec process: stdout and stderr apart, byte-exact; the exit status from channel 3; v5 ends stdin with its close; v4 says it cannot", async () => {
	const fake = fakeStream();
	const process = processOf(fake.stream);
	await process.write(new Uint8Array([0, 255, 10]));
	await process.end();
	assert.deepEqual(fake.sent, [[0, Buffer.from([0, 255, 10])], [255, Buffer.from([0])]]);
	fake.push(1, "out");
	fake.push(2, "err");
	fake.push(3, JSON.stringify({ status: "Failure", reason: "NonZeroExitCode", details: { causes: [{ reason: "ExitCode", message: "3" }] } }));
	assert.equal(await process.wait(), 3);
	const read = async (stream) => Buffer.concat(await Array.fromAsync(stream)).toString();
	assert.equal(await read(process.stdout), "out");
	assert.equal(await read(process.stderr), "err");
	const old = processOf(fakeStream("v4.channel.k8s.io").stream);
	await assert.rejects(old.end(), /older than 1.30/);
	assert.deepEqual(execStatus(new TextEncoder().encode('{"status":"Success"}')), { code: 0 });
	// A command that never ran: 127, its words on stderr.
	const missing = fakeStream();
	const ran = processOf(missing.stream);
	missing.push(3, JSON.stringify({ status: "Failure", message: 'exec: "nope": executable file not found' }));
	assert.equal(await ran.wait(), 127);
	assert.match(await read(ran.stderr), /executable file not found/);
	// A stream that ends with no status fails wait in words.
	const cut = fakeStream();
	const cutProcess = processOf(cut.stream);
	cut.end(new Error("reset"));
	await assert.rejects(cutProcess.wait(), /before the command's exit status came: reset/);
});

test("upload sends exactly the bytes to head -c in one exec, and fails in words on a nonzero exit", async () => {
	let fake;
	const api = fakeApi([{ method: "STREAM", answer: () => {
		fake = fakeStream();
		setTimeout(() => fake.push(3, '{"status":"Success"}'), 5);
		return ok(fake.stream);
	} }]);
	const host = hostOf(api);
	const bytes = new Uint8Array(150_000).fill(7);
	assert.deepEqual(await host.upload("p", "/tmp/computerd", bytes, ctx), ok(undefined));
	const stream = api.calls.find((call) => call.method === "STREAM");
	const argv = stream.query.filter(([key]) => key === "command").map(([, value]) => value);
	assert.deepEqual([argv[0], argv[1], argv.at(-2), argv.at(-1)], ["sh", "-c", "150000", "/tmp/computerd"]);
	assert.match(argv[2], /head -c "\$1"/);
	assert.equal(Buffer.concat(fake.sent.filter(([channel]) => channel === 0).map(([, chunk]) => chunk)).length, 150_000);
	const failing = hostOf(fakeApi([{ method: "STREAM", answer: () => {
		const one = fakeStream();
		setTimeout(() => {
			one.push(2, "the upload did not arrive whole");
			one.push(3, JSON.stringify({ status: "Failure", details: { causes: [{ reason: "ExitCode", message: "1" }] } }));
		}, 5);
		return ok(one.stream);
	} }]));
	const failed = await failing.upload("p", "/tmp/x", new Uint8Array(3), ctx);
	assert.match(failed.error.message, /exited 1: the upload did not arrive whole/);
});

/** A server-side WebSocket frame: unmasked, as a server sends one. */
const serverFrame = (opcode, payload, fin = true) => {
	const length = payload.length;
	const header = length < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, length]) : Buffer.from([(fin ? 0x80 : 0) | opcode, 126, length >> 8, length & 0xff]);
	return Buffer.concat([header, payload]);
};

/** The client frames a server reads: each one's opcode and unmasked payload. */
function readClientFrames(buffer) {
	const frames = [];
	let at = 0;
	while (at + 2 <= buffer.length) {
		const opcode = buffer[at] & 0x0f;
		let length = buffer[at + 1] & 0x7f;
		let offset = at + 2;
		if (length === 126) {
			length = buffer.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			length = Number(buffer.readBigUInt64BE(offset));
			offset += 8;
		}
		assert.equal(buffer[at + 1] & 0x80, 0x80, "a client frame is masked");
		const mask = buffer.subarray(offset, offset + 4);
		offset += 4;
		const payload = Buffer.from(buffer.subarray(offset, offset + length).map((byte, index) => byte ^ mask[index % 4]));
		frames.push({ opcode, payload });
		at = offset + length;
	}
	return frames;
}

test("the WebSocket client: masked binary frames out, fragments joined, a ping answered, a close answered, frames in the upgrade's head read", async () => {
	let serverSide;
	const received = [];
	const server = createServer((socket) => {
		serverSide = socket;
		socket.on("data", (chunk) => received.push(chunk));
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const { Socket } = await import("node:net");
	const client = new Socket();
	await new Promise((done) => client.connect(server.address().port, "127.0.0.1", done));
	while (!serverSide) await new Promise((done) => setTimeout(done, 5));
	const head = serverFrame(0x2, Buffer.from([1, 104, 105])); // stdout "hi", in the upgrade's head
	const ws = webSocket(client, head, "v5.channel.k8s.io");
	const messages = [];
	ws.onMessage((channel, bytes) => messages.push([channel, Buffer.from(bytes).toString()]));
	const ended = new Promise((done) => ws.onEnd(done));
	await ws.send(0, new Uint8Array(70_000).fill(65));
	serverSide.write(Buffer.concat([serverFrame(0x2, Buffer.from([2, 101]), false), serverFrame(0x0, Buffer.from([114]), true)])); // stderr "er", in two fragments
	serverSide.write(serverFrame(0x9, Buffer.from("p")));
	await new Promise((done) => setTimeout(done, 50));
	serverSide.write(serverFrame(0x8, Buffer.alloc(0)));
	await ended;
	assert.deepEqual(messages, [[1, "hi"], [2, "er"]]);
	await new Promise((done) => setTimeout(done, 20));
	client.destroy();
	serverSide.destroy();
	server.close();
	const frames = readClientFrames(Buffer.concat(received));
	assert.equal(frames[0].opcode, 0x2);
	assert.equal(frames[0].payload[0], 0);
	assert.equal(frames[0].payload.length, 70_001);
	assert.deepEqual(frames.slice(1).map((frame) => frame.opcode), [0xa, 0x8]);
	assert.equal(frames[1].payload.toString(), "p");
});

test("auth: a JSON kubeconfig's context (token, client certificate, namespace); YAML, an exec plugin and skipped TLS are refused in words", () => {
	const kubeconfig = (user, cluster = {}) => JSON.stringify({ "current-context": "c", contexts: [{ name: "c", context: { cluster: "k", user: "u", namespace: "ns1" } }], clusters: [{ name: "k", cluster: { server: "https://127.0.0.1:6443", "certificate-authority-data": Buffer.from("-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----").toString("base64"), ...cluster } }], users: [{ name: "u", user }] });
	const viaCert = resolveEndpoint({ kubeconfig: kubeconfig({ "client-certificate-data": pem("CERTIFICATE", "C"), "client-key-data": pem(["PRIVATE", "KEY"].join(" "), "K") }) });
	assert.equal(viaCert.namespace, "ns1");
	assert.equal(viaCert.endpoint.server, "https://127.0.0.1:6443");
	assert.match(viaCert.endpoint.tls.ca, /BEGIN CERTIFICATE/);
	assert.match(viaCert.endpoint.tls.key, /PRIVATE KEY/);
	assert.equal(viaCert.endpoint.token, undefined);
	const viaToken = resolveEndpoint({ kubeconfig: kubeconfig({ token: "t0k" }) });
	assert.equal(typeof viaToken.endpoint.token, "function");
	assert.throws(() => resolveEndpoint({ kubeconfig: "apiVersion: v1\nkind: Config" }), /not JSON: a YAML kubeconfig is not read here; kubectl config view --raw --minify --flatten -o json/);
	assert.throws(() => resolveEndpoint({ kubeconfig: kubeconfig({ exec: { command: "gke-gcloud-auth-plugin" } }) }), /exec plugin .* for GKE use auth gke-adc/);
	assert.throws(() => resolveEndpoint({ kubeconfig: kubeconfig({ token: "t" }, { "insecure-skip-tls-verify": true }) }), /never does/);
	assert.throws(() => resolveEndpoint({ auth: "token", apiUrl: "https://k" }), /options.token, a bearer token, or options.tokenFile/);
	assert.throws(() => resolveEndpoint({ auth: "gke-adc" }), /needs options.apiUrl/);
	assert.throws(() => resolveEndpoint({ auth: "gke-adc", apiUrl: "https://k", env: {} }), /needs a Google credentials file: set GOOGLE_APPLICATION_CREDENTIALS/);
	assert.throws(() => resolveEndpoint({ auth: "in-cluster", env: {} }), /KUBERNETES_SERVICE_HOST is unset/);
	const inCluster = resolveEndpoint({ auth: "in-cluster", env: { KUBERNETES_SERVICE_HOST: "10.0.0.1", KUBERNETES_SERVICE_PORT: "443" }, readFile: (path) => (path.endsWith("namespace") ? "agents\n" : "-----BEGIN CERTIFICATE-----\nSA\n-----END CERTIFICATE-----") });
	assert.equal(inCluster.endpoint.server, "https://10.0.0.1:443");
	assert.equal(inCluster.namespace, "agents");
	assert.throws(() => create({ auth: "token", apiUrl: "http://k", token: "t" }), /must be https/);
});

test("Google ADC: an external account's file subject token, Google's STS, then impersonation, asked for userinfo.email; kept until near its end", async () => {
	const calls = [];
	let now = 1_000_000;
	const fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		if (String(url).startsWith("https://sts.googleapis.com/")) return Response.json({ access_token: FAKE.federated, expires_in: 3600 });
		return Response.json({ accessToken: FAKE.impersonated, expireTime: new Date(now + 3_600_000).toISOString() });
	};
	const files = {
		"/creds.json": JSON.stringify({ type: "external_account", audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q", subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token", service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@example.iam.gserviceaccount.com:generateAccessToken", credential_source: { file: "/oidc/token" } }),
		"/oidc/token": "subject-jwt\n",
	};
	const source = googleAdc({ credentialsFile: "/creds.json", fetch, readFile: async (path) => files[path], now: () => now });
	assert.deepEqual(await source(false), ok({ token: FAKE.impersonated, expiresAt: now + 3_600_000 }));
	const sts = new URLSearchParams(calls[0].init.body);
	assert.equal(sts.get("subject_token"), "subject-jwt");
	assert.equal(sts.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
	assert.equal(sts.get("scope"), GKE_SCOPES[0]);
	assert.deepEqual(JSON.parse(calls[1].init.body).scope, [...GKE_SCOPES]);
	assert.ok(GKE_SCOPES.includes("https://www.googleapis.com/auth/userinfo.email"));
	assert.equal(calls[1].init.headers.Authorization, `Bearer ${FAKE.federated}`);
	await source(false);
	assert.equal(calls.length, 2, "kept");
	now += 3_600_000 - 30_000;
	await source(false);
	assert.equal(calls.length, 4, "minted again within a minute of its end");
	await source(true);
	assert.equal(calls.length, 6, "minted again when asked fresh");
});

test("Google ADC: a service account signs an RS256 JWT with both scopes; an executable source is refused; a 503 is transient", async () => {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	let assertion;
	const fetch = async (_url, init) => {
		assertion = new URLSearchParams(init.body).get("assertion");
		return Response.json({ access_token: FAKE.serviceAccount, expires_in: 3600 });
	};
	const files = { "/sa.json": JSON.stringify({ type: "service_account", client_email: "sa@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.example.test/token" }) };
	const got = await googleAdc({ credentialsFile: "/sa.json", fetch, readFile: async (path) => files[path] })(false);
	assert.equal(got.value.token, FAKE.serviceAccount);
	const [header, claims, signature] = assertion.split(".");
	assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url"));
	const body = JSON.parse(Buffer.from(claims, "base64url").toString());
	assert.equal(body.scope, GKE_SCOPES.join(" "));
	assert.equal(body.aud, "https://oauth2.example.test/token");
	const exec = { "/x.json": JSON.stringify({ type: "external_account", audience: "a", subject_token_type: "t", token_url: "https://sts.googleapis.com/v1/token", credential_source: { executable: { command: "x" } } }) };
	assert.match((await googleAdc({ credentialsFile: "/x.json", fetch, readFile: async (path) => exec[path] })(false)).error.message, /executable is not read here/);
	const down = await googleAdc({ credentialsFile: "/sa.json", fetch: async () => new Response("down", { status: 503 }), readFile: async (path) => files[path] })(false);
	assert.equal(down.error.transient, true);
});
