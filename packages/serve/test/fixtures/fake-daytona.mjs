// A fake Daytona API on loopback, for the tests: no provider call runs. `fakeDaytona(t, answer)` takes each request to
// `answer` (a probe's answers); `daytonaSandboxes(t, options)` is a Daytona that keeps sandboxes and runs each toolbox
// command in a real local shell, in a directory of its own per sandbox: a box path (/run/agentrun/..., the spool under
// /tmp/pi-transport) is that directory's, so a box writes nothing else of this machine. It is as faithful as the shell
// scripts pi-transport's provider sends. Each request is kept, with the key it came on.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { scratch } from "../support.mjs";

/** A Daytona API that `answer` answers: each request is kept in `seen`. */
export async function fakeDaytona(t, answer) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    answer(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));
  return { url: `http://127.0.0.1:${server.address().port}/api`, seen };
}

// A box path in a command or a file call: where it starts a word, a quoted word or a variable's value.
const BOX_PATH = /(^|[\s'"=:])(\/run\/agentrun|\/tmp\/pi-transport)(?=[/'"\s]|$)/g;

/**
 * A Daytona that keeps sandboxes. Options: `key`, the only key it takes; `blocks` (default true), false for an
 * organization whose own network policy holds (it takes `networkBlockAll` and sets nothing); `hostileTar`, the bytes
 * every `tar -c` in a box prints instead of its archive (a box that lies on a pull); `failDeletes`, how many DELETEs it
 * answers 500 to first; `failListings`, which listings of a box's directory (the sync layer's `find`, counted from 1:
 * a seed's, then each pull's) it answers 500 to. `state.redirect` ({ from, status, location }): a toolbox call to path
 * `from` is answered with that redirect, as a box that took its toolbox's port could answer. `state.hostile` (default
 * true when `hostileTar` is given) turns the lying `tar` off and on. A sandbox keeps the `autoDeleteInterval` it was
 * made with or last set, and `autoStopInterval`: as Daytona does, a stop of one whose auto-delete is 0 deletes it.
 * `idle(id)` is Daytona's idle stop, `pause(id)` a pause; `/start` starts a stopped or paused sandbox, and a toolbox call
 * to one that is not started is refused.
 */
export async function daytonaSandboxes(t, { key, blocks = true, hostileTar, failDeletes = 0, failListings = [] } = {}) {
  const root = join(await scratch(t), "daytona");
  mkdirSync(root, { recursive: true });
  const sandboxes = new Map();
  const requests = [];
  const state = { blocks, failDeletes, listings: 0, redirect: undefined, hostile: Boolean(hostileTar) };
  let base = "";
  let hostileBin;
  if (hostileTar) {
    hostileBin = join(root, "hostile-bin");
    mkdirSync(hostileBin);
    writeFileSync(join(root, "hostile.tar"), hostileTar);
    const real = await new Promise((resolve) => {
      const child = spawn("sh", ["-c", "command -v tar"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (part) => (out += part));
      child.on("close", () => resolve(out.trim()));
    });
    writeFileSync(join(hostileBin, "tar"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = -c ] && exec cat '${join(root, "hostile.tar")}'; done\nexec '${real}' "$@"\n`);
    chmodSync(join(hostileBin, "tar"), 0o755);
  }
  const boxDir = (id) => join(root, id);
  /** A stop as Daytona makes it: a sandbox whose auto-delete is 0 is deleted. */
  const stop = (sandbox) => {
    if (sandbox.autoDeleteInterval === 0) {
      sandboxes.delete(sandbox.id);
      rmSync(boxDir(sandbox.id), { recursive: true, force: true });
    } else sandbox.state = "stopped";
  };
  const inBox = (id, text) => text.replace(BOX_PATH, (_, before, path) => `${before}${boxDir(id)}${path}`);
  const info = (sandbox, single = false) => ({
    id: sandbox.id, state: sandbox.state, labels: sandbox.labels, cpu: 1, memory: 1, disk: 3, sandboxClass: "container",
    // A sandbox's own read carries its network settings; a create's answer and a listing do not.
    ...(single && sandbox.networkBlockAll !== undefined ? { networkBlockAll: sandbox.networkBlockAll } : {}),
  });
  const json = (res, status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  const shell = (sandbox, command, timeoutS) =>
    new Promise((resolve) => {
      const child = spawn("sh", ["-c", inBox(sandbox.id, command)], {
        cwd: boxDir(sandbox.id),
        env: { PATH: `${hostileBin && state.hostile ? `${hostileBin}:` : ""}${process.env.PATH ?? "/usr/bin:/bin"}`, ...sandbox.env, TMPDIR: join(boxDir(sandbox.id), "tmp") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parts = [];
      child.stdout.on("data", (part) => parts.push(part));
      child.stderr.on("data", (part) => parts.push(part));
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutS * 1000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, result: Buffer.concat(parts).toString("utf8") });
      });
    });

  const toolbox = async (sandbox, route, url, body, type, res) => {
    if (sandbox.state !== "started") return json(res, 409, { message: `sandbox is ${sandbox.state}` });
    if (state.redirect && url.pathname === state.redirect.from) return void res.writeHead(state.redirect.status, { location: state.redirect.location }).end();
    const path = inBox(sandbox.id, url.searchParams.get("path") ?? "");
    if (route === "process/execute") {
      const { command, timeout } = JSON.parse(body.toString("utf8"));
      if (command.includes("-mindepth 1 -printf") && failListings.includes(++state.listings)) return json(res, 500, { message: "the fake refuses this listing" });
      return json(res, 200, await shell(sandbox, command, timeout));
    }
    if (route === "files/upload-v2") {
      const form = await new Response(body, { headers: { "content-type": type } }).formData();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, new Uint8Array(await form.get("file").arrayBuffer()));
      return json(res, 200, { name: "file", path, type: "file" });
    }
    if (route === "files/download") {
      try {
        return void res.writeHead(200).end(readFileSync(path));
      } catch (error) {
        return error.code === "ENOENT" ? json(res, 404, { code: "FILE_NOT_FOUND", message: "no such file" }) : json(res, 400, { code: "BAD_REQUEST", message: "path must be a file" });
      }
    }
    if (route === "files/permissions") {
      chmodSync(path, Number.parseInt(url.searchParams.get("mode") ?? "0644", 8));
      return json(res, 200, {});
    }
    return json(res, 404, { message: "no route" });
  };

  const handle = async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts);
    const url = new URL(req.url ?? "/", base);
    const method = req.method ?? "GET";
    const type = req.headers["content-type"] ?? "";
    // Anything on this machine can connect to a loopback port: `source` tells pi-transport's provider's requests.
    requests.push({ method, path: url.pathname, query: url.search, authorization: req.headers.authorization, source: req.headers["x-daytona-source"], body: type.startsWith("application/json") ? body.toString("utf8") : "" });
    if (req.headers.authorization !== `Bearer ${key}`) return json(res, 401, { statusCode: 401, message: "bad key" });
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "toolbox") {
      const sandbox = sandboxes.get(segments[1] ?? "");
      if (!sandbox) return json(res, 404, { message: "sandbox not found" });
      return toolbox(sandbox, segments.slice(2).join("/"), url, body, type, res);
    }
    const id = segments[2];
    const sandbox = id === undefined ? undefined : sandboxes.get(id);
    if (id === undefined && method === "POST") {
      const spec = JSON.parse(body.toString("utf8"));
      const made = { id: randomUUID(), state: "started", labels: spec.labels ?? {}, env: spec.env ?? {}, spec, autoDeleteInterval: spec.autoDeleteInterval ?? -1, autoStopInterval: spec.autoStopInterval ?? 15, ...(spec.networkBlockAll === true && state.blocks ? { networkBlockAll: true } : {}) };
      mkdirSync(boxDir(made.id));
      sandboxes.set(made.id, made);
      return json(res, 200, info(made));
    }
    if (id === undefined) {
      const wanted = JSON.parse(url.searchParams.get("labels") ?? "{}");
      const items = [...sandboxes.values()].filter((s) => Object.entries(wanted).every(([name, value]) => s.labels[name] === value));
      return json(res, 200, { items: items.map((s) => info(s)), nextCursor: null });
    }
    if (!sandbox) return json(res, 404, { statusCode: 404, message: "sandbox not found" });
    if (segments[3] === "toolbox-proxy-url") return json(res, 200, { url: `${base}/toolbox` });
    if (segments[3] === "stop") {
      if (state.failDeletes > 0) return json(res, 500, { message: "the fake refuses this stop" });
      return (stop(sandbox), json(res, 200, {}));
    }
    if (segments[3] === "autodelete" && method === "POST") return (sandbox.autoDeleteInterval = Number(segments[4]), json(res, 200, {}));
    if (segments[3] === "start") return (sandbox.state = "started", json(res, 200, info(sandbox, true)));
    if (segments[3] === "autostop" && method === "POST") return (sandbox.autoStopInterval = Number(segments[4]), json(res, 200, {}));
    if (method === "DELETE") {
      if (state.failDeletes > 0) {
        state.failDeletes -= 1;
        return json(res, 500, { message: "the fake refuses this delete" });
      }
      sandboxes.delete(sandbox.id);
      rmSync(boxDir(sandbox.id), { recursive: true, force: true });
      return json(res, 200, {});
    }
    // A transition under way settles after so many reads of the sandbox.
    if (sandbox.settle && --sandbox.settle.reads <= 0) {
      sandbox.state = sandbox.settle.to;
      sandbox.settle = undefined;
    }
    return json(res, 200, info(sandbox, true));
  };

  const server = createServer((req, res) => void handle(req, res).catch((error) => res.writeHead(500).end(String(error?.message ?? error))));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))));
  return {
    url: `${base}/api`,
    toolboxUrl: `${base}/toolbox`,
    root,
    sandboxes,
    requests,
    state,
    /** Daytona's idle stop of sandbox `id`, when its auto-stop is on. */
    idle: (id) => {
      const sandbox = sandboxes.get(id);
      if (sandbox && sandbox.autoStopInterval > 0) stop(sandbox);
    },
    /** Daytona's pause of sandbox `id`, as a class that pauses when idle makes it; with `reads`, it is `pausing` for that
     *  many reads of it first, as a pause under way is. */
    pause: (id, reads = 0) => {
      const sandbox = sandboxes.get(id);
      sandbox.state = reads > 0 ? "pausing" : "paused";
      sandbox.settle = reads > 0 ? { reads, to: "paused" } : undefined;
    },
    /** Daytona's archive of sandbox `id` (it moves a stopped one's disk away); with `reads`, it is `archiving` for that
     *  many reads first. `/start` restores it. */
    archive: (id, reads = 0) => {
      const sandbox = sandboxes.get(id);
      sandbox.state = reads > 0 ? "archiving" : "archived";
      sandbox.settle = reads > 0 ? { reads, to: "archived" } : undefined;
    },
    /** Where a sandbox's box path is on this machine. */
    pathOf: (id, path) => join(boxDir(id), path),
  };
}

/** A tar archive of `entries` ({name, body?, type: "file" | "dir" | "symlink", target?}), names as given (`../x` and
 *  `/x` included): what a lying box sends. */
export function tarOf(entries) {
  const blocks = [];
  const octal = (value, width) => value.toString(8).padStart(width - 1, "0") + "\0";
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write(octal(entry.type === "dir" ? 0o755 : 0o644, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(entry.type === "file" ? body.length : 0, 12), 124);
    header.write(octal(Math.floor(Date.now() / 1000), 12), 136);
    header.write("        ", 148);
    header.write(entry.type === "dir" ? "5" : entry.type === "symlink" ? "2" : "0", 156);
    if (entry.target) header.write(entry.target, 157, 100, "utf8");
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(octal(sum, 7) + " ", 148);
    blocks.push(header);
    if (entry.type === "file" && body.length) {
      blocks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
