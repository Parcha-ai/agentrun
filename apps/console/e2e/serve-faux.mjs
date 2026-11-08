#!/usr/bin/env node
// The built server started for a flow that needs the serve tests' fakes a person's CLI has no switch for (the browser
// tool's fake backend: `fauxBrowser`). It starts the checkout's own startServe (packages/serve/dist/server.js) in its own
// process, as the CLI does, with accounts on and open setup, on loopback, and prints the lines the harness reads from
// the CLI: "agentrun-serve on <base URL>" and "AGENTRUN_API_KEY=<token>". A SIGTERM closes it.
//   node apps/console/e2e/serve-faux.mjs <checkout> <options as JSON>
// The options are startServe's own (data, faux, fauxBrowser, …); their paths are the harness's, already absolute.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LOOPBACK } from "./harness.mjs";

const [checkout, json] = process.argv.slice(2);
const { startServe } = await import(pathToFileURL(join(checkout, "packages/serve/dist/server.js")).href);
const serve = await startServe({ ...JSON.parse(json), host: LOOPBACK, accounts: true, openSetup: true, log: (line) => void process.stdout.write(`${line}\n`) });
console.log(`agentrun-serve on ${serve.baseUrl} (started by the e2e harness, with the serve tests' fakes)`);
console.log(`AGENTRUN_API_KEY=${serve.token}`);
let closing = false;
process.on("SIGTERM", () => {
  if (closing) return;
  closing = true;
  serve.close().then(() => process.exit(0), () => process.exit(1));
});
