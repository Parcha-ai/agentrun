// A server whose build lacks what it ships: no pack directory at all, or one skill a shipped pack names. Each case is
// decided when a run is asked for, before any run's process exists. The server runs in a process of its own whose
// node:fs reads every path under HIDE as missing (patched before serve loads), so the build on disk is untouched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agent, client, FAUX, printed, scratch } from "./support.mjs";

const DIST = new URL("../dist/", import.meta.url);
const PACKS = fileURLToPath(new URL("packs/", DIST));

/** The server's process: node:fs with every path under HIDE missing, then serve, then its address on one line. */
const SERVER = `import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const hidden = process.env.HIDE;
const gone = (p) => String(p instanceof URL ? decodeURIComponent(p.pathname) : p).startsWith(hidden);
const missing = (p) => Object.assign(new Error("ENOENT: no such file or directory, open '" + String(p) + "'"), { code: "ENOENT", errno: -2, syscall: "open", path: String(p) });
for (const name of ["readFileSync", "statSync", "lstatSync", "readdirSync", "accessSync", "openSync"]) {
  const real = fs[name];
  fs[name] = (p, ...rest) => { if (gone(p)) throw missing(p); return real(p, ...rest); };
}
const exists = fs.existsSync;
fs.existsSync = (p) => !gone(p) && exists(p);
for (const name of ["readFile", "readdir", "stat", "lstat", "access", "open", "copyFile"]) {
  const real = fsp[name];
  fsp[name] = async (p, ...rest) => { if (gone(p)) throw missing(p); return real(p, ...rest); };
}
syncBuiltinESMExports();
const { startServe } = await import(process.env.DIST_INDEX);
const server = await startServe({ data: process.env.DATA, port: 0, faux: process.env.FAUX, drainTimeout: "5s" });
process.stdout.write(JSON.stringify({ baseUrl: server.baseUrl, token: server.token }) + "\\n");
`;

/** A server whose build reads every path under `hide` as missing, and a client for it. */
async function serverHiding(t, hide) {
  const dir = await scratch(t);
  const script = join(dir, "server.mjs");
  await writeFile(script, SERVER);
  const env = { ...process.env, HIDE: hide, DIST_INDEX: new URL("index.js", DIST).href, DATA: join(dir, "agents"), FAUX };
  const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => (child.exitCode === null && child.signalCode === null ? child.kill("SIGTERM") : undefined));
  const out = await printed(child, /^\{"baseUrl"/m);
  const { baseUrl, token } = JSON.parse(out.split("\n").find((line) => line.startsWith('{"baseUrl"')));
  return client(baseUrl, token);
}

test("a server whose build ships no pack directory starts, and a run that asks for an output type gets the 422 that says it ships no default pack", async (t) => {
  const api = await serverHiding(t, PACKS);
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const run = await api("POST", "/agents/plain/runs", { input: { content: "hi" }, output: "report" });
  assert.equal(run.status, 422, JSON.stringify(run.body));
  assert.deepEqual(run.body.error.fields.map((f) => [f.field, f.reason]), [["output", "not_an_option"]]);
  assert.match(run.body.error.fields[0].message, /ships no default one/);
});

test("a shipped pack that names a skill its build does not ship is this server's packaging error (500, not retryable, the pack and the skill named), never a 422 telling the caller to change the revision", async (t) => {
  const api = await serverHiding(t, join(PACKS, "default", "skills", "report-writer") + "/");
  assert.equal((await api("POST", "/agents", agent("plain"))).status, 201);
  const run = await api("POST", "/agents/plain/runs", { input: { content: "hi" }, output: "report" });
  assert.equal(run.status, 500, JSON.stringify(run.body));
  assert.equal(run.body.error.code, "internal");
  assert.equal(run.body.error.retryable, false, "the same build answers the same way: a retry never fixes it");
  assert.deepEqual(run.body.error.details, { pack: "default", skills: ["report-writer"] });
  assert.match(run.body.error.message, /pack default .*report-writer.*packaging/);
  assert.doesNotMatch(run.body.error.message, /revision|agent's skills/);
});
