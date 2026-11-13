// A run's paid requests as its records hold them: each runner.request whose model is "paid:<name>", in every session of
// the run's journal (the cap's ledger writes a paid tool call's hold and its settle there, with who charges for it).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";

const { journalSessions } = await import("../../dist/runner/sessions.js");

/** Each paid runner.request's data in `runId`'s records, read on a journal of its own once the run is at rest. */
export async function paidRequestsOf(store, runId = "run-1") {
  const row = await store.runs.get(runId);
  const harness = await Harness.open(store.journal({ runId, runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, BACKGROUND_CONTEXT);
  try {
    const sessions = journalSessions(harness, BACKGROUND_CONTEXT, store);
    const out = [];
    for (const key of await sessions.keys()) {
      for (const record of await sessions.read(key)) if (record.kind === "runner.request" && String(record.data?.model ?? "").startsWith("paid:")) out.push(record.data);
    }
    return out;
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}
