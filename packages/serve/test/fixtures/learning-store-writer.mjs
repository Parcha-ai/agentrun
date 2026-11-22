// One process writing an agent's local learning store, as the server and each runner beside it on one data directory
// do (learn-store-processes.test.mjs): `node learning-store-writer.mjs <data> <name> <op> [count]`. It says "ready" on
// stdout and starts on the first line of its stdin, so the test starts every writer at once. `init` makes the store's
// first commit and prints its main; `commit` merges <count> runs, run <name>-<i> each with its own draft, retrying a
// write that did not land as a caller does later, and prints one JSON line per write: its run, its outcome and every
// failure it met on the way.
import { createInterface } from "node:readline";
import { learningCommit } from "../../dist/learn/commit.js";
import { learningInit } from "../../dist/learn/folder.js";
import { localLearningStore } from "../../dist/learn/store-local.js";
import { readmeOf } from "../../dist/learn/workflow-draft.js";

const [data, name, op, count = "1"] = process.argv.slice(2);
const store = localLearningStore(data, "agent-one");
const TRIES = 40;

process.stdout.write("ready\n");
await new Promise((resolve) => createInterface({ input: process.stdin }).once("line", resolve));

if (op === "init") {
  try {
    process.stdout.write(`${JSON.stringify({ main: await learningInit(store) })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error) })}\n`);
  }
} else {
  for (let i = 0; i < Number(count); i++) {
    const draft = `${name}-${i}`;
    const change = {
      runId: draft,
      reason: `Compiled ${draft}.`,
      files: [
        { path: `workflows/${draft}/README.md`, text: readmeOf(draft, `Answers the ${draft} question; use when asked`) },
        { path: `workflows/${draft}/workflow.json`, text: `${JSON.stringify({ v: 2, name: draft })}\n` },
      ],
    };
    const failures = [];
    let result;
    for (let tries = 0; tries < TRIES; tries++) {
      result = await learningCommit(store, change).catch((error) => ({ ok: false, reason: "threw", error: String(error?.message ?? error) }));
      if (result.ok) break;
      failures.push(result.error ?? result.reason);
    }
    process.stdout.write(`${JSON.stringify({ run: draft, result, failures })}\n`);
  }
}
