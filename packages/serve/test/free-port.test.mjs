// The port helper serve's tests that import it hand out loopback ports with (fixtures/ports.mjs freePort): a port nothing
// listens on now, below the host's ephemeral range wherever that range starts, never one this process handed out before
// or is probing, and a listen error other than "in use" said as itself. fakeOllama's own listen says its error too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, Server } from "node:net";
import { test } from "node:test";
import { fakeOllama } from "./fixtures/fake-ollama.mjs";
import { ephemeralLow, freePort } from "./fixtures/ports.mjs";

test("a port is below the host's ephemeral range wherever it starts: under a range from 10240 every pick is in 9240-10239, never a privileged port, and a range that leaves no port below it fails by name", async () => {
  for (let i = 0; i < 20; i++) {
    const port = await freePort({ low: 10240 });
    assert.ok(port >= 9240 && port < 10240, `below a range from 10240: ${port}`);
  }
  const low = ephemeralLow();
  const port = await freePort();
  assert.ok(port >= 1024 && port < low, `below this host's range, from ${low}: ${port}`);
  await assert.rejects(freePort({ low: 1024 }), /^Error: no port below the ephemeral range: it starts at 1024$/);
});

test("two thousand ports handed out in one process are all different, so no test is handed an address an earlier one listed or bound", async () => {
  // A range from 32768 leaves 12,768 candidates (20000-32767) wherever this host's range starts; one from 10240 would
  // leave only 1,000, fewer than this test asks for.
  const ports = [];
  for (let i = 0; i < 2000; i++) ports.push(await freePort({ low: 32768 }));
  const twice = ports.filter((port, at) => ports.indexOf(port) !== at);
  assert.deepEqual(twice, [], "a port handed out twice");
});

test("a listen error other than the port being in use rejects with its own code, never read as in use and every port tried", async () => {
  // 192.0.2.1 (TEST-NET-1) is no address of this machine: a listen there fails EADDRNOTAVAIL.
  const host = "192.0.2.1";
  // A host that binds addresses it doesn't own (net.ipv4.ip_nonlocal_bind=1) lets that listen succeed: the message carries
  // the setting as read.
  const got = await freePort({ host }).then((port) => ({ port }), (error) => ({ error }));
  assert.ok(got.error, `freePort({ host: "${host}" }) handed out ${got.port} instead of rejecting, with net.ipv4.ip_nonlocal_bind ${nonlocalBind()}`);
  assert.equal(got.error.code, "EADDRNOTAVAIL", `the listen error was said as ${got.error.code ?? "no code"}: ${got.error.message}`);
});

test("a port in use is passed over: under a range from 1025 the one candidate is 1024, and with 1024 held it fails by name instead of handing it out", async () => {
  // Held here, or already held by something else on this machine: either way it is in use when it is tried.
  const holder = createServer();
  const held = await new Promise((resolve) => {
    holder.once("error", () => resolve(false));
    holder.listen(1024, "127.0.0.1", () => resolve(true));
  });
  try {
    const got = await freePort({ low: 1025 }).then((port) => ({ port }), (error) => ({ error }));
    assert.ok(got.error, `the port in use was handed out (${got.port}), with 1024 held ${held ? "by this test" : "by something else on this machine"}`);
    assert.equal(String(got.error), "Error: no free port below the ephemeral range: none in 1024-1024 (it starts at 1025)", `the failure was said as: ${got.error}`);
  } finally {
    if (held) await new Promise((resolve) => holder.close(resolve));
  }
});

test("every port in 14000-15999 that binds now is handed out here and stays claimed for the rest of this file: the two tests below each import their own copy of the helper, so no earlier pick reaches them", async () => {
  for (const low of [15000, 16000]) {
    let got;
    do got = await freePort({ low }).then((port) => ({ port }), (error) => ({ error }));
    while (!got.error);
    assert.equal(String(got.error), `Error: no free port below the ephemeral range: none in ${low - 1000}-${low - 1} (it starts at ${low})`, `the claims ended with: ${got.error}`);
  }
});

