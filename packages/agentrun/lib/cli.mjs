// `npx @parcha/agentrun agents list`: the server's API from the terminal. Every command is an operation of the server's
// OpenAPI document, read from the generated table (commands.generated.mjs); nothing here is written per command. Waiting for
// a run and following it live (runs start --wait, runs wait, runs timeline --follow) are follow.mjs's.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { COMMANDS } from "./commands.generated.mjs";
import { FLAGS, WAIT, followTimeline, waitRun } from "./follow.mjs";

export const NOUNS = new Set(["api", "help", ...COMMANDS.map((entry) => entry.command[0])]);
const DEFAULT_BASE_URL = "http://127.0.0.1:7340/v2"; // key-gate: loopback-rule the default address of the server started on this machine
const START = "start it with `npx @parcha/agentrun`";
const GLOBAL = { "base-url": { type: "string" }, data: { type: "string" }, help: { type: "boolean", short: "h" } };
const BODY = "--body JSON|@FILE|-";

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const usageError = (message) => new Exit(2, message);
const flag = (name) => name.replace(/_/g, "-");

/** The words of `argv` that are not flags, past the values of the flags placed before a command (--data, --base-url,
 *  and the server's --port). */
export function words(argv) {
  const found = [];
  for (let i = 0; i < argv.length; i++) {
    if (["--data", "--base-url", "--port"].includes(argv[i])) i++;
    else if (!argv[i].startsWith("-")) found.push(argv[i]);
  }
  return found;
}

const HELP = () => {
  const groups = new Map();
  for (const { command, summary } of COMMANDS) groups.set(command[0], command.length === 1 ? [summary] : [...(groups.get(command[0]) ?? []), command[1]]);
  groups.set(WAIT.command[0], [...groups.get(WAIT.command[0]), WAIT.command[1]].sort());
  const width = Math.max(...[...groups.keys()].map((noun) => noun.length));
  return [
    "Usage: npx @parcha/agentrun <command> [args] [--base-url URL] [--data DIR]",
    "",
    "Commands (agentrun <command> --help for a command's arguments):",
    ...[...groups].map(([noun, verbs]) => `  ${noun.padEnd(width)}  ${verbs.join(", ")}`),
    `  ${"api".padEnd(width)}  METHOD PATH [${BODY}], any route, PATH under the base URL (/agents)`,
    "",
    "The server: --base-url, else AGENTRUN_BASE_URL, else base_url in $XDG_CONFIG_HOME/agentrun/config.json, else the",
    "server started on this machine with the data directory (--data, default ~/.agentrun). The token: AGENTRUN_API_KEY,",
    "else api_key in the config file, else that server's own; it is never a flag and never printed.",
    "Output: the response's JSON on stdout; an error's on stderr. Exit codes: 0 ok, 1 the server refused, 2 bad usage,",
    "3 the server cannot be reached, 4 no token or the token was refused. runs wait and runs start --wait print the run",
    "once it ends or waits on a person: 0 completed, 1 failed, cancelled or --timeout passed (it goes on), 8 it waits on a",
    "person (a question, its spend cap, a stopped turn, a paused workflow). runs timeline --follow prints the timeline's",
    "pages as they come, one JSON object per line, until the run ends: 0 completed, 1 failed or cancelled.",
  ].join("\n");
};

const usageOf = (entry) => `agentrun ${entry.command.join(" ")}${entry.pathParams.map((name) => ` ${name.toUpperCase()}`).join("")}`;
const helpOf = (entry, flags) => {
  const width = Math.max(0, ...flags.map(([name]) => name.length));
  return [`Usage: ${usageOf(entry)}${flags.length ? " [flags]" : ""}`, "", `${entry.summary}${entry.method ? ` (${entry.method} ${entry.path})` : ""}`, ...(flags.length ? ["", ...flags.map(([name, text]) => `  ${name.padEnd(width)}  ${text}`.trimEnd())] : [])].join("\n");
};

