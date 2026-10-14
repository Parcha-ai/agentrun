// scripts/test.mjs's abort path for one file: a SIGINT or SIGTERM aborts run(), which SIGTERMs the file's process.
import { run } from "node:test";

const [file, preload] = process.argv.slice(2);
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop.abort());
const stream = run({ files: [file], concurrency: 1, execArgv: ["--import", preload], signal: stop.signal });
stream.on("test:fail", ({ name, details }) => process.stderr.write(`${name}: ${details?.error?.cause?.stack ?? details?.error?.stack ?? details?.error}\n`));
for await (const _ of stream);
