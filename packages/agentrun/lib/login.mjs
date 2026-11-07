// The commands that take a secret, from stdin and never from the command line: `login` (the token for a server, checked
// and kept in the config file), `logout`, and `tool-keys set` (one field of a tool key). A secret is never in argv, so
// never in shell history or `ps`, and never in any output or error. Each command is `{ command, pathParams, summary,
// route?, help, options, run }`; cli.mjs runs it with `{ values, args, env, io, cli }`, where `cli` is its own
// `{ fail, targetOf, clientOf, request, send, secretAt, BAD_HEADER }`: the token's custody and the requests are its.
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The config file `login` writes and every command reads (cli.mjs's targetOf, which refuses it unless it is a private
 *  file of this user's): $XDG_CONFIG_HOME/agentrun/config.json, else
 *  ~/.config/agentrun/config.json. */
export const configFileOf = (env) => join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "agentrun", "config.json");

/** Everything on stdin, refused when stdin is a terminal: what is typed there is shown on it. */
async function readSecret(io, fail, what, how) {
  if (io.stdin.isTTY) throw fail(2, `${what} is read from stdin, never typed on a terminal or given as an argument: ${how}.`);
  const chunks = [];
  for await (const chunk of io.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
}

/** The forms a server could quote a secret in: as it is, JSON-escaped and URL-encoded. */
const formsOf = (secret) => [...new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])].sort((a, b) => b.length - a.length);

/** What cuts every copy of each secret, in any of its forms and at any length: `text(string)` from a text, and
 *  `value(json)` from a JSON value's strings and keys only, so the value printed again is still JSON, its structure and
 *  every other value as they were. Two keys the cut makes one are kept apart. */
function scrubberOf(secrets) {
  const forms = [...new Set(secrets.filter(Boolean).flatMap(formsOf))].sort((a, b) => b.length - a.length);
  const text = (string) => forms.reduce((at, form) => at.split(form).join("[hidden]"), string);
  const value = (node) => {
    if (typeof node === "string") return text(node);
    if (Array.isArray(node)) return node.map(value);
    if (node === null || typeof node !== "object") return node;
    // No prototype, so every key is the object's own, __proto__ and constructor as much as any; JSON.stringify prints
    // it as it would a plain object.
    const out = Object.create(null);
    for (const [key, child] of Object.entries(node)) {
      let name = text(key);
      for (let n = 2; Object.hasOwn(out, name); n++) name = `${text(key)} (${n})`;
      out[name] = value(child);
    }
    return out;
  };
  return { text, value };
}

/** `io` with the secrets cut from what goes to stderr, which carries only this CLI's own lines. */
const quietStderr = (io, scrub) => ({ ...io, stderr: { isTTY: io.stderr.isTTY, write: (chunk) => io.stderr.write(scrub.text(String(chunk))) } });

/** The string values of a secret route's JSON body, but for its public fields (`publicFields`, full paths such as
 *  `auth.type`, or `scopes.[]` for each item of a list, from the table), or the whole body when it is not JSON: the secrets to cut from what is printed. A value
 *  under a map (a header's, a tool key field's) is never public, whatever its key. */
function secretsOf(body, publicFields = []) {
  const text = body === undefined ? "" : String(body);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return [text];
  }
  const open = new Set(publicFields.map((field) => JSON.stringify(field.split("."))));
  const found = [];
  const walk = (node, path) => {
    if (typeof node === "string") return void (open.has(JSON.stringify(path)) || found.push(node));
    if (node && typeof node === "object") for (const [key, child] of Object.entries(node)) walk(child, Array.isArray(node) ? [...path, "[]"] : [...path, key]);
  };
  walk(value, []);
  return found;
}

/** A client for a request that carries a secret: a refusal prints the status, the error's code when it is one, and a
 *  message of this CLI's own, never the server's answer, which could quote the secret. What it does print has every
 *  copy of `secrets` cut: `scrub`, which cli.mjs's send applies to a JSON answer's value before it prints it, and to a
 *  text answer's text. */
function secretClient(clientOf, target, io, secrets) {
  const scrub = scrubberOf(secrets);
  const client = clientOf(target, quietStderr(io, scrub));
  return {
    ...client,
    scrub,
    refused(response, bytes) {
      let code;
      try {
        code = JSON.parse(bytes.toString("utf8"))?.error?.code;
      } catch {
        code = undefined;
      }
      const named = typeof code === "string" && /^[a-z_]+$/.test(code) ? ` ${code}` : "";
      client.io.stderr.write(`The server refused it: ${response.status}${named}. Its answer is not shown, since it could quote the secret sent.\n`);
      return response.status === 401 || response.status === 403 ? 4 : 1;
    },
  };
}

/** cli.mjs's client for a generated command or an `api` call whose body goes to a secret route, with that route's
 *  public fields. */
export const guarded = (clientOf, target, io, body, publicFields) => secretClient(clientOf, target, io, secretsOf(body, publicFields));

