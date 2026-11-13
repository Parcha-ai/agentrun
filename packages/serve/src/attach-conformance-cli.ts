// The attach binding's conformance cases (attach-conformance.ts) as a command, for a person checking a real driver:
//
//   node dist/attach-conformance-cli.js [--port 7392] [--listen 127.0.0.1]
//
// prints the server address and a pairing code to type into the driver, runs every case once it has paired, prints PASS
// or FAIL for each, and exits 0 when all passed.
import { parseArgs } from "node:util";
import { runAttachConformance } from "./attach-conformance.js";

const { values } = parseArgs({ options: { port: { type: "string", default: "7392" }, listen: { type: "string", default: "127.0.0.1" } } });
const results = await runAttachConformance({
  port: Number(values.port),
  host: values.listen,
  pair: () => console.log("Waiting for the driver to pair..."),
  say: (line) => console.log(line),
});
const failed = results.filter((result) => !result.ok).length;
console.log(failed === 0 ? `All ${results.length} cases passed.` : `${failed} of ${results.length} cases failed.`);
process.exitCode = failed === 0 ? 0 : 1;
