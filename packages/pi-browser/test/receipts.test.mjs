// Receipt facts through a real pi-durable Harness on SQLite: a tool reads a page in a session the way the browser's
// readers do (file a record, answer with its facts) and the facts are what a receipt header needs to trace the read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { orderFacts, receiptFacts, recordingOffsetS } from "../dist/index.js";

const tmp = () => fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "receipts-"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** The custody records a fake provider backend would hold, and what each provider records. */
const SESSIONS = {
  recorded: { resourceId: "bb-recorded", createdAt: ago(90_000) },
  behind: { resourceId: "bb-behind", createdAt: new Date(Date.now() + 60_000).toISOString() },
  unknown: { resourceId: null, createdAt: ago(5_000) },
  garbled: { resourceId: "bb-garbled", createdAt: "not a date" },
};

/** A reader tool in the shape of browser_read and screenshot: bytes in, one record filed, facts and header back. */
function readerExtension(dir, filed) {
  const sink = {
    async file(label, record) {
      const header = Object.entries(orderFacts(record.facts)).map(([key, value]) => `${key}: ${value}`).join("\n");
      const file = path.join(dir, `${filed.length + 1}-${record.tool}.md`);
      fs.writeFileSync(file, Buffer.concat([Buffer.from(`${header}\n---\n`), Buffer.from(record.body)]));
      filed.push({ record, file, label });
      return { path: path.basename(file) };
    },
  };
  return defineExtension({
    name: "reader",
    tools: [defineTool({
      name: "read_page",
      description: "Read a page in a session.",
      parameters: { type: "object", additionalProperties: false, required: ["session", "recorded"], properties: { session: { type: "string" }, recorded: { type: "boolean" }, image: { type: "boolean" } } },
      replay: "safe",
      execute: async (args) => {
        const body = args.image ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) : "# Page\n\nBody.";
        const facts = { requested_url: "https://example.com/", x_future_fact: "kept", ...receiptFacts({ body, session: SESSIONS[args.session], recorded: args.recorded }) };
        const record = await sink.file("n", { tool: args.image ? "screenshot" : "browser_read", args: {}, status: "ok", facts, body });
        return { content: [{ type: "text", text: record.path }], details: facts };
      },
    })],
  });
}

async function run(rounds) {
  const dir = tmp();
  const filed = [];
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses(Array.from({ length: rounds.length + 4 }, () => (context) => {
    const round = rounds[context.messages.filter((m) => m.role === "assistant").length];
    return round ? fauxAssistantMessage(round.map((args) => fauxToolCall("read_page", args)), { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry(); registry.install(readerExtension(dir, filed));
  const harness = await Harness.open(await openNodeSqliteStorage(path.join(dir, "run.sqlite")), { models, registry }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    await (await root.submit({ type: "input", content: "go", requestId: "go-1" }, ctx)).wait(ctx);
    return filed;
  } finally { await harness.close(ctx); }
}

test("a read in a recorded session carries the SHA-256 of the filed bytes, the session id and the offset into its recording", async () => {
  const [page, shot] = await run([[{ session: "recorded", recorded: true }, { session: "recorded", recorded: true, image: true }]]);
  assert.equal(page.record.facts.sha256, sha("# Page\n\nBody."));
  assert.equal(shot.record.facts.sha256, sha(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])), "a screenshot's hash is of its bytes");
  for (const { record } of [page, shot]) {
    assert.equal(record.facts.session, "bb-recorded");
    assert.ok(record.facts.recording_at_s >= 90 && record.facts.recording_at_s < 100, `offset ${record.facts.recording_at_s} follows the session clock`);
  }
  const header = fs.readFileSync(page.file, "utf8").split("\n---\n")[0];
  assert.deepEqual(header.split("\n").map((line) => line.split(": ")[0]), ["requested_url", "sha256", "session", "recording_at_s", "x_future_fact"], "a fact the order does not list follows the listed ones instead of vanishing");
});

test("a provider that records nothing gives the session and the hash but no offset", async () => {
  const [page] = await run([[{ session: "recorded", recorded: false }]]);
  assert.equal(page.record.facts.session, "bb-recorded");
  assert.ok(!("recording_at_s" in page.record.facts));
  assert.ok(!fs.readFileSync(page.file, "utf8").includes("recording_at_s"), "no header line for a fact that does not apply");
});

test("an offset is never negative, and an unknown session or a garbled start leaves the fact out", async () => {
  const [behind, unknown, garbled] = await run([[{ session: "behind", recorded: true }, { session: "unknown", recorded: true }, { session: "garbled", recorded: true }]]);
  assert.equal(behind.record.facts.recording_at_s, 0, "a clock behind the record reads zero, not a negative offset");
  assert.deepEqual(Object.keys(unknown.record.facts), ["requested_url", "x_future_fact", "sha256"], "no session id, no trace");
  assert.equal(garbled.record.facts.session, "bb-garbled");
  assert.ok(!("recording_at_s" in garbled.record.facts));
  assert.equal(recordingOffsetS("2026-10-06T12:00:00.000Z", Date.parse("2026-10-06T12:01:30.449Z")), 90.4, "tenths of a second");
});