function commandHelp(entry) {
  const flags = [...entry.query, ...entry.bodyFlags].map((f) => {
    const value = f.type === "boolean" ? "" : ` ${f.enum ? f.enum.join("|") : f.type.toUpperCase()}`;
    return [`--${flag(f.name)}${value}`, `${f.required ? "(required) " : ""}${f.description}`];
  });
  if (entry.hasBody) flags.push([BODY, entry.secretBody ? "the body, from stdin or a file only: it holds a secret" : `the body (${entry.bodyType}), inline, from a file or from stdin; flags win over its fields`]);
  return helpOf(entry, [...flags, ...(FLAGS[entry.operationId]?.help ?? [])]);
}

const nounHelp = (noun, entries) => [`Usage: agentrun ${noun} <verb> [args]`, "", ...entries.map((entry) => `  ${usageOf(entry).padEnd(40)}  ${entry.summary}`)].join("\n");

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw usageError(`${file} is not readable JSON: ${error.message}`);
  }
};

const alive = (pid) => {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
};

const trim = (url) => url.replace(/\/+$/, "");

/** Where the request goes and the token it carries. A token goes only with the address it came with: the local
 *  server's own token is never sent to another server. */
function targetOf(values, env) {
  const data = resolve(values.data ?? join(homedir(), ".agentrun"));
  const configFile = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentrun", "config.json");
  const config = readJson(configFile) ?? {};
  const recordFile = join(data, ".server.json");
  const record = readJson(recordFile);
  const stale = record && `The server recorded in ${recordFile} (pid ${record.pid}) is not running; ${START} or set AGENTRUN_BASE_URL.`;
  const local = trim(record?.base_url ?? DEFAULT_BASE_URL);
  const base = trim(values["base-url"] ?? env.AGENTRUN_BASE_URL ?? config.base_url ?? local);
  let token = env.AGENTRUN_API_KEY || (config.base_url && base === trim(config.base_url) ? config.api_key : undefined);
  const isLocal = base === local;
  if (isLocal && record && !alive(record.pid)) throw new Exit(3, stale);
  if (!token && isLocal) {
    const tokenFile = record ? record.token_file : join(data, ".token");
    if (record && !tokenFile) throw new Exit(4, `The server recorded in ${recordFile} was started with its token in AGENTRUN_TOKEN; set AGENTRUN_API_KEY to it.`);
    try {
      token = readFileSync(tokenFile, "utf8").trim();
    } catch {
      token = undefined;
    }
  }
  if (!token) {
    throw new Exit(4, isLocal
      ? `No token: AGENTRUN_API_KEY is not set and ${join(data, ".token")} does not exist; ${START} (--data DIR for another data directory) or set AGENTRUN_API_KEY.`
      : `No token for ${base}: set AGENTRUN_API_KEY.`);
  }
  return { base, token, unreachable: isLocal && record ? stale : undefined };
}

async function readBody(value, stdin) {
  if (value === "-") {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  if (value.startsWith("@")) {
    try {
      return readFileSync(value.slice(1));
    } catch (error) {
      throw usageError(`--body ${value}: ${error.code === "ENOENT" ? "no such file" : error.message}`);
    }
  }
  return Buffer.from(value);
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw usageError(`--body is not JSON: ${error.message}`);
  }
}

const isJson = (bytes) => {
  try {
    return JSON.parse(bytes.toString("utf8")), true;
  } catch {
    return false;
  }
};

function coerce(f, value) {
  if (f.type === "boolean") return value;
  if (f.type === "number" || f.type === "integer") {
    const n = Number(value);
    if (value.trim() === "" || !Number.isFinite(n) || (f.type === "integer" && !Number.isInteger(n))) throw usageError(`--${flag(f.name)} takes ${f.type === "integer" ? "a whole number" : "a number"}, not ${value}`);
    return n;
  }
  if (f.enum && !f.enum.includes(value)) throw usageError(`--${flag(f.name)} takes one of ${f.enum.join(", ")}, not ${value}`);
  return value;
}

const refuseInline = (what, value) => {
  if (value !== undefined && value !== "-" && !value.startsWith("@")) throw usageError(`${what} carries a secret: pass the body on stdin (--body -) or in a file (--body @FILE), never on the command line.`);
};

/** Requests to the target with its token (follow.mjs takes one): an error's body on stderr with its exit code, and JSON
 *  on stdout. */
