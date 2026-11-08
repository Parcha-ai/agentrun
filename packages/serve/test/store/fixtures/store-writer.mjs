// A writer process for store-flush.test.mjs: opens the store at argv[2], makes the run argv[3] (an agent, a revision and a
// queued run), flushes when argv[4] is "flush", prints "written", then waits to be killed: a SIGKILL, no close, as a crash
// or a lost box ends a process.
import { openSqliteStore } from "../../../dist/store/sqlite/store.js";

const [file, runId, mode] = process.argv.slice(2);
const store = await openSqliteStore({ file });
await store.agents.put({ id: `agent-${runId}`, name: runId });
await store.agents.addRevision({ id: `rev-${runId}`, agentId: `agent-${runId}`, kind: "agentic", body: { instructions: "Answer." } });
await store.runs.create({ id: runId, agentId: `agent-${runId}`, revisionId: `rev-${runId}` });
if (mode === "flush") await store.flush();
process.stdout.write("written\n");
setInterval(() => {}, 1_000);
