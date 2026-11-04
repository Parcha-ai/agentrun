// The console's learning demo server: agentrun-serve on the faux refund-policy model, learning on, the console as built,
// loopback only. Usage: node serve.mjs <packages/serve/dist/index.js> <apps/console/dist> <data dir> <port>
// Prints one JSON line, the server's URL and pid. The console's sign-in link holds the token, so it goes to <data>/.link only.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [serveIndex, consoleDir, data, port] = process.argv.slice(2);
const { startServe } = await import(pathToFileURL(serveIndex).href);
const faux = new URL("./faux-refunds.mjs", import.meta.url).pathname;
const serve = await startServe({ data, port: Number(port), host: "127.0.0.1", faux, learning: "on", console: consoleDir, maxRuns: 6, log: () => {} });
writeFileSync(join(data, ".link"), `${serve.url}/?token=${encodeURIComponent(serve.token)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ url: serve.url, pid: process.pid })}\n`);
const stop = () => void serve.close().then(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
