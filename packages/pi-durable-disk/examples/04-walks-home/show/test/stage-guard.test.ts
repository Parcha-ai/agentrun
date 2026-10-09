import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
// @ts-expect-error plain .mjs helpers shared with the check scripts
import { assertStage, freePort, waitForStage } from "../scripts/cdp.mjs";

// A check must refuse to run unless the server it is about to test is the stage it started. On a box shared with other lanes a
// fixed port can belong to somebody else's server, and a server of ours that failed to start leaves the port to them.
describe("the guard every check script uses on its server", () => {
  let foreign: Server;
  let stageLike: Server;
  let foreignPort = 0;
  let stagePort = 0;

  before(async () => {
    // Somebody else's server: answers, but is not a stage (404 on /api/state, like the 03 server).
    foreign = createServer((_, res) => res.writeHead(404).end());
    // A server whose /api/state is JSON but not a stage's state.
    stageLike = createServer((req, res) => {
      if (req.url === "/api/state") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ run: "r", environments: [], place: { where: "tab" } }));
      res.writeHead(404).end();
    });
    await Promise.all([new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r)), new Promise<void>((r) => stageLike.listen(0, "127.0.0.1", r))]);
    foreignPort = (foreign.address() as { port: number }).port;
    stagePort = (stageLike.address() as { port: number }).port;
  });
  after(() => {
    foreign.close();
    stageLike.close();
  });

  it("accepts a server that answers with a stage's state", async () => {
    await assertStage(`http://127.0.0.1:${stagePort}`);
  });

  it("refuses somebody else's server on the port, and says what it was", async () => {
    await assert.rejects(() => assertStage(`http://127.0.0.1:${foreignPort}`), /not a stage.*404/);
  });

  it("refuses a port nothing listens on", async () => {
    await assert.rejects(async () => assertStage(`http://127.0.0.1:${await freePort()}`), /not a stage/);
  });

  it("fails fast, with the exit code, when the server it started has exited, even if another server holds the port", async () => {
    const dead = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
    await new Promise((r) => dead.once("exit", r));
    const started = Date.now();
    // The port is answered by a stage-like server of somebody else; the child is dead, so the check must still refuse.
    await assert.rejects(() => waitForStage(stagePort, dead, 20_000), /exited with code 3/);
    assert.ok(Date.now() - started < 3000, "it did not wait out the timeout");
  });

  it("returns once its own live child's server answers", async () => {
    const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    try {
      await waitForStage(stagePort, alive, 5000);
    } finally {
      alive.kill();
    }
  });

  it("times out, naming the port, when the child lives but nothing stage-like answers", async () => {
    const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: "ignore" });
    try {
      await assert.rejects(() => waitForStage(foreignPort, alive, 600), new RegExp(`${foreignPort}`));
    } finally {
      alive.kill();
    }
  });
});
