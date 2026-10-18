// What the observer and the CDP clients do when the wire misbehaves: a frame that is not JSON (or is JSON of a shape no handler
// expects) never ends the process, a setup that fails after the socket opened leaves no socket open, a request whose URL cannot be
// parsed is refused and never left paused, and a dial's headers reach the browser's upgrade request.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EffectObserver, effectDecider } from "@parcha/pi-browser";
import { startFakeCdp } from "./fixtures/fake-cdp-wire.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "observer_robustness_child.mjs");
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** A child process runs `mode` against `url`; it prints ALIVE after the wire misbehaved, and exits 0. */
function child(mode, url) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CHILD, mode, url], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (c) => { out += c; });
    proc.stderr.on("data", (c) => { out += c; });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
    proc.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out }); });
  });
}

test("a frame that is not JSON, or has a shape no handler expects, never ends the process: the observer, cdpCall, and the Stagehand extension probe", async (t) => {
  for (const mode of ["observer", "cdpcall", "stagehand"]) {
    const fake = await startFakeCdp({
      answer: (m, { send, sendRaw }) => {
        // Before the real answer: a frame that is not JSON, one with no params where handlers read them, and a JSON scalar.
        sendRaw("this is not json{");
        send({ method: "Target.detachedFromTarget" });
        send({ method: "Fetch.requestPaused", sessionId: "S1" });
        // An attachment with no params, and one whose targetInfo is missing: setup is async, so its rejection is not caught by the listener's try.
        send({ method: "Target.attachedToTarget" });
        send({ method: "Target.attachedToTarget", params: { sessionId: "S9", waitingForDebugger: false } });
        sendRaw("42");
        return false;
      },
    });
    t.after(() => fake.close());
    const ended = await child(mode, fake.url);
    assert.equal(ended.code, 0, `${mode}: the process ended (${ended.signal ?? ended.code}): ${ended.out.slice(-400)}`);
    assert.match(ended.out, /ALIVE/, `${mode}: ${ended.out.slice(-300)}`);
  }
});

test("a setup that fails after the socket opened closes the socket", async (t) => {
  const fake = await startFakeCdp({ answer: (m, { send }) => (m.method === "Target.setAutoAttach" ? (send({ id: m.id, error: { message: "refused by the browser" } }), true) : false) });
  t.after(() => fake.close());
  await assert.rejects(EffectObserver.open({ sdkCdpUrl: fake.url }, null), /./, "open fails with the browser's refusal");
  const closed = await Promise.race([fake.closed.then(() => true), settle(3_000).then(() => false)]);
  assert.equal(closed, true, "the observer's socket is closed after its setup failed");
});

test("a request whose URL cannot be parsed is refused, not left paused; a journaling observer lets it go", async (t) => {
  const bad = "http://[not-a-host/x";
  const holding = await startFakeCdp();
  t.after(() => holding.close());
  const observer = await EffectObserver.open({ sdkCdpUrl: holding.url }, effectDecider("deny"));
  t.after(() => observer.close());
  holding.send({ sessionId: "S1", method: "Fetch.requestPaused", params: { requestId: "P1", networkId: "N1", resourceType: "Fetch", request: { method: "POST", url: bad, headers: {} } } });
  holding.send({ sessionId: "S1", method: "Fetch.requestPaused", params: { requestId: "G1", networkId: "N2", resourceType: "Fetch", request: { method: "GET", url: bad, headers: {} } } });
  for (let i = 0; i < 100 && !holding.commands.some((c) => c.method === "Fetch.failRequest"); i += 1) await settle(25);
  await observer.flush();
  const answers = holding.commands.filter((c) => /^Fetch\.(failRequest|continueRequest)$/.test(c.method)).map((c) => `${c.method} ${c.params.requestId}${c.params.errorReason ? ` ${c.params.errorReason}` : ""}`).sort();
  assert.deepEqual(answers, ["Fetch.continueRequest G1", "Fetch.failRequest P1 BlockedByClient"], "the unparseable POST is refused, the read goes through");

  const journaling = await startFakeCdp();
  t.after(() => journaling.close());
  const watching = await EffectObserver.open({ sdkCdpUrl: journaling.url }, null);
  t.after(() => watching.close());
  journaling.send({ sessionId: "S1", method: "Fetch.requestPaused", params: { requestId: "P2", networkId: "N3", resourceType: "Fetch", request: { method: "POST", url: bad, headers: {} } } });
  for (let i = 0; i < 40 && !journaling.commands.some((c) => c.method === "Fetch.continueRequest"); i += 1) await settle(25);
  assert.ok(journaling.commands.some((c) => c.method === "Fetch.continueRequest" && c.params.requestId === "P2"), "a journaling observer holds nothing");
});

test("the headers of a dial reach the browser's upgrade request, and are not sent as a subprotocol", async (t) => {
  const fake = await startFakeCdp();
  t.after(() => fake.close());
  const observer = await EffectObserver.open({ sdkCdpUrl: "ws://127.0.0.1:1/unused", dial: { url: fake.url, headers: { Authorization: "Bearer dial-token-0123456789" } } }, null);
  t.after(() => observer.close());
  assert.deepEqual(fake.upgrades, [{ authorization: "Bearer dial-token-0123456789", protocol: null }]);
});
