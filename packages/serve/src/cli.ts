#!/usr/bin/env node
// agentrun-serve: the Agentrun v2 API on this machine, over the agent homes in a data directory.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_PORT, startServe } from "./server.js";

const USAGE = `usage: agentrun-serve [--data DIR] [--port N] [--faux MODULE] [--allow-host NAME ...] [--verbose]

  --data DIR        the agent homes (default ~/.local/share/agentrun/agents); the token is DIR/.token, mode 0600
  --port N          the port on 127.0.0.1 (default ${DEFAULT_PORT}; 0 is any free port)
  --faux MODULE     answer every model request from MODULE's default export: no key, no network
  --allow-host NAME another Host name to accept (repeatable)
  --verbose         forward each run's process stderr

Without --faux, a run's model is the OpenAI Responses endpoint in AGENT_MODEL_BASE_URL and AGENT_MODEL
(AGENT_MODEL_API_KEY when it needs a key).`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      data: { type: "string" },
      port: { type: "string" },
      faux: { type: "string" },
      "allow-host": { type: "string", multiple: true, default: [] },
      verbose: { type: "boolean", default: false },
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
const serve = await startServe({ data, port, ...(values.faux ? { faux: values.faux } : {}), allowHosts: values["allow-host"], verbose: values.verbose });
console.log(`agentrun-serve on ${serve.baseUrl} (agent homes in ${data})`);
console.log(`AGENTRUN_BASE_URL=${serve.baseUrl}`);
console.log(`AGENTRUN_API_KEY=${serve.token}`);
const stop = () => void serve.close().then(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
