// The rig: one pi-durable Harness on a real SQLite file, a faux model that follows a script and records every request
// it is sent, and a collector for everything else a run emits (process logs, host rows). `collect()` hands all of it to
// the scanner.
//
// The model is stateless over the transcript (its next step is the number of assistant turns so far), so a process
// that is killed and reopens on the same file continues the same script without any state of its own.
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/** A script is a list of turns; a turn is a list of `{ tool, args }` calls the model makes together; the last turn may be text. */
export const call = (tool, args = {}) => ({ tool, args });

export async function openRig({ dir, install, script, rootOptions = {}, finalText = "done" }) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    db: path.join(dir, "run.sqlite"),
    requests: path.join(dir, "model-requests.jsonl"),
    logs: path.join(dir, "process.log"),
    host: path.join(dir, "host-rows.jsonl"),
  };

  // Everything the process writes while the rig is open: the log source the scan reads.
  const restore = [];
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => { fs.appendFileSync(files.logs, chunk); return write(chunk, ...rest); };
    restore.push(() => { stream.write = write; });
  }

  let requestCount = 0;
  const policy = (context) => {
    requestCount += 1;
    // What the model is sent: system prompt sections, tool definitions, every message. Nothing is left out.
    fs.appendFileSync(files.requests, `${JSON.stringify({ pid: process.pid, n: requestCount, context })}\n`);
    const turns = context.messages.filter((m) => m.role === "assistant").length;
    const step = script[turns];
    if (step === undefined) return fauxAssistantMessage([fauxText(finalText)], { stopReason: "stop" });
    return fauxAssistantMessage(step.map((c, i) => fauxToolCall(c.tool, c.args, { id: `call-${turns}-${i}` })), { stopReason: "toolUse" });
  };

  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses(Array.from({ length: 200 }, () => policy));
  const models = createModels();
  models.setProvider(faux.provider);

  const reports = [];
  const registry = createRegistry();
  install(registry);
  const harness = await Harness.open(await openNodeSqliteStorage(files.db), { models, registry, onReport: (error) => { reports.push(String(error?.stack ?? error?.message ?? error)); } }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } }, ...rootOptions });

  const hostRows = [];
  return {
    ctx, harness, root, files, reports, models,
    /** Rows the host channel received (`onSession`), stored as the host would store them. */
    host: (row, change) => { hostRows.push({ change, row }); fs.appendFileSync(files.host, `${JSON.stringify({ change, row })}\n`); },
    async run(requestId = "go-1", waitMs = 30_000) {
      const submission = await root.submit({ type: "input", content: "go", requestId }, ctx);
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const settled = await Promise.race([submission.wait(ctx), sleep(waitMs).then(() => ({ status: "timeout" }))]);
      // Background release tasks do not keep the conversation busy: wait until no live task is left.
      for (let i = 0; i < 150; i++) {
        if ((await harness.inspect(ctx)).tasks.length === 0) break;
        await sleep(100);
      }
      return settled;
    },
    /** Every entry as pi stored it, oldest first, with its kind: the readable location for a finding. */
    async entries() {
      const page = await root.entries({}, 500, undefined, ctx);
      return [...page.items].reverse();
    },
    async close() {
      await harness.close(ctx);
      for (const undo of restore) undo();
    },
    requestCount: () => requestCount,
  };
}

/** Feed the rig's outputs to a scanner. `extra` adds host sources (eval events, evidence directories, status rows). */
export async function collect(rig, scan, { evidenceDirs = [], extra = [] } = {}) {
  for (const [i, entry] of (await rig.entries()).entries()) scan.json("entries", entry, `entry[${i}:${entry.kind}]`);
  for (const line of fs.existsSync(rig.files.requests) ? fs.readFileSync(rig.files.requests, "utf8").split("\n").filter(Boolean) : []) {
    const request = JSON.parse(line);
    scan.json("model-requests", request.context, `request[${request.n}]`);
  }
  if (fs.existsSync(rig.files.host)) for (const [i, line] of fs.readFileSync(rig.files.host, "utf8").split("\n").filter(Boolean).entries()) scan.json("onSession", JSON.parse(line), `row[${i}]`);
  if (fs.existsSync(rig.files.logs)) { const log = fs.readFileSync(rig.files.logs); scan.cover("logs", log.length); scan.bytes("logs", "process.log", log); }
  scan.json("reports", rig.reports, "onReport");
  for (const dir of evidenceDirs) scan.dir("evidence", dir);
  scan.sqlite("run.sqlite", rig.files.db);
  for (const { source, value } of extra) scan.json(source, value);
}

export { fauxText };
