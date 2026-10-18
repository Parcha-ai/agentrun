// providers/assigned.ts: a BrowserProvider over the one session a host assigned to the run (a site child's managed session).
// It never creates or ends a browser: create hands out that session to one custody at a time, attach asks the host's
// session for a fresh target every time (a relay's capability rotates), and release lets go of that custody's hold without
// asking the host. The host takes the session back itself, once; a second create while it is held is a typed refusal.
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserFailureError } from "../dist/core/custody.js";
import { assignedSessionProvider } from "../dist/providers/assigned.js";

const spec = (tag) => ({ tag, maxLifetimeS: 600, idleTimeoutS: 60, proxies: false, verified: false, captcha: false, viewport: { width: 1000, height: 700 }, metadata: {} });
const signal = () => new AbortController().signal;

function hostSession(over = {}) {
  const calls = [];
  let n = 0;
  const session = {
    id: "assigned-session-1",
    attach: async () => { calls.push("attach"); n += 1; return { sdkCdpUrl: `ws://127.0.0.1:1/assigned/${n}`, dial: { url: "wss://broker.example/cdp", headers: { Authorization: `Bearer bcap.cap-${n}` } } }; },
    status: async () => { calls.push("status"); return "running"; },
    release: async () => { calls.push("release"); },
    ...over,
  };
  return { calls, provider: assignedSessionProvider({ name: "parcha-site", session }) };
}

const refusal = (error) => {
  assert.ok(error instanceof BrowserFailureError, String(error));
  assert.equal(error.failure.code, "refused");
  assert.equal(error.failure.retryable, false);
  return true;
};

test("create hands out the assigned session without asking anything of the host, and it survives a dropped socket", async () => {
  const { calls, provider } = hostSession();
  assert.deepEqual(await provider.create(spec("ar-1"), signal()), { id: "assigned-session-1", tag: "ar-1" });
  assert.deepEqual(calls, []);
  assert.equal(provider.name, "parcha-site");
  assert.equal(provider.caps.survivesDisconnect, true);
  assert.equal(provider.caps.releaseIsAsync, false);
});

test("every attach asks the host's session for a fresh target; another session's id is refused without asking", async () => {
  const { calls, provider } = hostSession();
  const ref = await provider.create(spec("ar-1"), signal());
  const first = await provider.attach(ref);
  const second = await provider.attach(ref);
  assert.equal(first.dial.headers.Authorization, "Bearer bcap.cap-1");
  assert.equal(second.dial.headers.Authorization, "Bearer bcap.cap-2");
  await assert.rejects(provider.attach({ id: "someone-else", tag: "ar-1" }));
  assert.deepEqual(calls, ["attach", "attach"]);
});

test("the run has one browser: a second create while it is held is refused, and only its own tag finds it", async () => {
  const { provider } = hostSession();
  await provider.create(spec("ar-1"), signal());
  await assert.rejects(provider.create(spec("ar-2"), signal()), (error) => refusal(error) && /one browser/.test(error.failure.message));
  assert.deepEqual(await provider.findByTag("ar-1"), [{ id: "assigned-session-1", tag: "ar-1" }]);
  assert.deepEqual(await provider.findByTag("ar-2"), []);
});

test("release lets go of the custody's hold without asking the host: the released hold reads stopped, and the next create is served the same session", async () => {
  const { calls, provider } = hostSession();
  const ref = await provider.create(spec("ar-1"), signal());
  await provider.release(ref);
  await provider.release(ref);
  assert.equal(await provider.status(ref), "stopped", "the released hold is over for the custody that held it");
  assert.deepEqual(await provider.findByTag("ar-1"), []);
  assert.deepEqual(await provider.create(spec("ar-2"), signal()), { id: "assigned-session-1", tag: "ar-2" }, "the next custody holds the same session");
  assert.equal(await provider.status({ id: "assigned-session-1", tag: "ar-2" }), "running");
  assert.deepEqual(calls, ["status"], "the host was never asked to take the session back");
});

test("a hold created again under a tag its custody let go of is live again", async () => {
  const { provider } = hostSession();
  const ref = await provider.create(spec("ar-1"), signal());
  await provider.release(ref);
  assert.deepEqual(await provider.create(spec("ar-1"), signal()), ref);
  assert.equal(await provider.status(ref), "running");
  assert.deepEqual(await provider.findByTag("ar-1"), [ref]);
});

test("status asks the host only for its own session; any other id is gone", async () => {
  const { calls, provider } = hostSession();
  const ref = await provider.create(spec("ar-1"), signal());
  assert.equal(await provider.status(ref), "running");
  assert.equal(await provider.status({ id: "someone-else", tag: "ar-1" }), "gone");
  assert.deepEqual(calls, ["status"]);
});

test("a host failure the session types reaches the tool loop as a BrowserFailureError with that failure; any other error is passed as is", async () => {
  const failure = { ok: false, code: "auth", retryable: false, effect: "none", message: "The website needs a person to sign in again." };
  const typed = hostSession({ attach: async () => { throw Object.assign(new Error("typed"), { failure }); } }).provider;
  const ref = await typed.create(spec("ar-1"), signal());
  await assert.rejects(typed.attach(ref), (error) => error instanceof BrowserFailureError && assert.deepEqual(error.failure, failure) === undefined);
  const plain = hostSession({ attach: async () => { throw new TypeError("fetch failed"); } }).provider;
  await assert.rejects(plain.attach(await plain.create(spec("ar-1"), signal())), (error) => error instanceof TypeError);
});

test("the assigned provider declares one fixed session, so custody never relaunches onto another", () => {
  assert.equal(hostSession().provider.caps.fixedSession, true);
});

test("an assigned session applies none of the run's session settings: its host made it, so a session row never claims them", () => {
  assert.deepEqual(hostSession().provider.caps.settings, { proxies: false, verified: false, geolocation: false, region: false, context: false });
  assert.equal(hostSession().provider.caps.profiles, false, "a saved profile cannot be loaded into a session the host made");
});

test("a session the host has fenced answers its failure to the next create, never an 'already open' refusal", async () => {
  let fenced = null;
  const { provider } = hostSession({ failure: () => fenced, status: async () => (fenced ? "stopped" : "running") });
  await provider.create(spec("ar-1"), signal());
  fenced = { ok: false, code: "auth", retryable: false, effect: "none", message: "The website needs a person to sign in again." };
  for (const tag of ["ar-2", "ar-1"]) {
    await assert.rejects(provider.create(spec(tag), signal()), (error) => error instanceof BrowserFailureError && assert.deepEqual(error.failure, fenced) === undefined, tag);
  }
});
