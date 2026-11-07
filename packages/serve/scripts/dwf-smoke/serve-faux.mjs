// The smokes' server: startServe in this process with the options in argv[2] (JSON), so the decision fakes come in
// through startServe's options (fauxJev, fauxParallel, fauxOpenrouter), as the server takes test hooks, never from its
// environment. Prints the base URL as the CLI's banner does, and closes on SIGTERM.
import { startServe } from "../../dist/server.js";

const options = JSON.parse(process.argv[2]);
// No box unless the caller names one: unset, AGENTRUN_BOXES turns Docker on where it answers (boxes.ts).
process.env.AGENTRUN_BOXES ??= "none";
const serve = await startServe({ ...options, log: () => {} });
process.stdout.write(`AGENTRUN_BASE_URL=${serve.baseUrl}\n`);
process.once("SIGTERM", () => void serve.close().then(() => process.exit(0)));
