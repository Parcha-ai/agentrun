// The one port helper serve's tests hand out loopback ports with (fixtures/ports.mjs freePort): a port nothing listens on
// now, below the host's ephemeral range wherever that range starts, never one this process handed out before, and a
// listen error other than "in use" said as itself. fakeOllama's own listen says its error too.
import assert from "node:assert/strict";
import { createServer } from "node:net";
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
  const ports = [];
  for (let i = 0; i < 2000; i++) ports.push(await freePort());
  const twice = ports.filter((port, at) => ports.indexOf(port) !== at);
  assert.deepEqual(twice, [], "a port handed out twice");
});

test("a listen error other than the port being in use rejects with its own code, never read as in use and every port tried", async () => {
  // 192.0.2.1 (TEST-NET-1) is no address of this machine: a listen there fails EADDRNOTAVAIL.
  await assert.rejects(freePort({ host: "192.0.2.1" }), { code: "EADDRNOTAVAIL" });
});

test("a port in use is passed over: under a range from 1025 the one candidate is 1024, and with 1024 held it fails by name instead of handing it out", async () => {
  // Held here, or already held by something else on this machine: either way it is in use when it is tried.
  const holder = createServer();
  const held = await new Promise((resolve) => {
    holder.once("error", () => resolve(false));
    holder.listen(1024, "127.0.0.1", () => resolve(true));
  });
  try {
    await assert.rejects(freePort({ low: 1025 }), /^Error: no free port below the ephemeral range: none in 1024-1024 \(it starts at 1025\)$/);
  } finally {
    if (held) await new Promise((resolve) => holder.close(resolve));
  }
});

test("a fake Ollama asked for a port another listener holds rejects with EADDRINUSE, its cause, instead of an uncaught error", async (t) => {
  const first = await fakeOllama(t);
  const port = Number(first.host.split(":")[1]);
  await assert.rejects(fakeOllama(t, { port }), { code: "EADDRINUSE" });
});
