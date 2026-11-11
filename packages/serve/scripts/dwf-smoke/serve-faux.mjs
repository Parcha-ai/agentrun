// The demos' faux server: the server and a runner beside it in this process (serveWithRunner, as the CLI's start), with
// the options in argv[2] (JSON), so the decision fakes come in through the server's options (fauxJev, fauxParallel,
// fauxOpenrouter), as it takes test hooks, never from its environment. Prints the base URL as the CLI's banner does, and
// closes on SIGTERM.
import { serveWithRunner } from "../../dist/index.js";

const options = JSON.parse(process.argv[2]);
// No box unless the caller names one: unset, AGENTRUN_BOXES turns Docker on where it answers (boxes.ts).
process.env.AGENTRUN_BOXES ??= "none";
const { serve, close } = await serveWithRunner({ ...options, log: () => {} });
process.stdout.write(`AGENTRUN_BASE_URL=${serve.baseUrl}\n`);
process.once("SIGTERM", () => void close().then(() => process.exit(0)));
