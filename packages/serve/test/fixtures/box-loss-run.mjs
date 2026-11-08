// A run on a real run store at synchronous NORMAL, for barrier-box-loss.test.mjs: pi-durable-disk's DurableRun on a local
// directory, with serve's own effect paths wired as app.ts wires them. `first` starts the run, whose effect is sent and
// never answers, so the test can lose the box while it is in flight; `resume` opens the run again, as the next process
// after a crash does, and prints what it saw as one JSON line.
//   box-loss-run.mjs <run dir> <paid|request|workflow> <first|resume> <effects file>
// paid: monid.run on monid's /slow (the faux monid; its calls are filed in AGENTRUN_TEST_FAUX_MONID_CALLS), called by a
// faux model once. request: a capped run whose model (faux-signal.mjs) is in flight until a file that never comes. The
// cap is $1.70: a request's worst case is $1.64, so one cut request held leaves no room for the next. workflow: a call
// node whose effect files a line in <effects file> and, in `first`, never answers.
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BARRIER, localRun, openDurableRun, syncNow } from "@parcha/pi-durable-disk";
import { createWorkflowExtension } from "@parcha/agentrun-pi/durable";
import { capModels, spentIn } from "../../dist/cap.js";
import { wireName } from "../../dist/catalog.js";
import { FAUX_ENV, runModels } from "../../dist/model.js";
import { FAUX_MONID_ENV, MONID_KEY_ENV, monidRegistration } from "../../dist/monid.js";
import { settleIn } from "../../dist/paid-calls.js";
import { markRequests } from "../../dist/request-start.js";
import { KEY as MONID_KEY } from "./faux-monid.mjs";

const [dir, site, phase, effects] = process.argv.slice(2);
const storeFile = join(dir, "store", "run.sqlite");
const ref = { disk: "dsk-local", region: "local", id: "run-1" };
const CAP_USD = 1.7;

const registry = createRegistry();
// A real Models even for a workflow-only run: pi 1.5's Harness.open binds models.getAuth.
let models = createModels();
let model;
let marked;
/** The run's store as a barrier takes it, from the open's beforeResume: before a resumed task sends anything. */
let journal;

if (site === "paid") {
  const monid = monidRegistration("run", { [FAUX_ENV]: "1", [FAUX_MONID_ENV]: new URL("./faux-monid.mjs", import.meta.url).pathname, [MONID_KEY_ENV]: MONID_KEY }, () => join(dir, "work"));
  registry.install(defineExtension({ name: "monid", tools: [monid] }));
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 20 }, () => (transcript) => transcript.messages.some((m) => m.role === "toolResult")
    ? fauxAssistantMessage("done")
    : fauxAssistantMessage(fauxToolCall(wireName("monid.run"), { provider: "faux", endpoint: "/slow", input: {} }, { id: "monid-1" }), { stopReason: "toolUse" })));
  models = createModels();
  models.setProvider(faux.provider);
  model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
} else if (site === "request") {
  const chosen = await runModels({ ...process.env, [FAUX_ENV]: new URL("./faux-signal.mjs", import.meta.url).pathname }, undefined, ["default"]);
  model = chosen.model;
  // As app.ts: what earlier processes spent is read before the store opens; each request marked, inside the cap.
  marked = await markRequests(chosen.models);
  models = await capModels(marked.models, CAP_USD, spentIn(storeFile), { unpriced: chosen.unpriced, refused: marked.refused });
}

const flow = site === "workflow" ? createWorkflowExtension({
  // As app.ts: each effect's admission synced before it is dispatched (barriers.ts workflowAdmit).
  options: () => ({ afterAdmit: async () => {
    if (!journal) throw new Error("the run's store is not open, so a workflow effect's admission cannot be made durable: it is not sent");
    await syncNow(journal, BARRIER.workflowAdmit);
  } }),
  run: () => ({ adapters: { runEffect: async () => {
    const fd = openSync(effects, "a");
    appendFileSync(fd, `${phase}\n`);
    fsyncSync(fd);
    closeSync(fd);
    if (phase === "first") await new Promise(() => {});
    return { ok: true };
  } } }),
}) : undefined;
if (flow) registry.install(flow.extension);

const WORKFLOW = { v: 2, name: "box-loss", schemas: { Out: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, Any: { type: "object" } }, output: { schemaId: "Out", path: "final" }, root: { node: "chain", steps: [
  { node: "call", label: "charge", via: "tool", tool: "pay.charge", args: {}, out: "Any", as: "paid", deadline_s: 600 },
  { node: "code", label: "finish", code: "() => ({ final: { ok: true } })" },
] } };

const run = await openDurableRun(ref, {
  ...localRun(dir),
  synchronous: "NORMAL",
  keepWal: true,
  harness: { registry, models },
  beforeResume: (opening) => void (journal = opening.syncTarget),
});
// As app.ts's onOpen: the paid calls' root and store, and the marks' run.
settleIn((kind, data) => run.harness.commit(async (tx) => void (await tx.appendEntry(ROOT_CONVERSATION_ID, { kind, data })), context), run.store);
marked?.open(run);

const done = (line) => process.stdout.write(`${JSON.stringify(line)}\n`, () => process.exit(0));
if (phase === "first") {
  process.stdout.write("open\n");
  if (flow) await flow.start(run.harness, { key: "run-1", workflow: WORKFLOW, input: {} }, context, { background: true });
  else await (await run.harness.root(context, { agent: { model } })).submit({ type: "input", content: site === "request" ? `Signal ${effects}, then answer once ${effects}.go exists.` : "Run monid's /slow." }, context);
  setInterval(() => undefined, 60_000);
} else if (flow) {
  // As app.ts's onOpen: the run's workflow started again, which reaches the task the crash left.
  const outcome = await flow.start(run.harness, { key: "run-1", workflow: WORKFLOW, input: {} }, context, { background: true }).then((task) => task.wait(context));
  done({ outcome: { status: outcome.status, ...(outcome.code ? { code: outcome.code } : {}) } });
} else {
  await run.harness.waitForIdle(context);
  const root = await run.harness.conversation(ROOT_CONVERSATION_ID, context);
  done({ conversation: Boolean(root) });
}
