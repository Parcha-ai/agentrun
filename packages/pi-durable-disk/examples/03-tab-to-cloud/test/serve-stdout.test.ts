// A server whose stdout reader has gone (the harness that started it died) must neither spin nor ignore SIGTERM. Found on the demo box: three servers from a screenshot run sat at 98% CPU for 19 hours and
// only SIGKILL stopped them. Every log line was a write to a closed pipe: the error event had no listener, the uncaughtException handler logged (another failed write, another error), and the loop of
// errors starved the event loop, so no timer, request or signal was ever served again.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    // a starved server never answers: the attach is given a few seconds, and if it does not come the test fails with what the server is doing
    const attach = await Promise.race([client.ready.then(() => "attached" as const), sleep(8000).then(() => "timeout" as const)]);
    if (attach === "timeout") {
      const t0 = ticks(server.pid!), at = Date.now();
      await sleep(1000);
      assert.fail(`the page did not attach in 8 s; the server uses ${(((ticks(server.pid!) - t0) / 100 / ((Date.now() - at) / 1000)) * 100).toFixed(0)}% of a CPU`);
    }
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

test("a log file that becomes unwritable does not stop the server from shutting down: SIGTERM still closes it and it exits", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "serve-log-"));
  const logDir = join(dir, "logs");
  mkdirSync(logDir);
  const server = spawn(process.execPath, ["serve.ts", "--port", "0", "--local", join(dir, "disk"), "--run", "rp", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--log", join(logDir, "server.log"), "--grace-ms", "3000"], { cwd: join(here, ".."), stdio: ["ignore", "pipe", "ignore"] });
  try {
    let ready = false;
    server.stdout!.on("data", (d) => { if (/"event":"ready"/.test(String(d))) ready = true; });
    for (let i = 0; i < 100 && !ready; i++) await sleep(100);
    assert.ok(ready, "the server is ready");
    rmSync(logDir, { recursive: true, force: true }); // its log file's directory is gone: every append fails from here on
    server.kill("SIGTERM");
    const asked = Date.now();
    while (alive(server) && Date.now() - asked < 8000) await sleep(100);
    assert.ok(!alive(server), "the server exited within 8 s of SIGTERM although its log file cannot be written");
  } finally {
    if (alive(server)) server.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--parent-pid must be a positive whole number: 0 (the process group), text and negatives are refused at start", { timeout: 30_000 }, async () => {
  for (const bad of ["0", "abc", "-5", "12.5", ""]) {
    const dir = mkdtempSync(join(tmpdir(), "serve-pid-"));
    const server = spawn(process.execPath, ["serve.ts", "--port", "0", "--local", dir, "--run", "rp", "--model", "stub", "--model-url", "http://127.0.0.1:9/v1", "--parent-pid", bad], { cwd: join(here, ".."), stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    server.stderr!.on("data", (d) => (err += String(d)));
    try {
      const asked = Date.now();
      while (alive(server) && Date.now() - asked < 10_000) await sleep(50);
      // 2 is the server's own refusal; "-5" never gets that far (the argument parser takes it for another flag and refuses it itself, exit 1)
      assert.ok(server.exitCode === 2 || (bad === "-5" && server.exitCode === 1), `--parent-pid "${bad}" was refused (exit ${server.exitCode})`);
      if (server.exitCode === 2) assert.match(err, /--parent-pid/, "and it says which flag");
    } finally {
      if (alive(server)) server.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
