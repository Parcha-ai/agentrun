// `pi-durable-agent serve <dir> [--port n]`: print the address of a local page over the agent home in <dir>, and keep
// serving it until interrupted. It opens no browser and writes nothing to the home.
import { parseArgs } from "node:util";
import { serveHome } from "./server.js";

const USAGE = "usage: pi-durable-agent serve <dir> [--port <n>]\n  Serves the agent home in <dir> read-only on 127.0.0.1 and prints its address. It opens nothing.";

/** Run the command; returns the exit code once the server has stopped. */
export async function main(argv: readonly string[], io: { out: (line: string) => void; err: (line: string) => void; signal?: AbortSignal } = { out: console.log, err: console.error }): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: { port: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true });
  } catch (error) {
    io.err(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const [command, dir, ...extra] = parsed.positionals;
  if (parsed.values.help) {
    io.out(USAGE);
    return 0;
  }
  if (command !== "serve" || dir === undefined || extra.length > 0) {
    io.err(USAGE);
    return 2;
  }
  const port = parsed.values.port === undefined ? 0 : Number(parsed.values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    io.err(`the port ${JSON.stringify(parsed.values.port)} is not 0 to 65535\n${USAGE}`);
    return 2;
  }
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  if (io.signal?.aborted) interrupt();
  else io.signal?.addEventListener("abort", interrupt, { once: true });
  // Made before the server starts, so an interrupt during startup is not missed.
  const stopped = new Promise<void>((resolve) => {
    if (stop.signal.aborted) resolve();
    else stop.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  try {
    const served = await serveHome({ dir }, { port, signal: stop.signal });
    if (!stop.signal.aborted) io.out(served.url);
    await stopped;
    await served.close();
    return 0;
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}
