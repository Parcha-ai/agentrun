// mini-demos.py's movie captions for an agent's computer calls: each call on a tool_result row's computer_calls (serve's
// record of it) as the line a person reads, from serve's own timeline helpers (packages/serve/src/timeline/computer.ts),
// so a movie says what the console's run page says. Reads the calls as a JSON array on stdin, writes their lines as a
// JSON array on stdout.
//
//   node call-words.mjs < calls.json
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const built = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "serve", "dist", "timeline", "computer.js");
const { callWords } = await import(pathToFileURL(built).href);
const calls = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(calls.map((call) => callWords(call))));
