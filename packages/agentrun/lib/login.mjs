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

/** `io` with every write's copy of `secret` cut out: no answer of the server may carry it back to a terminal. */
const scrubbed = (io, secret) => {
  const scrub = (stream) => ({ isTTY: stream.isTTY, write: (chunk) => stream.write(secret.length >= 6 ? String(chunk).split(secret).join("[hidden]") : chunk) });
  return { ...io, stdout: scrub(io.stdout), stderr: scrub(io.stderr) };
};

const trim = (url) => url.replace(/\/+$/, "");
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
    const given = values["base-url"] ?? env.AGENTRUN_BASE_URL;
    if (given === undefined) throw cli.fail(2, "agentrun login needs the server: --base-url URL (its API, ending /v2) or AGENTRUN_BASE_URL.");
    if (!URL.canParse(given) || !/^https?:$/.test(new URL(given).protocol)) throw cli.fail(2, `--base-url takes an http or https URL, not ${given}`);
    const base = trim(given);
    const token = (await readSecret(io, cli.fail, "The token", "agentrun login --base-url URL < FILE")).trim();
    if (!token) throw cli.fail(2, "stdin holds no token: one line, the token alone.");
    // Refused before it is sent, as every command refuses one: fetch would quote a bad header value in its error.
    if (cli.BAD_HEADER.test(token) || /\s/.test(token)) throw cli.fail(4, "The token is not a valid header value (it holds a space, a line break, a control character or a character outside Latin-1); nothing was written.");
    const checked = await cli.request(cli.clientOf({ base, token }, scrubbed(io, token)), { method: "GET", path: "/agents?limit=1", headers: {} });
    if (checked.code !== undefined) {
      io.stderr.write(`${checked.code === 4 ? `The server at ${base} refused the token` : `The server at ${base} did not take the check`}; nothing was written.\n`);
      return checked.code;
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
    return cli.send(cli.clientOf(target, scrubbed(io, value)), { method: "PUT", path, headers: {}, body: JSON.stringify({ values: { [field]: value } }), type: "application/json" });
  },
};

export const SECRETS = [LOGIN, LOGOUT, TOOL_KEY_SET];
