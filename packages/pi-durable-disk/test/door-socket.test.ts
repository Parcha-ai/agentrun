// The door on a unix socket (`serveRun({ socket })`, `run --dir --serve-socket`): made 0600, its address `unix:<absolute
// path>` in run.json's holder, the bearer token as on loopback, a dead door's socket replaced and a live one refused, a
// path longer than a socket address holds refused by name, and the socket gone when the instance ends. The routes
// themselves answer as on loopback: door-exchange.test.ts runs the recorded exchange over a socket too.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";
import { ServeConfigError, serveRun, SOCKET_PATH_MAX, type RunServer } from "../src/serve.ts";
import { until } from "./_lifecycle.ts";
import { scratchRoot } from "./_run-support.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const APP = fileURLToPath(new URL("./fixtures/lifecycle-app.ts", import.meta.url));
const TOKEN = "door-socket-token";

type Reply = { status: number; body: Record<string, any>; headers: Record<string, unknown> };

/** One request to the door listening on `socketPath`, on a connection of its own. */
function call(socketPath: string, method: "GET" | "POST", path: string, options: { token?: string; body?: unknown } = {}): Promise<Reply> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers = {
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }),
  };
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, method, path, headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) as Record<string, any>, headers: res.headers }));
    });
    req.once("error", reject).end(payload);
  });
}

/** A socket file at `path` that nothing listens on: what a door killed with SIGKILL leaves. */
async function deadSocket(path: string): Promise<void> {
  const live = createNetServer();
  await new Promise<void>((resolve) => live.listen(`${path}.live`, resolve));
  linkSync(`${path}.live`, path);
  // libuv removes the name the server bound as it closes; the second name stays, with nothing behind it.
  await new Promise<void>((resolve) => live.close(() => resolve()));
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const refusedWith = (code: string, message?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof ServeConfigError, String(error));
  assert.equal(error.code, code);
  if (message) assert.match(error.message, message);
  return true;
};

