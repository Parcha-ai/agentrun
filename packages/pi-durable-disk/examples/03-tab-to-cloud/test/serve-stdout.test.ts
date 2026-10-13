// A server whose stdout reader has gone (the harness that started it died) must neither spin nor ignore SIGTERM. Found on the demo box: three servers from a screenshot run sat at 98% CPU for 19 hours and
// only SIGKILL stopped them. Every log line was a write to a closed pipe: the error event had no listener, the uncaughtException handler logged (another failed write, another error), and the loop of
// errors starved the event loop, so no timer, request or signal was ever served again.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PipeClient } from "../tab/pipe-client.ts";

const here = import.meta.dirname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** user+system CPU ticks of a process (100 per second). */
const ticks = (pid: number) => {
  const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
  return Number(f[11]) + Number(f[12]);
};
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

test("a server whose stdout and stderr readers are gone keeps serving, uses no CPU, and stops on SIGTERM within seconds", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-stdout-"));
  const server = spawn(process.execPath, ["serve.ts", "--port", "0", "--local", dir, "--run", "rp", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--grace-ms", "3000"], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "pipe"] });
  let client: PipeClient | undefined;
  try {
    let link = "";
    server.stdout!.on("data", (d) => { const m = /http:\/\/127\.0\.0\.1:(\d+)\/run\/([\w.-]+)#([\w-]+)/.exec(String(d)); if (m && !link) link = m[0]; });
    for (let i = 0; i < 100 && !link; i++) await sleep(100);
    assert.ok(link, "the server printed its link");
    const m = /:(\d+)\/run\/([\w.-]+)#([\w-]+)/.exec(link)!;
    // the parent goes away: its ends of the server's stdout and stderr close
    server.stdout!.destroy();
    server.stderr!.destroy();
    // anything the server logs from now on is a write to a closed pipe: a page attaching logs its attach
    client = new PipeClient({ url: `ws://127.0.0.1:${m[1]}/ws`, run: m[2]!, token: m[3]!, tab: "t", mode: "write", onFrame: () => undefined });
    // a starved server never answers: the attach is given a few seconds, and the check below says what it saw
    await Promise.race([client.ready, sleep(5000)]);
    await sleep(1000);
    const before = ticks(server.pid!), at = Date.now();
    await sleep(3000);
    const used = (ticks(server.pid!) - before) / 100 / ((Date.now() - at) / 1000);
    assert.ok(alive(server), "the server is still running");
    assert.ok(used < 0.3, `idle, the server uses ${(used * 100).toFixed(0)}% of a CPU`);
    client.close();
    client = undefined;
    server.kill("SIGTERM");
    const asked = Date.now();
    while (alive(server) && Date.now() - asked < 8000) await sleep(100);
    assert.ok(!alive(server), "the server stopped within 8 s of SIGTERM");
  } finally {
    client?.close();
    if (alive(server)) server.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a server started with --parent-pid stops once that process is gone, and not before", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-parent-"));
  const parent = spawn(process.execPath, ["-e", "setTimeout(() => {}, 4000)"], { stdio: "ignore" });
  const server = spawn(process.execPath, ["serve.ts", "--port", "0", "--local", dir, "--run", "rp", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--parent-pid", String(parent.pid), "--grace-ms", "3000"], { cwd: join(here, ".."), stdio: ["ignore", "ignore", "ignore"] });
  try {
    await sleep(2500);
    assert.ok(alive(parent) && alive(server), "while its parent runs, the server runs");
    const gone = Date.now();
    while (alive(parent) && Date.now() - gone < 10_000) await sleep(100);
    const left = Date.now();
    while (alive(server) && Date.now() - left < 12_000) await sleep(100);
    assert.ok(!alive(server), "the server stopped within 12 s of its parent's exit");
  } finally {
    if (alive(server)) server.kill("SIGKILL");
    if (alive(parent)) parent.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
