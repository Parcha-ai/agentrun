// `npx @parcha/agentrun agents list`: the server's API from the terminal. Every command is an operation of the server's
// OpenAPI document, read from the generated table (commands.generated.mjs); nothing here is written per command. Waiting for
// a run and following it live (runs start --wait, runs wait, runs timeline --follow) are follow.mjs's; the commands that
// read a secret from stdin (login, logout, tool-keys set) are login.mjs's, and skill install is skill.mjs's.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { COMMANDS } from "./commands.generated.mjs";
import { FLAGS, WAIT, followTimeline, waitRun } from "./follow.mjs";
import { SECRETS, guarded } from "./login.mjs";
import { SKILL_INSTALL } from "./skill.mjs";

/** The hand-written commands that run as they are given (`run`), beside the table's. */
const LOCAL = [...SECRETS, SKILL_INSTALL];
export const NOUNS = new Set(["api", "help", ...[...COMMANDS, ...LOCAL].map((entry) => entry.command[0])]);
const DEFAULT_BASE_URL = "http://127.0.0.1:7340/v2"; // key-gate: loopback-rule the default address of the server started on this machine
const START = "start it with `npx @parcha/agentrun`, or pass --base-url (or set AGENTRUN_BASE_URL) to the address the server printed";
const GLOBAL = { "base-url": { type: "string" }, data: { type: "string" }, help: { type: "boolean", short: "h" } };
const BODY = "--body JSON|@FILE|-";
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/;
// A header value fetch takes: no line break or other control character, nothing outside Latin-1.
const BAD_HEADER = /[\0-\x08\x0a-\x1f\x7f]|[^\0-\xff]/;

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const usageError = (message) => new Exit(2, message);
const flag = (name) => name.replace(/_/g, "-").toLowerCase();

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
  for (const { command, summary } of [...COMMANDS, WAIT, ...LOCAL]) groups.set(command[0], command.length === 1 ? [summary] : [...(groups.get(command[0]) ?? []), command[1]].sort());
  const width = Math.max(...[...groups.keys()].map((noun) => noun.length));
  return [
    "Usage: npx @parcha/agentrun <command> [args] [--base-url URL] [--data DIR]",
    "",
    "Commands (agentrun <command> --help for a command's arguments):",
    ...[...groups].map(([noun, verbs]) => `  ${noun.padEnd(width)}  ${verbs.join(", ")}`),
    `  ${"api".padEnd(width)}  METHOD PATH [${BODY}] [--header 'NAME: VALUE'], any route, PATH under the base URL (/agents)`,
    "",
    "The server: --base-url, else AGENTRUN_BASE_URL, else base_url in $XDG_CONFIG_HOME/agentrun/config.json, else the",
    "server started on this machine with the data directory (--data, default ~/.agentrun). The token: AGENTRUN_API_KEY,",
    "else api_key in the config file, else that server's own; it is never a flag and never printed. agentrun login",
    "--base-url URL checks a token read from stdin and writes the config file (0600); agentrun logout removes it.",
    "Output: the response's JSON on stdout, a file's bytes as they are; an error's on stderr. Exit codes: 0 ok, 1 the",
    "server refused, 2 bad usage, 3 the server cannot be reached, 4 no token or the token was refused. runs wait and runs",
    "start --wait print the run once it ends or waits on a person: 0 completed, 1 failed, cancelled or --timeout passed",
    "(it goes on), 8 it waits on a person (a question, its spend cap, a stopped turn, a paused workflow). runs timeline",
    "--follow prints the timeline's pages as they come, one JSON object per line, until the run ends: 0 completed, 1",
    "failed or cancelled.",
  ].join("\n");
};

const usageOf = (entry) => `agentrun ${entry.command.join(" ")}${entry.pathParams.map((name) => ` ${name.toUpperCase()}`).join("")}`;
const helpOf = (entry, flags) => {
  const width = Math.max(0, ...flags.map(([name]) => name.length));
  return [`Usage: ${usageOf(entry)}${flags.length ? " [flags]" : ""}`, "", `${entry.summary}${entry.method ? ` (${entry.method} ${entry.path})` : ""}`, ...(flags.length ? ["", ...flags.map(([name, text]) => `  ${name.padEnd(width)}  ${text}`.trimEnd())] : [])].join("\n");
};
const defaultType = (types) => (types.includes("application/json") ? "application/json" : types.includes("*/*") ? "application/octet-stream" : types[0]);

