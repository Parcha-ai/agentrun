// What the npx command's tests share: their temporary directories, removed once the file's tests are done; a scratch HOME
// with nothing of this machine's address, keys or model; the CLI in a child process; a server started as the npx
// command starts it; and an address where no server answers.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

const BIN = new URL("../bin/agentrun.mjs", import.meta.url).pathname;
const SERVE = new URL("../../serve/dist/cli.js", import.meta.url).pathname;
/** What a test's CLI never takes from the environment the tests run in: an address, a key, a model or boxes. */
const DROPPED = ["AGENTRUN_BASE_URL", "AGENTRUN_API_KEY", "AGENTRUN_TOKEN", "AGENTRUN_CLOUD_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL", "AGENTRUN_BOXES"];

/** An address where no server answers: a listener of the test's own, open until the test ends, that reads each request
 *  and closes the connection without a response, so Node's fetch fails with the cause UND_ERR_SOCKET ("other side
 *  closed"). It reads the request first: a connection closed before the request reaches it is reset when the request
 *  lands, and fetch then fails ECONNRESET instead, now and then, most often under load. `connections()` counts them. A CLI
 *  that may connect runs beside it, never in a blocking spawnSync. `{ base, connections }`, `base` ending in /v2. */
export async function dropping(t) {
  let connections = 0;
  const open = new Set();
  const server = createServer((socket) => {
    connections += 1;
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    let read = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      read += chunk;
      if (read.includes("\r\n\r\n")) socket.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // One still open at the end (a request never finished) would hold close: it goes.
  t.after(() => new Promise((resolve) => {
    for (const socket of open) socket.destroy();
    server.close(resolve);
  }));
  return { base: `http://127.0.0.1:${server.address().port}/v2`, connections: () => connections };
}

/** Directories to remove at the file's end. node:test runs a test's after-hooks in the order they were added, so a
 *  removal added as a directory is made would run before the stop of a command or server started in it afterwards,
 *  while that process still writes there. At the file's end every test's stops have run. */
const dirs = new Set();
// Added as this module loads, so it is the file's own hook (one added inside a test would be that test's).
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** Removes `dir` once this file's tests are done. */
export function removeAtEnd(dir) {
  dirs.add(dir);
}

/** The environment the tests run in, with nothing of DROPPED in it. */
export const keptEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED.includes(key)));

/** A scratch directory (agentrun-NAME-*, removed at the file's end) as HOME and its .config, in keptEnv with no boxes:
 *  `{dir, env}`. */
export function scratch(name) {
  const dir = mkdtempSync(join(tmpdir(), `agentrun-${name}-`));
  removeAtEnd(dir);
  return { dir, env: { ...keptEnv(), AGENTRUN_BOXES: "none", HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") } };
}

/** The CLI in a child process, `input` on its stdin (no terminal): `{code, signal, out, err, json()}`. Killed after
 *  `timeout` ms, its code then null: a guard for a command that hangs, never a wait. */
export const cli = (env, args, { input = "", timeout = 60_000, cwd } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [BIN, ...args], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.once("close", (code, signal) => (clearTimeout(timer), resolve({ code, signal, out, err, json: () => JSON.parse(out) })));
  child.stdin.end(input);
});

/** A server in a process of its own, started as the npx command starts it: on `data`, with `env` (accounts off) and the
 *  faux model module `faux` (its source). The server makes `data` itself (only the folder it sits in is made here), so
 *  the data folder's mode is the server's own. Resolves once it has written its record (DATA/.server.json, how the CLI
 *  finds it), which is watched for, never polled: the folder `data` sits in until `data` is there, then `data`. Rejects
 *  if it exits first. `{child, exited, data, base, token, api}`, `api` a request with its token answering
 *  `{status, body}`. Killed at the test's end. */
export async function server(t, { data, env, faux = 'export default (context, faux) => faux.message("Done.");\n' }) {
  // Under umask 022, a common default (CI's), whatever this machine's: a mode left to the umask shows here as it would
  // there. The server takes the umask it is spawned under, and spawn forks before it returns.
  const umask = process.umask(0o022);
  let child;
  const watchers = [];
  const fauxFile = `${data}-faux.mjs`;
  const record = join(data, ".server.json");
  try {
    mkdirSync(dirname(data), { recursive: true });
    writeFileSync(fauxFile, faux);
    watchers.push(watch(dirname(data)));
    child = spawn(process.execPath, [SERVE, "--data", data, "--port", "0", "--faux", fauxFile], { stdio: ["ignore", "ignore", "pipe"], env: { ...env, AGENTRUN_ACCOUNTS: "0" } });
  } finally {
    process.umask(umask);
  }
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  t.after(() => child.exitCode === null && child.kill("SIGKILL"));
  let err = "";
  child.stderr.on("data", (chunk) => (err += chunk));
  try {
    await new Promise((resolve, reject) => {
      const look = () => {
        try {
          // `data` once it is there, its watch set before the record is looked for, so a record written meanwhile is seen.
          if (watchers.length === 1 && existsSync(data)) watchers.push(watch(data).on("change", look).on("error", reject));
          if (existsSync(record)) resolve();
        } catch (error) {
          reject(error);
        }
      };
      watchers[0].on("change", look).on("error", reject);
      child.once("close", (code, signal) => reject(new Error(`the server on ${data} exited (${signal ?? code}) before it wrote its record: ${err}`)));
      look();
    });
  } finally {
    for (const watcher of watchers) watcher.close();
  }
  const base = JSON.parse(readFileSync(record, "utf8")).base_url;
  const token = readFileSync(join(data, ".token"), "utf8").trim();
  const api = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON: its text
    }
    return { status: res.status, body: json ?? text };
  };
  return { child, exited, data, base, token, api };
}
