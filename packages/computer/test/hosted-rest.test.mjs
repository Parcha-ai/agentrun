// The shared REST client (src/hosted/rest.ts): status table, retry rules, accept, redirect refusal, cursor pages. No
// vendor; the network is two loopback servers, for a redirect real fetch refuses.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { allPages, httpCode, httpsBase, rest } from "../dist/hosted/rest.js";

const answers = (...replies) => {
	const calls = [];
	const fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		const next = replies[Math.min(calls.length - 1, replies.length - 1)];
		if (next instanceof Error) throw next;
		return new Response(next.body ?? "", { status: next.status });
	};
	return { fetch, calls };
};
const client = (fetch, extra = {}) => {
	const pauses = [];
	return { pauses, api: rest({ base: "https://api.example.test//", headers: () => ({ Authorization: "Bearer k" }), vendor: "acme", fetch, timeoutMs: 1000, retry: { attempts: 3, baseMs: 2, pause: async (ms) => void pauses.push(ms) }, ...extra }) };
};

test("httpsBase takes an https URL with its trailing slashes stripped, and refuses every other scheme, loopback http included, and a bad URL", () => {
	for (const [url, base] of [
		["https://api.example.test", "https://api.example.test"],
		["https://api.example.test/v1/", "https://api.example.test/v1"],
		["https://api.example.test/v1///", "https://api.example.test/v1"],
	]) assert.equal(httpsBase(url, "the API URL"), base, url);
	for (const url of ["http://api.example.test", "http://127.0.0.1:8080", "http://[::1]:8080", "http://localhost:8080", "ws://api.example.test", "wss://api.example.test"]) {
		assert.throws(() => httpsBase(url, "the API URL"), /^Error: the API URL must be https/, url);
	}
	// A bad URL is refused in words that echo nothing of it: it may carry a key in its query.
	assert.throws(() => httpsBase("not a url?key=fake-test-key", "the API URL"), (error) => error.message === "the API URL is not a URL");
	// An http URL's words give its scheme, not the rest of it.
	assert.throws(() => httpsBase("http://api.example.test/?key=fake-test-key", "the API URL"), (error) => !error.message.includes("fake-test-key"));
});

test("httpsBase refuses a user or password, a query and a fragment, for every provider, in words that give the origin alone", () => {
	for (const [url, words] of [
		["https://agentrun@orgo.example/api", "the API URL takes no user or password, since the key goes to it: https://orgo.example"],
		["https://api.agent37.com/v1?x=1", "the API URL takes no query or fragment: https://api.agent37.com"],
		["https://cloud.morph.so/api?key=fake-test-key", "the API URL takes no query or fragment: https://cloud.morph.so"],
		["https://cloud.morph.so/api#fake-test-key", "the API URL takes no query or fragment: https://cloud.morph.so"],
	]) assert.throws(() => httpsBase(url, "the API URL"), (error) => error.message === words, url);
	// An empty query or fragment is none: the base is the origin and path.
	assert.equal(httpsBase("https://api.example.test/v1/?#", "the API URL"), "https://api.example.test/v1");
});

test("httpsBase returns the normalized URL: a lower-case scheme and host, a default port dropped, so a case-sensitive reader of the scheme sees https; the path keeps its case", () => {
	assert.equal(httpsBase("HTTPS://API.EXAMPLE.TEST:443/", "the API URL"), "https://api.example.test");
	assert.equal(httpsBase("HTTPS://Api.Example.test:8443/v1/", "the API URL"), "https://api.example.test:8443/v1");
	// Only the scheme and host are case-blind: a path is the server's to read, so its case stays.
	assert.equal(httpsBase("HTTPS://Api.Example.test/V1/Tenant/", "the API URL"), "https://api.example.test/V1/Tenant");
});

test("httpCode maps a status to one code", () => {
	const table = { 401: "denied", 403: "denied", 404: "not_found", 410: "not_found", 408: "timeout", 402: "limit", 429: "limit", 507: "limit", 400: "invalid", 409: "invalid", 422: "invalid", 500: "vendor", 502: "vendor" };
	for (const [status, code] of Object.entries(table)) assert.equal(httpCode(Number(status)), code, status);
	assert.equal(httpCode(409, true), "exists", "a 409 on a call that carries the machine's name");
});

test("a 409 on a named call (a create by the machine's name) is exists; on any other call it stays invalid", async () => {
	const conflict = () => answers({ status: 409, body: '{"error":"name taken"}' }).fetch;
	const named = await client(conflict()).api.call("POST", "https://api.example.test/machines", { json: { name: "computer-0123456789ab" }, named: true });
	assert.deepEqual(named, { ok: false, error: { code: "exists", message: 'POST /machines: 409 {"error":"name taken"}' } });
	const unnamed = await client(conflict()).api.call("PATCH", "https://api.example.test/machines/m1", { json: { ttl: 60 } });
	assert.equal(unnamed.error.code, "invalid");
});

