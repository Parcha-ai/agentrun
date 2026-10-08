// A stand-in extension that leaks one sentinel to one chosen place per tool. It is the planted leak the wire check
// must turn red on: if the scanner cannot see a leak here, it cannot see one in the package.
import fs from "node:fs";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool } from "@earendil-works/pi-durable";

const Custody = defineDoc({ kind: "leaky.custody", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ note: "" }) });
const text = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });

/** Where a leak lands: the tool name, the scan source that must report it. */
export const LEAKS = {
  leak_result: { source: "entries", note: "the tool result text" },
  leak_details: { source: "entries", note: "the result's details object" },
  leak_document: { source: "run.sqlite:document_revisions", note: "a pi-durable document" },
  leak_memo: { source: "run.sqlite", note: "a memo on the call's record" },
  leak_evidence: { source: "evidence", note: "a filed evidence body" },
  leak_evidence_name: { source: "evidence", note: "an evidence file name" },
  leak_host_row: { source: "onSession", note: "a host channel row" },
  leak_log: { source: "logs", note: "a log line" },
  leak_error: { source: "entries", note: "an isError result" },
  leak_base64: { source: "entries", note: "a result carrying the value base64-encoded" },
  leak_fragment: { source: "entries", note: "a result carrying only the first 24 characters" },
};

export function makeLeakyExtension({ secret, evidenceDir, onSession }) {
  const tool = (name, execute) => defineTool({ name, description: `leaks to: ${LEAKS[name].note}`, parameters: Type.Object({}), replay: "safe", execute });
  const tools = [
    tool("leak_result", async () => text(`connected via ${secret}`)),
    tool("leak_details", async (_a, api, context) => { await api.details({ via: secret }, context); return text("ok"); }),
    tool("leak_document", async (_a, api, context) => { await api.commit(async (tx) => { (await tx.doc(Custody, api.conversationId)).note = secret; }, context); return text("ok"); }),
    tool("leak_memo", async (_a, api, context) => { await api.memo("m", { secret }, context); return text("ok"); }),
    tool("leak_evidence", async () => { fs.mkdirSync(path.join(evidenceDir, "n1"), { recursive: true }); fs.writeFileSync(path.join(evidenceDir, "n1", "0001-read.md"), `tool: browser_read\n---\n${secret}\n`); return text("filed"); }),
    tool("leak_evidence_name", async () => { fs.mkdirSync(path.join(evidenceDir, "n1"), { recursive: true }); fs.writeFileSync(path.join(evidenceDir, "n1", `${secret}.md`), "body"); return text("filed"); }),
    tool("leak_host_row", async () => { await onSession({ plane: "default", state: "live", viewer: secret }, "launched"); return text("ok"); }),
    tool("leak_log", async () => { process.stderr.write(`dial ${secret}\n`); return text("ok"); }),
    tool("leak_error", async () => text(`WebSocket ${secret} refused`, { isError: true })),
    tool("leak_base64", async () => text(`token=${Buffer.from(secret).toString("base64")}`)),
    tool("leak_fragment", async () => text(`prefix ${secret.slice(0, 24)}...`)),
    defineTool({ name: "clean", description: "returns a benign result", parameters: Type.Object({}), replay: "safe", execute: async (_a, api, context) => {
      await api.details({ ok: true }, context);
      await api.memo("m", { ok: true }, context);
      fs.mkdirSync(path.join(evidenceDir, "n1"), { recursive: true });
      fs.writeFileSync(path.join(evidenceDir, "n1", "0001-read.md"), "tool: browser_read\n---\na page\n");
      await onSession({ plane: "default", state: "live" }, "launched");
      process.stderr.write("clean call\n");
      return text("page read");
    } }),
  ];
  return defineExtension({ name: "leaky", tools });
}
