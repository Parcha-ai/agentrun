// A remote host (remote-host.ts, here a child process) runs the run through the pipe: the server dials it and invites
// it, it attaches as the writer with the move's notice, drains on the next switch, and the page that asked gets the
// run back with a notice naming the remote host.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import type { CloudHost } from "../pipe/server.ts";
import { PipeClient } from "../tab/pipe-client.ts";
import type { PipeFrame } from "../wire.ts";
import { localServer } from "./_local.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("a remote host through the pipe", () => {
  let local: Awaited<ReturnType<typeof localServer>>;
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let child: ChildProcess | undefined;
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-remote-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "remote-test-token\n", { mode: 0o600 });
  const output: string[] = [];
  const cloud: CloudHost = {
    environments: [{ id: "far-gpu", label: "Far GPU", phrase: "a far-away GPU host", kind: "remote" }],
    start: async () => ({ host: "unused" }),
    stop: async () => undefined,
    async startRemote(_ref, _env, invite) {
      const port = 18000 + Math.floor(Math.random() * 1000);
      child = spawn(process.execPath, [join(here, "..", "remote-host.ts"), "--port", String(port), "--token-file", tokenFile, "--work", join(dir, "work")], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, DEMO_ENV_LABEL: "a far-away GPU host", DEMO_ENV_CLASS: "Far GPU" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.on("data", (d) => output.push(String(d)));
      child.stderr!.on("data", (d) => output.push(String(d)));
      for (let i = 0; ; i++) {
        const socket = await new Promise<WebSocket | undefined>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { authorization: "Bearer remote-test-token" } });
          ws.once("open", () => resolve(ws));
          ws.once("error", () => resolve(undefined));
        });
        if (socket) {
          socket.send(JSON.stringify(invite));
          return { socket, host: "far-gpu-1" };
        }
        if (i > 100) throw new Error(`the remote host did not listen: ${output.join("")}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
    async stopRemote() {
      child?.kill("SIGTERM");
    },
  };
  before(async () => {
    local = await localServer({ cloud, drainMs: 5_000, superviseMs: 60_000, log: (event, data = {}) => events.push({ event, data }) });
  });
  after(async () => {
    child?.kill("SIGKILL");
    await local.remove();
  });

  const until = async (check: () => boolean, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out; remote host output: ${output.join("").slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("runs the run with the move's notice, drains on the next switch, and hands it back to the page", async () => {
    const { id, secret } = await local.server.createRun("remote");
    const frames: PipeFrame[] = [];
    const a: PipeClient = new PipeClient({
      url: local.url, run: id, token: secret, tab: "a", mode: "write",
      onFrame: (f) => {
        frames.push(f);
        if (f.t === "drain") a.send({ t: "drained", switchId: f.switchId });
      },
    });
    await a.ready;
    a.send({ t: "switch", to: "far-gpu" });
    const state = local.server.runs.get(id)!;
    await until(() => events.some((e) => e.event === "switch.done" && e.data.run === id));
    assert.equal(state.placement.where, "tab");
    assert.equal(state.placement.where === "tab" && state.placement.env, "far-gpu");
    assert.ok(output.join("").includes('"event":"running"'));
    a.close();

    // The page, watching, switches it back into itself: the remote host drains and exits, the page gets the run.
    const seen: PipeFrame[] = [];
    const v = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "view", onFrame: (f) => seen.push(f) });
    await v.ready;
    v.send({ t: "switch", to: "tab" });
    await until(() => seen.some((f) => f.t === "run-here"));
    const runHere = seen.find((f) => f.t === "run-here")!;
    assert.ok(runHere.t === "run-here");
    assert.ok(output.join("").includes('"event":"drained"'));
    const b = new PipeClient({ url: local.url, run: id, token: secret, tab: "v", mode: "write", switchId: runHere.switchId });
    const attached = await b.ready;
    assert.ok(attached.t === "attached");
    assert.deepEqual({ ...attached.move, id: undefined }, { id: undefined, from: "a far-away GPU host", planned: true });
    await until(() => child?.exitCode !== null);
    v.close();
    b.close();
  });
});
