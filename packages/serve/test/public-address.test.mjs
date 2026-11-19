// A server whose public address (AGENTRUN_PUBLIC_URL) changed between two starts on one data folder: the start says so
// in its log, a browser that opens the console at the earlier address is sent on to the new one, and a script that sends
// a request there is refused in words that name the new one. Any other name is refused as before, never repeated.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { call, serve } from "./support.mjs";

const A = "https://a.example.com";
const B = "https://b.example.com";
const HTML = "text/html,application/xhtml+xml";

/** A start on `data` (a new folder when none) with the log lines it writes kept in `lines`. */
async function start(t, options) {
  const lines = [];
  const server = await serve(t, { ...options, log: (line) => lines.push(line) });
  return { server, lines, changes: () => lines.filter((line) => line.includes("event=public_url_changed")) };
}

/** Started at `from`, stopped, then started at `to` on the same data folder: the second start. */
async function moved(t, from, to) {
  const first = await start(t, from === undefined ? {} : { publicUrl: from });
  assert.deepEqual(first.changes(), [], "a data folder's first start has no earlier address to compare with");
  await first.server.stop();
  return start(t, { data: first.server.data, ...(to === undefined ? {} : { publicUrl: to }) });
}

test("a start whose public address changed says so in one line: the old and the new address, signing in again, and old webhook links", async (t) => {
  const { changes } = await moved(t, A, B);
  const [line, ...more] = changes();
  assert.deepEqual(more, [], "one line");
  assert.match(line, new RegExp(`from=${A}\\b`));
  assert.match(line, new RegExp(`to=${B}\\b`));
  assert.match(line, /signs in again/);
  assert.match(line, /webhook/);
});

test("a public address set where there was none, and none where there was one, are changes too; the same address again is none", async (t) => {
  const set = await moved(t, undefined, B);
  assert.match(set.changes()[0] ?? "", new RegExp(`from=none to=${B}\\b`));
  await set.server.stop();
  const again = await start(t, { data: set.server.data, publicUrl: `${B}/` });
  assert.deepEqual(again.changes(), [], "the same address, a trailing slash aside, is no change");
  await again.server.stop();
  const unset = await start(t, { data: set.server.data });
  assert.match(unset.changes()[0] ?? "", new RegExp(`from=${B} to=none\\b`));
});

test("a browser that opens the console at the earlier address is redirected to the new one, unpinned; a later start at the new address still does", async (t) => {
  const { server } = await moved(t, A, B);
  for (const path of ["/", "/sign-in"]) {
    const page = await call(server.port, { path, headers: { host: "a.example.com", accept: HTML } });
    assert.equal(page.status, 308, path);
    assert.equal(page.headers.location, `${B}/`, `${path}: the new address's console, which keeps the link's #fragment`);
    assert.equal(page.headers["cache-control"], "no-store", "a browser keeps no permanent redirect: the address may change back");
  }
  await server.stop();
  const later = await start(t, { data: server.data, publicUrl: B });
  assert.deepEqual(later.changes(), []);
  const page = await call(later.server.port, { path: "/", headers: { host: "a.example.com:443", accept: HTML } });
  assert.equal(page.status, 308);
  assert.equal(page.headers.location, `${B}/`);
});

test("at the earlier address, the API and the hooks are refused, never redirected, in words that name the new address; another page gets a page that names it", async (t) => {
  const { server } = await moved(t, A, B);
  const api = await call(server.port, { path: "/v2/capabilities", headers: { host: "a.example.com", accept: "application/json", authorization: `Bearer ${server.token}` } });
  assert.equal(api.status, 403);
  assert.equal(api.json.error.code, "forbidden");
  assert.match(api.json.error.message, /^unexpected Host header/);
  assert.ok(api.json.error.message.includes(B), api.json.error.message);
  const hook = await call(server.port, { method: "POST", path: "/v2/hooks/anything", headers: { host: "a.example.com", "content-type": "application/json" }, body: "{}" });
  assert.equal(hook.status, 403, "a webhook sent to the earlier address is refused, not sent on");
  assert.equal(hook.headers.location, undefined);
  const page = await call(server.port, { path: "/v2/capabilities", headers: { host: "a.example.com", accept: HTML } });
  assert.equal(page.status, 403);
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.match(page.headers["content-security-policy"], /default-src 'self'/);
  assert.ok(page.text.includes(`href="${B}/"`), "the page links to the new address");
  assert.match(page.text, /[Ss]ign in again/);
  assert.equal(page.headers.location, undefined);
});

test("after a move, any other name is refused as before, and neither it nor the new address is repeated", async (t) => {
  const { server } = await moved(t, A, B);
  const page = await call(server.port, { path: "/", headers: { host: "evil.example", accept: HTML } });
  assert.equal(page.status, 403);
  assert.match(page.text, /Open AgentRun at localhost/);
  assert.doesNotMatch(page.text, /evil\.example|b\.example\.com/);
  const api = await call(server.port, { path: "/v2/capabilities", headers: { host: "evil.example", accept: "application/json" } });
  assert.equal(api.status, 403);
  assert.doesNotMatch(api.json.error.message, /evil\.example|b\.example\.com/);
  assert.equal((await call(server.port, { path: "/", headers: { host: "b.example.com", accept: HTML } })).status, 200, "the new address serves the console");
});

test("an earlier address with no public address now is refused as any other name: there is nowhere to send it", async (t) => {
  const { server } = await moved(t, A, undefined);
  const page = await call(server.port, { path: "/", headers: { host: "a.example.com", accept: HTML } });
  assert.equal(page.status, 403);
  assert.match(page.text, /Open AgentRun at localhost/);
});

test("a public address in another script is sent on to as a Location header carries it, and the server keeps answering", async (t) => {
  const { server } = await moved(t, A, "https://例え.example");
  const page = await call(server.port, { path: "/", headers: { host: "a.example.com", accept: HTML } });
  assert.equal(page.status, 308);
  assert.equal(page.headers.location, "https://xn--r8jz45g.example/");
  assert.equal((await call(server.port, { path: "/", headers: { host: "a.example.com", accept: HTML } })).status, 308, "the server still answers");
});

test("a start that fails remembers nothing: the address before it is still the earlier one, and its change is said once a start serves", async (t) => {
  const first = await start(t, { publicUrl: A });
  await first.server.stop();
  const taken = createServer().listen(0, "127.0.0.1");
  await once(taken, "listening");
  t.after(() => taken.close());
  const lines = [];
  await assert.rejects(serve(t, { data: first.server.data, publicUrl: B, port: taken.address().port, log: (line) => lines.push(line) }), "the port is taken");
  assert.deepEqual(lines.filter((line) => line.includes("event=public_url_changed")), [], "a start that fails says no change");
  const C = "https://c.example.com";
  const later = await start(t, { data: first.server.data, publicUrl: C });
  const [line, ...more] = later.changes();
  assert.deepEqual(more, []);
  assert.match(line ?? "", new RegExp(`from=${A} to=${C}\\b`), "the change is from the address that served");
  const page = await call(later.server.port, { path: "/", headers: { host: "a.example.com", accept: HTML } });
  assert.equal(page.status, 308, "the address that served before is still sent on");
  assert.equal(page.headers.location, `${C}/`);
});