function commandHelp(entry) {
  const flags = [...entry.query, ...entry.headers, ...entry.bodyFlags].map((f) => {
    const value = f.type === "boolean" ? "" : ` ${f.enum ? f.enum.join("|") : f.type.toUpperCase()}`;
    return [`--${flag(f.name)}${value}`, `${f.required ? "(required) " : ""}${f.description}`];
  });
  if (entry.hasBody) {
    flags.push([BODY, entry.secretBody ? "the body, from stdin or a file only: it holds a secret" : "the body, inline, from a file or from stdin; flags win over a JSON body's fields"]);
    flags.push(["--body-type TYPE", `the body's type: ${entry.bodyTypes.join(", ")} (default ${defaultType(entry.bodyTypes)}); any other than JSON is sent as given`]);
  }
  const help = helpOf(entry, [...flags, ...(FLAGS[entry.operationId]?.help ?? [])]);
  // The document's working body, ready to paste: single-quoted for a POSIX shell.
  return entry.example === undefined ? help : `${help}\n\nExample:\n  ${usageOf(entry)} --body '${JSON.stringify(entry.example).replace(/'/g, "'\\''")}'`;
}

const nounHelp = (noun, entries) => [`Usage: agentrun ${noun} <verb> [args]`, "", ...entries.map((entry) => `  ${usageOf(entry).padEnd(40)}  ${entry.summary}`)].join("\n");

/** `file`'s JSON, or undefined when there is none. Never its text in a message: it may hold a key. */
function readJson(file, text) {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw usageError(`${file} is not valid JSON.`);
  }
}

/** `file`'s text when it is a regular file of this user's that no one else may read or write, through no link; undefined
 *  when there is none. A file that fails that is refused: another user could have written it. */
