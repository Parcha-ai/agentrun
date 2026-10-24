#!/usr/bin/env node
// agentrun-serve: the Agentrun v2 API on this machine, over the agent store in a data directory.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PORT, startServe } from "./server.js";

const USAGE = `usage: agentrun-serve [--data DIR] [--port N] [--faux MODULE] [--allow-host NAME ...]

  --data DIR        the agent store and its runs (default ~/.local/share/agentrun/agents); the token is DIR/.token, mode 0600
  --port N          the port on 127.0.0.1 (default ${DEFAULT_PORT}; 0 is any free port)
  --faux MODULE     answer every model request from MODULE's default export: no key, no network
  --allow-host NAME another Host name to accept (repeatable)

Without --faux, a revision's model ("provider/model-id", or AGENT_MODEL when it names none; a workflow node's tier maps
to AGENT_MODEL_FAST or AGENT_MODEL_STRONG, each falling back to AGENT_MODEL) is served by pi-ai's providers with their
keys from the environment, or, with AGENT_MODEL_BASE_URL, by that one OpenAI Responses gateway (AGENT_MODEL_API_KEY when
it needs a key).`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      data: { type: "string" },
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
const data = values.data ?? join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "agentrun", "agents");
const serve = await startServe({ data, port, ...(values.faux ? { faux: values.faux } : {}), allowHosts: values["allow-host"] });
console.log(`agentrun-serve on ${serve.baseUrl} (agent store in ${data})`);
console.log(`AGENTRUN_BASE_URL=${serve.baseUrl}`);
console.log(`AGENTRUN_API_KEY=${serve.token}`);
const stop = () => void serve.close().then(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