function clientOf(target, io) {
  return {
    io,
    fetch: (path, { method = "GET", headers = {}, body, signal } = {}) => fetch(`${target.base}${path}`, { method, signal, headers: { accept: "application/json, */*", ...headers, authorization: `Bearer ${target.token}` }, ...(body !== undefined ? { body } : {}) }),
    unreachable: (error) => new Exit(3, target.unreachable ?? `Cannot reach the server at ${target.base} (${error.cause?.code ?? error.message}); ${START} or set AGENTRUN_BASE_URL.`),
    refused(response, bytes) {
      io.stderr.write(bytes.length ? bytes : `${response.status} ${response.statusText}`);
      if (!bytes.length || bytes.at(-1) !== 10) io.stderr.write("\n");
      return response.status === 401 || response.status === 403 ? 4 : 1;
    },
    print: (value) => io.stdout.write(`${io.stdout.isTTY ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`),
  };
}

/** One request: its response, bytes and JSON value, or `{ code }` when it was refused (the error on stderr). */
async function send(client, method, path, body, contentType) {
  let response;
  let bytes;
  try {
    response = await client.fetch(path, { method, headers: body !== undefined ? { "content-type": contentType } : {}, body });
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw client.unreachable(error);
  }
  if (!response.ok) return { code: client.refused(response, bytes) };
  if (response.status === 204 || bytes.length === 0) return { response, bytes };
  if (!/^application\/(?:[\w.+-]+\+)?json\b/.test(response.headers.get("content-type") ?? "")) return { response, bytes };
  return { response, bytes, value: JSON.parse(bytes.toString("utf8")) };
}

/** One request, its answer on stdout; the exit code. */
async function sendAndPrint(client, method, path, body, contentType) {
  const sent = await send(client, method, path, body, contentType);
  if (sent.code !== undefined) return sent.code;
  if (sent.value !== undefined) client.print(sent.value);
  else client.io.stdout.write(sent.bytes);
  return 0;
}

/** `--timeout SECONDS` in milliseconds. */
function timeoutOf(value) {
  if (value === undefined) return undefined;
  const seconds = coerce({ name: "timeout", type: "number" }, value);
  if (seconds <= 0) throw usageError(`--timeout takes a number of seconds above 0, not ${value}`);
  return seconds * 1000;
}

/** `runs wait RUN_ID [--timeout SECONDS]`. */
async function wait(argv, env, io) {
  const { values, positionals } = parse(argv, { ...GLOBAL, timeout: { type: "string" } });
  if (values.help) return io.stdout.write(`${helpOf(WAIT, WAIT.help)}\n`), 0;
  const args = positionals.slice(WAIT.command.length);
  if (args.length !== 1) throw usageError(`${helpOf(WAIT, WAIT.help)}\n\n${usageOf(WAIT)} takes 1 argument, given ${args.length}.`);
  const timeout = timeoutOf(values.timeout);
  return waitRun(clientOf(targetOf(values, env), io), args[0], timeout);
}

const parse = (argv, options) => {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, allowNegative: true, strict: true });
  } catch (error) {
    throw usageError(error.message);
  }
};

async function api(argv, env, io) {
  const { values, positionals } = parse(argv, { ...GLOBAL, body: { type: "string" } });
  const [, method, path] = positionals;
  if (values.help || method === undefined) return io.stdout.write(`Usage: agentrun api METHOD PATH [${BODY}]\n\nAny route of the server; PATH is under the base URL (/agents, /runs/RUN_ID).\n`), values.help ? 0 : 2;
  if (path === undefined || !path.startsWith("/") || positionals.length > 3) throw usageError("Usage: agentrun api METHOD PATH [--body JSON|@FILE|-]; PATH starts with /");
  const verb = method.toUpperCase();
  const secret = COMMANDS.find((entry) => entry.secretBody && entry.method === verb && new RegExp(`^${entry.path.replace(/\{[^}]+\}/g, "[^?]+")}(?:\\?|$)`).test(path));
  if (secret) refuseInline(`${verb} ${secret.path}`, values.body);
  const body = values.body === undefined ? undefined : await readBody(values.body, io.stdin);
  return sendAndPrint(clientOf(targetOf(values, env), io), verb, path, body, body !== undefined && isJson(body) ? "application/json" : "application/octet-stream");
}

