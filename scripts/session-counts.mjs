#!/usr/bin/env node
// The session counts under a home, per source: the stand-in entry scripts/build-binary.mjs compiles until the importer's
// own CLI (packages/import) lands. It reads with serve's importer (packages/serve/src/import-sources.ts), the TypeScript
// itself: Node 24 strips its types, and Bun compiles it as it is, so this file runs on Node and as the compiled binary.
//
//   session-counts <home>   one line of JSON: for each source, its session files and their requests' token counts
//
// A record an earlier file of the same source held already counts once, as the import counts it.
import { SOURCES, readSession, sessionFiles } from "../packages/serve/src/import-sources.ts";

const USAGE = "Usage: session-counts <home>   each source's sessions and token counts under <home>, as one line of JSON";

const args = process.argv.slice(2);
if (args[0] === "--help" || args[0] === "-h") {
  console.log(USAGE);
  process.exit(0);
}
if (args.length !== 1 || args[0].startsWith("-")) {
  console.error(USAGE);
  process.exit(2);
}
const home = args[0];

const counts = {};
for (const source of SOURCES) {
  const total = { sessions: 0, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const seen = new Set();
  for (const file of await sessionFiles(home, source)) {
    const session = await readSession(file, source, { seen });
    total.sessions += 1;
    for (const turn of session.turns) {
      if (turn.role !== "assistant" || !turn.usage) continue;
      total.requests += 1;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) total[key] += turn.usage[key];
    }
  }
  counts[source] = total;
}
console.log(JSON.stringify(counts));
