// mini-demos.py's movie captions for computer calls, in the one voice the console's run page reads them in: serve's own
// words (packages/serve/src/timeline/computer.ts callWords) for serve's record of each call. A scripted demo's call comes
// raw, `{method, params, answer}` (answer `{ok, value}` or `{ok: false, error}`), and is recorded here as serve records
// an agent's (computer-calls.ts callRecordOf), each step's ref by the name the run's earlier looks gave it (RefNames); an
// agent's call comes as serve's record already (a tool_result row's computer_calls). Reads one call as JSON a line on
// stdin and writes its words as a JSON string a line on stdout, flushed per line, so one process serves a whole run.
//
//   printf '%s\n' '{"method":"apps.launch","params":{"id":"com.apple.TextEdit"},"answer":{"ok":true}}' | node call-words.mjs
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const built = (name) => pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "serve", "dist", name)).href;
const { callWords } = await import(built("timeline/computer.js"));
const { callRecordOf, RefNames } = await import(built("computer-calls.js"));

const names = new RefNames();
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const call = JSON.parse(line);
  if ("answer" in call && call.method === "ui.observe") names.learn(call.answer);
  const record = "answer" in call ? callRecordOf(call.method, call.params, call.answer, 0, 0, names.of) : call;
  process.stdout.write(`${JSON.stringify(callWords(record))}\n`);
}