async function command(entry, argv, env, io) {
  const options = { ...GLOBAL };
  for (const f of [...entry.query, ...entry.bodyFlags]) options[flag(f.name)] = { type: f.type === "boolean" ? "boolean" : "string" };
  if (entry.hasBody) options.body = { type: "string" };
  Object.assign(options, FLAGS[entry.operationId]?.options);
  const { values, positionals } = parse(argv, options);
  if (values.help) return io.stdout.write(`${commandHelp(entry)}\n`), 0;
  const args = positionals.slice(entry.command.length);
  if (args.length !== entry.pathParams.length) throw usageError(`${commandHelp(entry)}\n\n${usageOf(entry)} takes ${entry.pathParams.length || "no"} argument${entry.pathParams.length === 1 ? "" : "s"}, given ${args.length}.`);
  const path = entry.path.replace(/\{([^}]+)\}/g, (_, name) => args[entry.pathParams.indexOf(name)].split("/").map(encodeURIComponent).join("/"));
  const query = new URLSearchParams();
  for (const q of entry.query) {
    const value = values[flag(q.name)];
    if (value !== undefined) query.set(q.name, String(coerce(q, value)));
    else if (q.required) throw usageError(`${usageOf(entry)} needs --${flag(q.name)}.`);
  }
  if (entry.secretBody) refuseInline(entry.command.join(" "), values.body);
  let body = values.body === undefined ? undefined : await readBody(values.body, io.stdin);
  if (entry.bodyType === "application/json") {
    let object = body === undefined ? undefined : parseJson(body);
    const fields = entry.bodyFlags.filter((f) => values[flag(f.name)] !== undefined).map((f) => [f.name, coerce(f, values[flag(f.name)])]);
    if (fields.length) {
      if (object !== undefined && (object === null || typeof object !== "object" || Array.isArray(object))) throw usageError("--body is not a JSON object, so it cannot take the flags' fields.");
      object = { ...object, ...Object.fromEntries(fields) };
    }
    body = object === undefined ? undefined : JSON.stringify(object);
  }
  if (entry.bodyRequired && body === undefined) throw usageError(`${usageOf(entry)} needs a body: ${BODY}.`);
  if (values.timeout !== undefined && !values.wait) throw usageError("--timeout goes with --wait.");
  const timeout = timeoutOf(values.timeout);
  const search = query.size ? `?${query}` : "";
  const client = clientOf(targetOf(values, env), io);
  if (values.follow) return followTimeline(client, `${path}${search}`);
  if (!values.wait) return sendAndPrint(client, entry.method, `${path}${search}`, body, entry.bodyType);
  const started = await send(client, entry.method, `${path}${search}`, body, entry.bodyType);
  return started.code ?? waitRun(client, started.value.run_id, timeout);
}

async function run(argv, env, io) {
  const [noun, verb] = words(argv);
  if (noun === undefined || noun === "help") return io.stdout.write(`${HELP()}\n`), 0;
  if (noun === "api") return api(argv, env, io);
  if (noun === WAIT.command[0] && verb === WAIT.command[1]) return wait(argv, env, io);
  const entries = COMMANDS.filter((entry) => entry.command[0] === noun);
  if (!entries.length) throw usageError(`agentrun has no command ${noun}.\n\n${HELP()}`);
  const entry = entries.find((e) => e.command.length === 1 || e.command[1] === verb);
  if (entry) return command(entry, argv, env, io);
  const listed = noun === WAIT.command[0] ? [...entries, WAIT] : entries;
  if (verb === undefined) return io.stdout.write(`${nounHelp(noun, listed)}\n`), 0;
  throw usageError(`agentrun ${noun} has no verb ${verb}.\n\n${nounHelp(noun, listed)}`);
}

export async function main(argv, env = process.env, io = process) {
  try {
    return await run(argv, env, io);
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    io.stderr.write(`${error.message}\n`);
    return error.code;
  }
}