const print = (io, value) => io.stdout.write(`${io.stdout.isTTY ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`);

export const LOGIN = {
  command: ["login"],
  pathParams: [],
  summary: "Check a server's token, read from stdin, and keep it with the server's address in the config file",
  route: "GET /agents?limit=1, to check the token",
  help: [
    ["--base-url URL", "the server's API, ending /v2 (default AGENTRUN_BASE_URL)"],
    ["(stdin)", "the token: agentrun login --base-url URL < FILE"],
  ],
  options: {},
  async run({ values, env, io, cli }) {
    const flagged = values["base-url"] !== undefined;
    const given = flagged ? values["base-url"] : env.AGENTRUN_BASE_URL;
    if (given === undefined) throw cli.fail(2, "agentrun login needs the server: --base-url URL (its API, ending /v2) or AGENTRUN_BASE_URL.");
    const base = cli.baseOf(given, flagged ? "--base-url" : "AGENTRUN_BASE_URL");
    const token = (await readSecret(io, cli.fail, "The token", "agentrun login --base-url URL < FILE")).trim();
    if (!token) throw cli.fail(2, "stdin holds no token: one line, the token alone.");
    // Refused before it is sent, as every command refuses one: fetch would quote a bad header value in its error.
    if (cli.BAD_HEADER.test(token) || /\s/.test(token)) throw cli.fail(4, "The token is not a valid header value (it holds a space, a line break, a control character or a character outside Latin-1); nothing was written.");
    const client = secretClient(cli.clientOf, { base, token }, io, [token]);
    const checked = await cli.request(client, { method: "GET", path: "/agents?limit=1", headers: {} });
    if (checked.code !== undefined) {
      client.io.stderr.write(`${checked.code === 4 ? `The server at ${base} refused the token` : `The server at ${base} did not take the check`}; nothing was written.\n`);
      return checked.code;
    }
    // A 200 from another route or another server would save a token nothing checked: the answer must be the agents list.
    let list;
    try {
      list = JSON.parse(checked.bytes.toString("utf8"));
    } catch {
      list = undefined;
    }
    if (!Array.isArray(list?.agents) || !("next_cursor" in list)) {
      client.io.stderr.write(`The server at ${base} answered the check with ${checked.response.status}, not an agents list; nothing was written.\n`);
      return 1;
    }
    const file = configFileOf(env);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(file), 0o700);
    // Written whole beside it, then moved over it: a reader never sees half a file, and it is never wider than 0600.
    const temp = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ base_url: base, api_key: token }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, file);
    } finally {
      rmSync(temp, { force: true });
    }
    print(io, { base_url: base, config_file: file });
    return 0;
  },
};

export const LOGOUT = {
  command: ["logout"],
  pathParams: [],
  summary: "Remove the config file login wrote, its address and token",
  help: [],
  options: {},
  async run({ env, io }) {
    const file = configFileOf(env);
    const removed = existsSync(file);
    rmSync(file, { force: true });
    print(io, { config_file: file, removed });
    return 0;
  },
};

export const TOOL_KEY_SET = {
  command: ["tool-keys", "set"],
  pathParams: ["key_id", "field"],
  summary: "Save one field of a tool key, its value read from stdin or an environment variable",
  route: "PUT /settings/tool-keys/{key_id}",
  help: [
    ["--from-env VAR", "the value is the environment variable VAR's, not stdin's"],
    ["(stdin)", "the value: printf %s \"$VALUE\" | agentrun tool-keys set KEY_ID FIELD"],
  ],
  options: { "from-env": { type: "string" } },
  async run({ values, args: [keyId, field], env, io, cli }) {
    const from = values["from-env"];
    if (from !== undefined && !env[from]) throw cli.fail(2, `--from-env ${from}: the environment has no ${from}.`);
    const value = from !== undefined ? env[from] : await readSecret(io, cli.fail, "The value", `pipe it in, or name the variable that holds it with --from-env VAR`);
    if (!value) throw cli.fail(2, "stdin holds no value.");
    // KEY_ID goes whole into one path segment: one fetch would read as no segment or a step up is none.
    if (["", ".", ".."].includes(keyId)) throw cli.fail(2, "agentrun tool-keys set: KEY_ID may not be empty, . or ..");
    const path = `/settings/tool-keys/${encodeURIComponent(keyId)}`;
    const target = cli.targetOf(values, env);
    // Where it lands, the base URL's own path counted: the tool key route, or nothing is sent.
    if (cli.secretAt("PUT", `${target.base}${path}`)?.operationId !== "saveToolKey") throw cli.fail(2, `agentrun tool-keys set: PUT ${path} under ${target.base} is not the tool key route; nothing was sent.`);
    return cli.send(secretClient(cli.clientOf, target, io, [value]), { method: "PUT", path, headers: {}, body: JSON.stringify({ values: { [field]: value } }), type: "application/json" });
  },
};

export const SECRETS = [LOGIN, LOGOUT, TOOL_KEY_SET];
