#!/usr/bin/env node
// agentrun-serve: the Agentrun v2 API on this machine, over the agent store in a data directory.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PORT, type Serve, startServe } from "./server.js";

const USAGE = `usage: agentrun-serve [--data DIR] [--listen ADDR] [--port N] [--faux MODULE] [--allow-host NAME ...]

  --data DIR        the agent store and its runs (default ~/.local/share/agentrun/agents); the token is DIR/.token, mode 0600
  --listen ADDR     the address to listen on (default 127.0.0.1); on any other, every Host name is served and the token
                    is the only lock, so put TLS in front of it
  --port N          the port (default ${DEFAULT_PORT}; 0 is any free port)
  --faux MODULE     answer every model request from MODULE's default export: no key, no network
  --allow-host NAME another Host name to accept (repeatable)

Without --faux, a revision's model ("provider/model-id", or AGENT_MODEL when it names none; a workflow node's tier maps
to AGENT_MODEL_FAST or AGENT_MODEL_STRONG, each falling back to AGENT_MODEL) is served by pi-ai's providers with their
keys from the environment, or, with AGENT_MODEL_BASE_URL, by that one OpenAI Responses gateway (AGENT_MODEL_API_KEY when
it needs a key). AGENTRUN_TOKEN, when set, is the token in place of DIR/.token's, and is never printed. AGENTRUN_PUBLIC_URL,
when set, is the address people open (a container's published port, or a proxy's URL), and the link printed uses it.`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      data: { type: "string" },
      listen: { type: "string" },
      port: { type: "string" },
      faux: { type: "string" },
      "allow-host": { type: "string", multiple: true, default: [] },
      help: { type: "boolean", short: "h", default: false },
    },
  }));
} catch (error) {
  console.error(`${(error as Error).message}\n\n${USAGE}`);
  process.exit(2);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`--port takes a port number\n\n${USAGE}`);
  process.exit(2);
}
let publicUrl: string | undefined;
if (process.env.AGENTRUN_PUBLIC_URL) {
  const parsed = URL.canParse(process.env.AGENTRUN_PUBLIC_URL) ? new URL(process.env.AGENTRUN_PUBLIC_URL) : undefined;
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    console.error(`AGENTRUN_PUBLIC_URL takes an http(s) URL\n\n${USAGE}`);
    process.exit(2);
  }
  publicUrl = parsed.href.replace(/\/+$/, "");
}
const data = values.data ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "agentrun", "agents");
const given = process.env.AGENTRUN_TOKEN || undefined;
let serve: Serve;
try {
  serve = await startServe({ data, port, ...(values.listen ? { host: values.listen } : {}), ...(given ? { token: given } : {}), ...(values.faux ? { faux: values.faux } : {}), allowHosts: values["allow-host"] });
} catch (error) {
  console.error(`agentrun-serve: ${(error as Error).message}`);
  process.exit(1);
}
// A token from the environment is the operator's already, and is kept out of the logs.
const shown = given ? "$AGENTRUN_TOKEN" : serve.token;
console.log(`agentrun-serve on ${serve.baseUrl} (agent store in ${data}${values.listen ? `, listening on ${values.listen}` : ""})`);
console.log(`AGENTRUN_BASE_URL=${publicUrl ? `${publicUrl}/v2` : serve.baseUrl}`);
console.log(`AGENTRUN_API_KEY=${shown}`);
console.log(`Open ${publicUrl ?? serve.url}/?token=${shown}`);
const stop = () => void serve.close().then(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