test("two freePort calls at once never get the same port, and a port found in use is released: with H held and H+1 free, the call that starts at H+1 is handed it, the one that starts at H another, and H once it is free", async (t) => {
  // Its own copy of the helper, so no earlier test's pick in this file reaches it. A free pair found now in a range only
  // the claiming test above also asks for (from 15000: 14000-14999), not fixed ports, so a port something on this
  // machine holds is never read as a helper bug.
  const { freePort } = await import("./fixtures/ports.mjs?fresh=15000");
  const low = 15000;
  const from = 14000;
  const holder = createServer();
  let held;
  for (let port = from; port < low - 2 && held === undefined; port++) {
    if (!(await listenOn(holder, port))) continue;
    if (await bindsNow(port + 1)) held = port;
    else await closeServer(holder);
  }
  assert.ok(held !== undefined, `no two free neighbouring ports in ${from}-${low - 2} on this host`);
  t.after(() => closeServer(holder));
  const next = held + 1;
  const at = (port) => (port - from + 0.5) / (low - from);
  const starts = [at(held), at(next)];
  t.mock.method(Math, "random", () => starts.shift());
  // The first call starts at H, finds it in use and moves on to H+1; the second starts at H+1. The second claims H+1
  // before its first await, so the first finds it claimed whatever order the probes settle in, and moves on again. A
  // helper that claims a port only after probing it hands H+1 to both.
  const calls = await Promise.allSettled([freePort({ low }), freePort({ low })]);
  const [first, second] = calls.map((call) => call.value ?? call.reason.message);
  assert.ok(second === next && first !== next && first !== held, `the ports handed out: ${first} and ${second}, with ${held} held and ${next} free`);
  await closeServer(holder);
  starts.push(at(held));
  assert.equal(await freePort({ low }), held, `the port found in use (${held}) is handed out once it is free`);
});

test("a port whose probe fails with another error is released: the call rejects with that error, and the next call is handed the port", async (t) => {
  // Its own copy of the helper, so no earlier test's pick in this file reaches it. A free port found now in a range only
  // the claiming test above also asks for (from 16000: 15000-15999).
  const { freePort } = await import("./fixtures/ports.mjs?fresh=16000");
  const low = 16000;
  const from = 15000;
  let port = from;
  while (port < low && !(await bindsNow(port))) port++;
  assert.ok(port < low, `no free port in ${from}-${low - 1} on this host`);
  const at = (candidate) => (candidate - from + 0.5) / (low - from);
  const starts = [at(port), at(port)];
  t.mock.method(Math, "random", () => starts.shift());
  // Every listen fails with an error that is not "in use" until the mock is restored.
  const listen = t.mock.method(Server.prototype, "listen", function () {
    process.nextTick(() => this.emit("error", Object.assign(new Error("a listen that fails"), { code: "EMOCKED" })));
    return this;
  });
  const got = await freePort({ low }).then((port) => ({ port }), (error) => ({ error }));
  listen.mock.restore();
  const said = got.error ? `${got.error.code ?? "no code"}: ${got.error.message}` : `no error, port ${got.port} handed out`;
  assert.equal(got.error?.code, "EMOCKED", `the probe's own error (EMOCKED) is passed up, not read as in use: the call ended with ${said}`);
  const again = await freePort({ low }).then((port) => ({ port }), (error) => ({ error }));
  assert.equal(again.port, port, `the port whose probe failed (${port}) is handed out by the next call: it ended with ${again.error?.message ?? `port ${again.port}`}`);
});

test("a fake Ollama asked for a port another listener holds rejects with EADDRINUSE instead of an uncaught error", async (t) => {
  const first = await fakeOllama(t);
  const port = Number(first.host.split(":")[1]);
  await assert.rejects(fakeOllama(t, { port }), { code: "EADDRINUSE" });
});

/** net.ipv4.ip_nonlocal_bind as this host reads it: "at 0", "at 1", or why it can't be read. */
function nonlocalBind() {
  try {
    return `at ${readFileSync("/proc/sys/net/ipv4/ip_nonlocal_bind", "utf8").trim()}`;
  } catch (error) {
    return `unread (${error.code ?? error.message})`;
  }
}

/** Listens `server` on `port` at 127.0.0.1: true once it listens, false when the port is in use, any other error rejected. */
function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    const listening = () => {
      server.off("error", failed);
      resolve(true);
    };
    const failed = (error) => {
      server.off("listening", listening);
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(port, "127.0.0.1");
  });
}

/** Whether `port` binds on 127.0.0.1 now, the probe closed at once. */
async function bindsNow(port) {
  const probe = createServer();
  if (!(await listenOn(probe, port))) return false;
  await closeServer(probe);
  return true;
}

/** Closes `server` if it listens; resolves either way. */
function closeServer(server) {
  return new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
}