test("a call carries the header, a JSON Content-Type, and never follows a redirect; a failure names method, path and status, not the key", async () => {
	const { fetch, calls } = answers({ status: 200, body: '{"a":1}' });
	const { api } = client(fetch);
	const got = await api.json("POST", api.url("/x"), { json: { b: 2 } });
	assert.deepEqual(got, { ok: true, value: { a: 1 } });
	assert.equal(calls[0].url, "https://api.example.test/x");
	assert.equal(calls[0].init.redirect, "error");
	assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer k", "Content-Type": "application/json" });
	const bad = answers({ status: 404, body: "no   such\nthing" });
	const failed = await client(bad.fetch).api.call("GET", "https://api.example.test/y?secret=1");
	assert.deepEqual(failed, { ok: false, error: { code: "not_found", message: "GET /y: 404 no such thing" } });
	const redirect = await client(answers(new TypeError("fetch failed", { cause: new Error("unexpected redirect") })).fetch).api.call("GET", "https://api.example.test/z");
	assert.equal(redirect.error.code, "vendor");
	assert.match(redirect.error.message, /redirect, which is never followed/);
	// A refused redirect is marked on the error, by the client, not by its words; no answer at all is not one.
	assert.equal(redirect.error.redirect, true);
	const lost = await client(answers(new TypeError("fetch failed", { cause: new Error("connection reset") })).fetch).api.call("GET", "https://api.example.test/z");
	assert.equal(lost.error.code, "vendor");
	assert.equal(lost.error.redirect, undefined);
});

test("a real fetch answered 303 is refused unfollowed and marked: the key never reaches the Location", async (t) => {
	const reached = [];
	const elsewhere = createServer((request, response) => {
		// Another process may probe a new loopback port: only the Location's path, or a call with a key, counts.
		if (request.url === "/sessions/sess_x" || request.headers.authorization !== undefined) reached.push(`${request.method} ${request.url}`);
		response.end("{}");
	});
	const api = createServer((request, response) => {
		response.writeHead(303, { location: `http://127.0.0.1:${elsewhere.address().port}/sessions/sess_x` });
		response.end();
	});
	for (const server of [elsewhere, api]) {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		t.after(() => (server.closeAllConnections(), server.close()));
	}
	const real = rest({ base: `http://127.0.0.1:${api.address().port}`, headers: () => ({ Authorization: "Bearer k" }), vendor: "acme", timeoutMs: 5000 });
	const got = await real.call("POST", real.url("/sessions"), { json: { a: 1 }, accept: () => true });
	assert.deepEqual(got, { ok: false, error: { code: "vendor", vendor: "acme", message: "POST /sessions: the API answered with a redirect, which is never followed: it would carry the key", redirect: true } });
	assert.deepEqual(reached, [], "nothing reached the Location, so neither did the key");
});

test("an answer that is not a 2xx keeps its status when its words break off; a 2xx whose body breaks is no answer", async () => {
	const broken = (status) => async () => new Response(new ReadableStream({ start: (controller) => controller.error(new Error("socket hang up")) }), { status });
	assert.deepEqual(await client(broken(401)).api.call("GET", "https://api.example.test/a"), { ok: false, error: { code: "denied", message: "GET /a: 401 " } });
	assert.deepEqual(await client(broken(404)).api.call("GET", "https://api.example.test/a", { accept: () => true }), { ok: true, value: { status: 404, bytes: new Uint8Array() } });
	assert.deepEqual(await client(broken(200)).api.call("GET", "https://api.example.test/a"), { ok: false, error: { code: "vendor", vendor: "acme", message: "GET /a: socket hang up" } });
});

test("retry: true sends again on 429, 5xx and no answer with doubling pauses, up to the attempts; no retry flag sends once", async () => {
	const { fetch, calls } = answers({ status: 503 }, new Error("reset"), { status: 200, body: "{}" });
	const { api, pauses } = client(fetch);
	assert.equal((await api.call("GET", api.url("/r"), { retry: true })).ok, true);
	assert.equal(calls.length, 3);
	assert.deepEqual(pauses, [2, 4]);
	const once = answers({ status: 503 }, { status: 200 });
	assert.equal((await client(once.fetch).api.call("GET", "https://api.example.test/r")).ok, false);
	assert.equal(once.calls.length, 1);
	const four = answers({ status: 500 });
	assert.equal((await client(four.fetch).api.call("GET", "https://api.example.test/r", { retry: true })).ok, false);
	assert.equal(four.calls.length, 3);
});

