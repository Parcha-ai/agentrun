// A server in a process of its own with the tests' fake browser and Browserbase, for a test to kill the way a crash does
// while a run's browser is signed in: its runs' processes live on for the next server to adopt. argv: the data
// directory, the faux model, the fake browser and the fake Browserbase. Prints the server's address; the token is in the
// data directory.
import { startServe } from "../../dist/index.js";

const [data, faux, fauxBrowser, fauxBrowserbase] = process.argv.slice(2);
const server = await startServe({ data, port: 0, faux, fauxBrowser, fauxBrowserbase, drainTimeout: "5s" });
console.log(`AGENTRUN_BASE_URL=${server.baseUrl}`);