function privateFile(file) {
  let fd;
  try {
    // O_NONBLOCK: a FIFO planted there opens at once, and fstat refuses it, rather than the open waiting for a writer.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Exit(4, `${file} ${error.code === "ELOOP" ? "is a link" : `cannot be read (${error.code})`}; refusing it.`);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
      throw new Exit(4, `${file} is not a private file of yours (a regular file you own, mode 0600); refusing it.`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

const alive = (pid) => {
  try {
    return process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
};

const trim = (url) => url.replace(/\/+$/, "");

/** A base URL as every command takes it: http or https, with no query, fragment, user or password, which would carry
 *  the token elsewhere or swallow the path appended to it. `where` names it in the refusal; the URL itself is never
 *  echoed, as it may hold a password. */
function baseOf(given, where) {
  const url = URL.canParse(given) ? new URL(given) : undefined;
  if (!url || !/^https?:$/.test(url.protocol) || /[?#]/.test(given) || url.username || url.password) {
    throw usageError(`${where} must be an http or https URL with no query, fragment, user or password: the API's base, ending /v2.`);
  }
  return trim(given);
}

/** Where the request goes and the token it carries. A token goes only with the address it came with: the local
 *  server's own token is never sent to another server. The local token is DIR/.token, whatever the record says. */
function targetOf(values, env) {
  const data = resolve(values.data ?? join(homedir(), ".agentrun"));
  const configFile = join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentrun", "config.json");
  const config = readJson(configFile, privateFile(configFile)) ?? {};
  if (["base_url", "api_key"].some((field) => config[field] !== undefined && typeof config[field] !== "string")) {
    throw new Exit(4, `${configFile} is not a CLI config (base_url and api_key, when there, are strings); refusing it.`);
  }
  const recordFile = join(data, ".server.json");
  const record = readJson(recordFile, privateFile(recordFile));
  if (record !== undefined && (typeof record?.base_url !== "string" || !Number.isInteger(record.pid) || record.pid <= 0)) {
    throw new Exit(4, `${recordFile} is not a server record (base_url a string, pid a positive whole number); refusing it.`);
  }
  const stale = record && `The server recorded in ${recordFile} (pid ${record.pid}) is not running; start it with \`npx @parcha/agentrun\` or set AGENTRUN_BASE_URL.`;
  const local = baseOf(record?.base_url ?? DEFAULT_BASE_URL, `base_url in ${recordFile}`);
  const base = values["base-url"] !== undefined ? baseOf(values["base-url"], "--base-url")
    : env.AGENTRUN_BASE_URL !== undefined ? baseOf(env.AGENTRUN_BASE_URL, "AGENTRUN_BASE_URL")
    : config.base_url !== undefined ? baseOf(config.base_url, `base_url in ${configFile}`)
    : local;
  let token = env.AGENTRUN_API_KEY || (config.base_url && base === trim(config.base_url) ? config.api_key : undefined);
  const isLocal = base === local;
  if (isLocal && record && !alive(record.pid)) throw new Exit(3, stale);
  if (!token && isLocal) {
    if (record && !record.token_file) throw new Exit(4, `The server recorded in ${recordFile} was started with its token in AGENTRUN_TOKEN; set AGENTRUN_API_KEY to it.`);
    token = privateFile(join(data, ".token"))?.trim();
  }
  if (!token) {
    throw new Exit(4, isLocal
      ? `No token: AGENTRUN_API_KEY is not set and ${join(data, ".token")} does not exist; ${START}.`
      : `No token for ${base}: set AGENTRUN_API_KEY.`);
  }
  if (BAD_HEADER.test(token)) throw new Exit(4, "The API key is not a valid header value (it holds a line break, a control character or a character outside Latin-1).");
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
      throw usageError(`--body ${value}: ${error.code === "ENOENT" ? "no such file" : `cannot be read (${error.code})`}`);
    }
  }
  return Buffer.from(value);
}

/** The JSON in `bytes`, as `{ value }`, or undefined when they hold none. */
function jsonOf(bytes) {
  try {
    return { value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    return undefined;
  }
}

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

/** The operation whose body carries a secret that `method` on `url` reaches, once its path is normalized as fetch
 *  normalizes it (`..`, `.`, their encoded forms, repeated slashes): the operation's route at the end of the path,
 *  whatever part of it the base URL holds. */
function secretAt(method, url) {
  const pathname = new URL(url).pathname.replace(/\/{2,}/g, "/");
  const route = (entry) => new RegExp(`(?:^|/)${entry.path.slice(1).split(/\{[^}]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]+")}/?$`);
  return COMMANDS.find((entry) => entry.secretBody && entry.method === method && route(entry).test(pathname));
}

/** Requests to the target, each with its token (follow.mjs makes its own through one): `fetch(path, init)`, exit 3 for
 *  a server not reached, a refused answer's body on stderr with its exit code, and JSON on stdout. */
function clientOf(target, io) {
  return {
    io,
    fetch: (path, { method = "GET", headers = {}, body, signal } = {}) => fetch(`${target.base}${path}`, { method, signal, headers: { accept: "application/json, */*", ...headers, authorization: `Bearer ${target.token}` }, ...(body !== undefined ? { body } : {}) }),
    // Only the cause's code: a fetch error's message can quote a header, the token's among them.
    unreachable: (error) => new Exit(3, target.unreachable ?? `Cannot reach the server at ${target.base} (${error?.cause?.code ?? error?.name}); ${START}.`),
    refused(response, bytes) {
      io.stderr.write(bytes.length ? bytes : `${response.status} ${response.statusText}`);
      if (!bytes.length || bytes.at(-1) !== 10) io.stderr.write("\n");
      return response.status === 401 || response.status === 403 ? 4 : 1;
    },
    print: (value) => io.stdout.write(`${io.stdout.isTTY ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`),
  };
}

/** One request: `{ response, bytes }`, or `{ code }` once it was refused (its error on stderr). */
async function request(client, { method, path, headers, body, type }) {
  try {
    const response = await client.fetch(path, { method, headers: { ...headers, accept: "application/json, */*", ...(body !== undefined ? { "content-type": type } : {}) }, body });
    const bytes = Buffer.from(await response.arrayBuffer());
    return response.ok ? { response, bytes } : { code: client.refused(response, bytes) };
  } catch (error) {
    throw client.unreachable(error);
  }
}

/** One request, its answer on stdout; the exit code. */
async function send(client, req) {
  const { response, bytes, code } = await request(client, req);
  if (code !== undefined) return code;
  const { io } = client;
  if (response.status === 204 || bytes.length === 0) return 0;
  const json = !req.raw && JSON_TYPE.test(response.headers.get("content-type") ?? "") ? jsonOf(bytes) : undefined;
  // A request that carried a secret (login.mjs): its copies cut from a JSON answer's values, or else from the text.
  if (client.scrub) return json ? client.print(client.scrub.value(json.value)) : io.stdout.write(client.scrub.text(bytes.toString("utf8"))), 0;
  if (json && io.stdout.isTTY) io.stdout.write(`${JSON.stringify(json.value, null, 2)}\n`);
  else if (json) io.stdout.write(bytes.at(-1) === 10 ? bytes : Buffer.concat([bytes, Buffer.from("\n")]));
  else io.stdout.write(bytes);
  return 0;
}

/** `--timeout SECONDS` in milliseconds. */
function timeoutOf(value) {
  if (value === undefined) return undefined;
  const seconds = coerce({ name: "timeout", type: "number" }, value);
  if (seconds <= 0) throw usageError(`--timeout takes a number of seconds above 0, not ${value}`);
  return seconds * 1000;
}

/** A run id goes whole into one path segment (encoded); one that fetch would read as no segment or a step up is none. */
const runIdOk = (id) => typeof id === "string" && !["", ".", ".."].includes(id);

/** `runs wait RUN_ID [--timeout SECONDS]`. */
async function wait(argv, env, io) {
  const { values, positionals } = parse(argv, { ...GLOBAL, timeout: { type: "string" } });
  if (values.help) return io.stdout.write(`${helpOf(WAIT, WAIT.help)}\n`), 0;
  const args = positionals.slice(WAIT.command.length);
  if (args.length !== 1) throw usageError(`${helpOf(WAIT, WAIT.help)}\n\n${usageOf(WAIT)} takes 1 argument, given ${args.length}.`);
  if (!runIdOk(args[0])) throw usageError(`${usageOf(WAIT)}: RUN_ID may not be empty, . or ..`);
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

const checkHeader = (name, value) => {
  if (BAD_HEADER.test(value)) throw usageError(`The value of ${name} is not a valid header value.`);
};

async function api(argv, env, io) {
  const { values, positionals } = parse(argv, { ...GLOBAL, body: { type: "string" }, header: { type: "string", multiple: true } });
  const [, method, path] = positionals;
  if (values.help || method === undefined) return io.stdout.write(`Usage: agentrun api METHOD PATH [${BODY}] [--header 'NAME: VALUE']...\n\nAny route of the server; PATH is under the base URL (/agents, /runs/RUN_ID).\n`), values.help ? 0 : 2;
  if (path === undefined || !path.startsWith("/") || positionals.length > 3) throw usageError("Usage: agentrun api METHOD PATH [--body JSON|@FILE|-]; PATH starts with /");
  // fetch resolves `.` and `..` (and their encoded forms) against the base URL's own path, which may be longer than /v2.
  const segments = path.split(/[?#]/)[0].split("/").slice(1).map((segment) => segment.replace(/%2e/gi, "."));
  if (segments.some((segment, i) => segment === "." || segment === ".." || (segment === "" && i < segments.length - 1))) throw usageError("agentrun api: PATH may not hold a . or .. segment or an empty one (//).");
  const verb = method.toUpperCase();
  const secret = secretAt(verb, `http://host/v2${path}`);
  if (secret) refuseInline(`${verb} ${secret.path}`, values.body);
  const headers = {};
  for (const line of values.header ?? []) {
    const at = line.indexOf(":");
    const name = line.slice(0, at).trim();
    if (at <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw usageError("--header takes 'NAME: VALUE'.");
    if (["authorization", "cookie"].includes(name.toLowerCase())) throw usageError(`--header cannot set ${name}: the token is never a flag.`);
    checkHeader(name, line.slice(at + 1).trim());
    headers[name.toLowerCase()] = line.slice(at + 1).trim();
  }
  const body = values.body === undefined ? undefined : await readBody(values.body, io.stdin);
  const type = headers["content-type"] ?? (body !== undefined && jsonOf(body) ? "application/json" : "application/octet-stream");
  const target = targetOf(values, env);
  // The base URL's own path counts too: --base-url .../v2/settings with PUT /tool-keys/exa reaches the secret route.
  const landed = secretAt(verb, `${target.base}${path}`);
  if (landed) refuseInline(`${verb} ${landed.path}`, values.body);
  // A body bound for a secret route: an error's answer is never printed, and the body's values are cut from the rest.
  const route = secret || landed;
  const client = route ? guarded(clientOf, target, io, body, route.publicFields) : clientOf(target, io);
  return send(client, { method: verb, path, headers, body, type });
}

async function command(entry, argv, env, io) {
  const options = { ...GLOBAL };
  for (const f of [...entry.query, ...entry.headers, ...entry.bodyFlags]) options[flag(f.name)] = { type: f.type === "boolean" ? "boolean" : "string" };
  if (entry.hasBody) Object.assign(options, { body: { type: "string" }, "body-type": { type: "string" } });
  Object.assign(options, FLAGS[entry.operationId]?.options);
  const { values, positionals } = parse(argv, options);
  if (values.help) return io.stdout.write(`${commandHelp(entry)}\n`), 0;
  const args = positionals.slice(entry.command.length);
  if (args.length !== entry.pathParams.length) throw usageError(`${commandHelp(entry)}\n\n${usageOf(entry)} takes ${entry.pathParams.length || "no"} argument${entry.pathParams.length === 1 ? "" : "s"}, given ${args.length}.`);
  // A `.` or `..` segment would take the request to another route once fetch normalizes the path.
  if (args.some((arg) => arg.split("/").some((segment) => segment === "." || segment === ".."))) throw usageError(`${usageOf(entry)}: an argument may not hold a . or .. path segment.`);
  const path = entry.path.replace(/\{([^}]+)\}/g, (_, name) => {
    const value = args[entry.pathParams.indexOf(name)];
    if (!entry.multiSegment.includes(name)) return encodeURIComponent(value);
    // A file path keeps its slashes, so no segment may be one fetch or the server would read otherwise.
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || /%2f/i.test(segment) || [".", ".."].includes(segment.replace(/%2e/gi, ".")))) {
      throw usageError(`${usageOf(entry)}: ${name.toUpperCase()} may not hold an empty, . or .. segment (plain or encoded) or an encoded slash.`);
    }
    return segments.map(encodeURIComponent).join("/");
  });
  const query = new URLSearchParams();
  for (const q of entry.query) {
    const value = values[flag(q.name)];
    if (value !== undefined) query.set(q.name, String(coerce(q, value)));
    else if (q.required) throw usageError(`${usageOf(entry)} needs --${flag(q.name)}.`);
  }
  const headers = {};
  for (const h of entry.headers) {
    const value = values[flag(h.name)];
    if (value !== undefined) checkHeader(`--${flag(h.name)}`, (headers[h.name] = String(coerce(h, value))));
    else if (h.required) throw usageError(`${usageOf(entry)} needs --${flag(h.name)}.`);
  }
  if (entry.secretBody) refuseInline(entry.command.join(" "), values.body);
  const type = values["body-type"] ?? (entry.hasBody ? defaultType(entry.bodyTypes) : undefined);
  if (values["body-type"] !== undefined && !entry.bodyTypes.includes(type) && !entry.bodyTypes.includes("*/*")) throw usageError(`${usageOf(entry)} takes a body of type ${entry.bodyTypes.join(", ")}.`);
  let body = values.body === undefined ? undefined : await readBody(values.body, io.stdin);
  const fields = entry.bodyFlags.filter((f) => values[flag(f.name)] !== undefined).map((f) => [f.name, coerce(f, values[flag(f.name)])]);
  if (fields.length && !JSON_TYPE.test(type)) throw usageError(`--${flag(fields[0][0])} is a field of the JSON body, and this body is ${type}.`);
  if (JSON_TYPE.test(type ?? "") && body !== undefined && !jsonOf(body)) throw usageError("--body is not JSON.");
  if (fields.length) {
    const object = body === undefined ? {} : jsonOf(body).value;
    if (object === null || typeof object !== "object" || Array.isArray(object)) throw usageError("--body is not a JSON object, so it cannot take the flags' fields.");
    body = JSON.stringify({ ...object, ...Object.fromEntries(fields) });
  }
  if (entry.bodyRequired && body === undefined) throw usageError(`${usageOf(entry)} needs a body: ${BODY}.`);
  if (values.timeout !== undefined && !values.wait) throw usageError("--timeout goes with --wait.");
  const timeout = timeoutOf(values.timeout);
  const search = query.size ? `?${query}` : "";
  const target = targetOf(values, env);
  const landed = !entry.secretBody && secretAt(entry.method, `${target.base}${path}`);
  if (landed) refuseInline(`${entry.command.join(" ")} (${landed.path} under the base URL)`, values.body);
  const client = entry.secretBody || landed ? guarded(clientOf, target, io, body, (entry.secretBody ? entry : landed).publicFields) : clientOf(target, io);
  const req = { method: entry.method, path: `${path}${search}`, headers, body, type, raw: entry.raw };
  if (values.follow) return followTimeline(client, req.path, headers);
  if (!values.wait) return send(client, req);
  const started = await request(client, req);
  if (started.code !== undefined) return started.code;
  const run = jsonOf(started.bytes)?.value;
  if (!runIdOk(run?.run_id)) return io.stderr.write("The server's answer to the start names no usable run_id.\n"), 1;
  return waitRun(client, run.run_id, timeout);
}

/** A hand-written command of LOCAL: its flags and arguments checked, then its `run`, with this module's custody of the
 *  token (targetOf, BAD_HEADER), its requests (clientOf, request, send) and its secret-route guard (secretAt). */
async function local(entry, argv, env, io) {
  const { values, positionals } = parse(argv, { ...GLOBAL, ...entry.options });
  if (values.help) return io.stdout.write(`${helpOf(entry, entry.help)}\n`), 0;
  const args = positionals.slice(entry.command.length);
  const count = entry.pathParams.length;
  if (args.length !== count) throw usageError(`${helpOf(entry, entry.help)}\n\n${usageOf(entry)} takes ${count || "no"} argument${count === 1 ? "" : "s"}, given ${args.length}.`);
  const cli = { fail: (code, message) => new Exit(code, message), baseOf, targetOf, clientOf, request, send, secretAt, BAD_HEADER };
  return entry.run({ values, args, env, io, cli });
}

async function run(argv, env, io) {
  const [noun, verb] = words(argv);
  if (noun === undefined || noun === "help") return io.stdout.write(`${HELP()}\n`), 0;
  if (noun === "api") return api(argv, env, io);
  if (noun === WAIT.command[0] && verb === WAIT.command[1]) return wait(argv, env, io);
  const own = LOCAL.find((e) => e.command[0] === noun && (e.command.length === 1 || e.command[1] === verb));
  if (own) return local(own, argv, env, io);
  const entries = COMMANDS.filter((entry) => entry.command[0] === noun);
  const listed = [...entries, ...LOCAL.filter((e) => e.command[0] === noun), ...(noun === WAIT.command[0] ? [WAIT] : [])];
  if (!listed.length) throw usageError(`agentrun has no command ${noun}.\n\n${HELP()}`);
  const entry = entries.find((e) => e.command.length === 1 || e.command[1] === verb);
  if (entry) return command(entry, argv, env, io);
  if (verb === undefined) return io.stdout.write(`${nounHelp(noun, listed)}\n`), 0;
  throw usageError(`agentrun ${noun} has no verb ${verb}.\n\n${nounHelp(noun, listed)}`);
}

export async function main(argv, env = process.env, io = process) {
  // A reader that stops early (`| head`) closes stdout: the command ends quietly, as it would have. Stdout is written only
  // once a request succeeded (or for help), so that is exit 0. Any other write error still throws.
  io.stdout.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
    process.exit(0);
  });
  try {
    return await run(argv, env, io);
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    io.stderr.write(`${error.message}\n`);
    return error.code;
  }
}