test("retry as a function resends only the answers it names, never no answer", async () => {
	const own = (status) => status === 500;
	const first = answers({ status: 500 }, { status: 200 });
	assert.equal((await client(first.fetch).api.call("POST", "https://api.example.test/w", { retry: own })).ok, true);
	assert.equal(first.calls.length, 2);
	const silent = answers(new Error("reset"), { status: 200 });
	assert.equal((await client(silent.fetch).api.call("POST", "https://api.example.test/w", { retry: own })).ok, false);
	assert.equal(silent.calls.length, 1);
	const refused = answers({ status: 502 }, { status: 200 });
	assert.equal((await client(refused.fetch).api.call("POST", "https://api.example.test/w", { retry: own })).ok, false);
	assert.equal(refused.calls.length, 1);
});

test("accept makes a status a value, and explain gives the vendor's code and words", async () => {
	const { fetch } = answers({ status: 404, body: "x" });
	const { api } = client(fetch);
	assert.deepEqual(await api.call("GET", "https://api.example.test/a", { accept: (s) => s === 404 }), { ok: true, value: { status: 404, bytes: new TextEncoder().encode("x") } });
	const own = client(answers({ status: 400, body: "quota hit" }).fetch, { explain: ({ text, what }) => (/quota/.test(text) ? { code: "limit", message: `${what} over quota` } : {}) });
	assert.deepEqual((await own.api.call("GET", "https://api.example.test/a")).error, { code: "limit", message: "GET /a over quota" });
});

test("an aborted signal and a timeout are told apart", async () => {
	const aborted = new AbortController();
	aborted.abort();
	assert.equal((await client(answers({ status: 200 }).fetch).api.call("GET", "https://api.example.test/a", {}, aborted.signal)).error.code, "aborted");
	const slow = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
	const timed = await client(slow).api.call("GET", "https://api.example.test/a", { timeoutMs: 5 });
	assert.equal(timed.error.code, "timeout");
});

test("the timeout option is the bound: a signal the caller fires, asked for each call with its ms", async () => {
	const made = [];
	const timeout = (ms) => {
		const controller = new AbortController();
		made.push({ ms, fire: () => controller.abort() });
		return controller.signal;
	};
	let started;
	const asked = new Promise((resolve) => (started = resolve));
	const slow = (url, init) => new Promise((_, reject) => (started(), init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
	const { api } = client(slow, { timeout });
	const pending = api.call("GET", "https://api.example.test/a", { timeoutMs: 7000 });
	await asked;
	assert.deepEqual(made.map((one) => one.ms), [7000]);
	made[0].fire();
	assert.deepEqual((await pending).error, { code: "timeout", message: "GET /a did not answer within 7 s" });
	const quick = client(answers({ status: 200, body: "{}" }).fetch, { timeout });
	assert.deepEqual(await quick.api.json("GET", "https://api.example.test/b"), { ok: true, value: {} });
	assert.equal(made[1].ms, 1000, "the client's own timeoutMs when the call gives none");
	// The words round to a tenth of a second: a readiness read is bounded by what its wait has left, in odd ms.
	const cut = client(async () => assert.fail("no answer"), { timeout: () => AbortSignal.abort() });
	assert.deepEqual((await cut.api.call("GET", "https://api.example.test/c", { timeoutMs: 5437 })).error, { code: "timeout", message: "GET /c did not answer within 5.4 s" });
});

test("allPages reads every page, refuses a repeated cursor, and refuses a listing past max", async () => {
	const pages = { undefined: { items: [1], next: "b" }, b: { items: [2], next: "c" }, c: { items: [3] } };
	const all = await allPages(async (cursor) => ({ ok: true, value: pages[cursor] }), 5, { vendor: "acme", what: "GET /things" });
	assert.deepEqual(all, { ok: true, value: [1, 2, 3] });
	const loop = await allPages(async () => ({ ok: true, value: { items: [1], next: "same" } }), 5, { vendor: "acme", what: "GET /things" });
	assert.deepEqual(loop.error, { code: "vendor", vendor: "acme", message: "GET /things's cursor same came back twice" });
	let n = 0;
	const long = await allPages(async (cursor) => ({ ok: true, value: { items: [1], next: `${cursor ?? ""}x` } }), 3, { vendor: "acme", what: "list" });
	assert.equal(long.error.message, "list ran past 3 pages");
	const cut = await allPages(async () => (n++ === 0 ? { ok: true, value: { items: [1], next: "x" } } : { ok: false, error: { code: "timeout", message: "slow" } }), 5, { vendor: "acme", what: "list" });
	assert.equal(cut.error.message, "slow");
});
