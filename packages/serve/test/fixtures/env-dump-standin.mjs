// A CLI harness's child, as the harness starts it, with its environment written down first: `node env-dump-standin.mjs
// <out> <stand-in> [args…]` writes this process's whole environment (JSON) to <out>, then runs <stand-in> as the child,
// with the rest of its arguments, in this same process. A test reads <out> to see what reached the child.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [out, standIn, ...rest] = process.argv.slice(2);
writeFileSync(out, JSON.stringify(process.env), { mode: 0o600 });
process.argv = [process.argv[0], standIn, ...rest];
await import(pathToFileURL(standIn).href);