describe("the door on a unix socket", () => {
  it("is made 0600 whatever the umask, is named unix:<absolute path>, takes the bearer token as loopback does, and is gone once closed", async () => {
    const dir = scratchRoot("door-socket-mode");
    const umask = process.umask(0);
    let server: RunServer | undefined;
    try {
      const socket = join(dir.root, "door.sock");
      server = await serveRun({ socket, token: TOKEN });
      process.umask(umask);
      const made = lstatSync(socket);
      assert.ok(made.isSocket());
      assert.equal((made.mode & 0o777).toString(8), "600", "only the owner can connect");
      assert.equal(server.url, `unix:${socket}`);
      const missing = await call(socket, "GET", "/status");
      assert.deepEqual([missing.status, missing.body.error, missing.headers["www-authenticate"]], [401, "UNAUTHORIZED", "Bearer"]);
      const wrong = await call(socket, "GET", "/status", { token: "not-the-token" });
      assert.deepEqual([wrong.status, wrong.body.error], [401, "UNAUTHORIZED"]);
      const right = await call(socket, "GET", "/status", { token: TOKEN });
      assert.deepEqual([right.status, right.body.error], [503, "OPENING"], "past the token, the run is not attached yet");
      await server.close();
      server = undefined;
      assert.equal(existsSync(socket), false, "closing the server removes its socket");
    } finally {
      process.umask(umask);
      await server?.close();
      dir.remove();
    }
  });

  it("replaces a dead door's socket, refuses a live door's and leaves it serving, and leaves anything that is not a socket", async () => {
    const dir = scratchRoot("door-socket-stale");
    const servers: RunServer[] = [];
    try {
      const socket = join(dir.root, "door.sock");
      await deadSocket(socket);
      const dead = lstatSync(socket);
      assert.ok(dead.isSocket());
      servers.push(await serveRun({ socket, token: TOKEN }));
      const live = lstatSync(socket);
      assert.notEqual(live.ino, dead.ino, "the dead socket was replaced");
      assert.equal((await call(socket, "GET", "/status", { token: TOKEN })).status, 503);

      await assert.rejects(serveRun({ socket, token: TOKEN }), refusedWith("SERVE_SOCKET_IN_USE", /live door's socket/));
      assert.equal(lstatSync(socket).ino, live.ino, "the live door's socket is where it was");
      assert.equal((await call(socket, "GET", "/status", { token: TOKEN })).status, 503, "and still answers");

      const file = join(dir.root, "not-a-socket");
      writeFileSync(file, "kept\n");
      await assert.rejects(serveRun({ socket: file }), refusedWith("SERVE_SOCKET_INVALID", /is not a socket/));
      assert.equal(readFileSync(file, "utf8"), "kept\n");
    } finally {
      for (const server of servers) await server.close();
      dir.remove();
    }
  });

  it("refuses a path longer than a socket address holds, by name and before anything is made; a path of exactly the limit is served whole", async (t) => {
    const dir = scratchRoot("door-socket-long");
    try {
      const at = (bytes: number) => join(dir.root, "s".repeat(bytes - dir.root.length - 1));
      if (dir.root.length + 2 > SOCKET_PATH_MAX) return t.skip(`the scratch directory ${dir.root} leaves no room under ${SOCKET_PATH_MAX} bytes`);
      const long = at(SOCKET_PATH_MAX + 1);
      await assert.rejects(serveRun({ socket: long }), refusedWith("SERVE_SOCKET_TOO_LONG", new RegExp(`${literal(long)} is ${SOCKET_PATH_MAX + 1} bytes.*at most ${SOCKET_PATH_MAX}`)));
      assert.deepEqual(readdirSync(dir.root), [], "nothing was made, not even a cut name");

      const exact = at(SOCKET_PATH_MAX);
      const server = await serveRun({ socket: exact });
      try {
        assert.equal(server.url, `unix:${exact}`);
        assert.ok(lstatSync(exact).isSocket(), "the socket is at the whole path");
        assert.equal((await call(exact, "GET", "/status")).status, 503);
      } finally {
        await server.close();
      }
    } finally {
      dir.remove();
    }
  });

  it("refuses a socket beside a TCP address: no port, host or url", async () => {
    const dir = scratchRoot("door-socket-tcp");
    try {
      const socket = join(dir.root, "door.sock");
      await assert.rejects(serveRun({ socket, host: "127.0.0.1" }), refusedWith("SERVE_SOCKET_INVALID", /drop host/));
      await assert.rejects(serveRun({ socket, port: 0 }), refusedWith("SERVE_SOCKET_INVALID", /drop port/));
      await assert.rejects(serveRun({ socket, url: "http://door.example" }), refusedWith("SERVE_SOCKET_INVALID", /drop url/));
      assert.equal(existsSync(socket), false);
    } finally {
      dir.remove();
    }
  });
});

describe("--serve-socket", () => {
  it("is refused beside --serve, --serve-host or --serve-url, and on a disk's run; a path too long is refused by name", async () => {
    const dir = scratchRoot("door-socket-cli");
    const written: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => (written.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      const run = join(dir.root, "run");
      const socket = join(dir.root, "door.sock");
      const base = ["run", "--dir", run, "--app", APP, "--serve-socket", socket];
      assert.equal(await main([...base, "--serve-host", "127.0.0.1"]), 2);
      assert.equal(await main([...base, "--serve", "0"]), 2);
      assert.equal(await main([...base, "--serve-url", "http://door.example"]), 2);
      assert.equal(await main(["run", "--disk", "d", "--region", "r", "--id", "x", "--app", APP, "--serve-socket", socket]), 2);
      const long = join(dir.root, "s".repeat(SOCKET_PATH_MAX));
      assert.equal(await main(["run", "--dir", run, "--app", APP, "--serve-socket", long]), 2);
      assert.equal(existsSync(socket), false);
      assert.equal(existsSync(run), false, "nothing opened the run");
    } finally {
      process.stderr.write = write;
      dir.remove();
    }
    const text = written.join("");
    assert.match(text, /--serve-socket serves on a unix socket in place of a TCP address: drop --serve-host\n/);
    assert.match(text, /drop --serve\n/);
    assert.match(text, /drop --serve-url\n/);
    assert.match(text, /--serve-socket serves a run in a local directory \(--dir\)/);
    assert.match(text, /"error":"SERVE_SOCKET_TOO_LONG"/);
  });

  it("an instance serves its run on the socket, run.json's holder names it, and the socket goes when the instance drains and exits", { timeout: 90_000 }, async () => {
    const dir = scratchRoot("door-socket-instance");
    const out = join(dir.root, "out");
    const run = join(dir.root, "run");
    mkdirSync(out);
    mkdirSync(run);
    const socket = join(run, "door.sock");
    const tokenFile = join(dir.root, "door-token");
    writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    const child = spawn(process.execPath, [CLI, "run", "--dir", run, "--app", APP, "--serve-socket", socket, "--serve-token-file", tokenFile], {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PDA_TEST_OUT: out },
    });
    const events: Record<string, unknown>[] = [];
    let stderr = "";
    createInterface({ input: child.stderr! }).on("line", (line) => {
      stderr += `${line}\n`;
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // not a log line
      }
    });
    const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    try {
      const running = await until("the instance's door", () => events.find((e) => e.event === "running"), 30_000);
      assert.equal(running.serve, `unix:${socket}`, stderr);
      const holder = (JSON.parse(readFileSync(join(run, "run.json"), "utf8")) as { holder: { serve?: unknown } }).holder;
      assert.equal(holder.serve, `unix:${socket}`, "run.json's holder names the socket");
      assert.equal((lstatSync(socket).mode & 0o777).toString(8), "600");
      assert.equal((await call(socket, "GET", "/status")).status, 401, "the token file applies");
      const answered = await call(socket, "POST", "/submit", { token: TOKEN, body: { requestId: "s1", content: "hello", wait: true } });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      assert.equal(answered.body.answer.text, "echo: hello");
      process.kill(child.pid!, "SIGTERM");
      assert.equal(await exited, 0, stderr);
      assert.equal(existsSync(socket), false, "the instance's exit removed its socket");
    } finally {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // gone
      }
      dir.remove();
    }
  });
});
