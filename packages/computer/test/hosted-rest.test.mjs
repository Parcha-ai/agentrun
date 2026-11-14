// The shared REST client (src/hosted/rest.ts): status table, retry rules, accept, redirect refusal, cursor pages. No vendor, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { allPages, httpCode, rest } from "../dist/hosted/rest.js";

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

test("httpCode maps a status to one code", () => {
	const table = { 401: "denied", 403: "denied", 404: "not_found", 410: "not_found", 408: "timeout", 402: "limit", 429: "limit", 507: "limit", 400: "invalid", 409: "invalid", 422: "invalid", 500: "vendor", 502: "vendor" };
	for (const [status, code] of Object.entries(table)) assert.equal(httpCode(Number(status)), code, status);
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
