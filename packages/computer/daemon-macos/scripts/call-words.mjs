// mini-demos.py's movie captions for computer calls, in the one voice the console's run page reads them in: each call as
// serve's record keeps it (a tool_result row's computer_calls, or a scripted demo's own call in that shape) through serve's
// own words for it (packages/serve/src/timeline/computer.ts callWords). A key step's chord is kept as the record keeps it
// (keptChord: a lone character is typing, never said). Reads one call as JSON a line on stdin and writes its words as a
// JSON string a line on stdout, flushed per line, so one process serves a whole run.
//
//   printf '%s\n' '{"method":"apps.launch","app":"com.apple.TextEdit","ok":true}' | node call-words.mjs
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const built = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "serve", "dist", "timeline", "computer.js");
const { callWords, keptChord } = await import(pathToFileURL(built).href);

/** A call with each key step's chord as the record keeps it. */
const kept = (call) => ({
  ...call,
  ...(Array.isArray(call.steps) ? { steps: call.steps.map(({ keys, ...step }) => ({ ...step, ...(keptChord(keys) ? { keys } : {}) })) } : {}),
});

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  process.stdout.write(`${JSON.stringify(callWords(kept(JSON.parse(line))))}\n`);
}
