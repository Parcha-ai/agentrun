// Records test/fixtures/door-one-input.json: the door's GET /events stream (pi-durable-disk's watchEvents, what serve
// reads today) for ONE input, the shape of a B run: the faux model plays [read, then say "done"] with the suite's read
// tool, no provider is called. The live view's parity red (live-parity.test.mjs) checks the store's stream against this
// recording, which outlives the door's code (the cutover deletes it); pi-durable-disk's door-exchange.json is a two-turn
// recording (its stream starts after a first turn), which a one-input B run cannot line up with.
//
// Re-runnable: `node test/record-door-one-input.mjs` from packages/serve, after a build. It writes each event's envelope
// (its type; a message's role; a call's tool name; a run event's inputs), never ids, times or model text that vary.
import { writeFileSync } from "node:fs";
import { doorStream } from "./live-support.mjs";

export const SCRIPT = [{ call: "read" }, { say: "done" }];

/** What a recording keeps of an event: its type and the fields that say what happened, none that vary run to run. */
export function envelope(event) {
  const role = event.message?.role ?? event.entry?.model?.[0]?.role;
  return {
    type: event.type,
    ...(role ? { role } : {}),
    ...(event.toolName ? { tool: event.toolName } : {}),
    ...(event.type === "submission" ? { status: event.record?.status } : {}),
  };
}

if (import.meta.main) {
  const { snapshot, events } = await doorStream(SCRIPT);
  const out = new URL("./fixtures/door-one-input.json", import.meta.url);
  writeFileSync(out, `${JSON.stringify({ source: "pi-durable-disk watchEvents (the door's GET /events)", script: SCRIPT, snapshot: snapshot.type, events: events.map(envelope) }, null, 2)}\n`);
  console.log(`wrote ${out.pathname}: ${events.length} events`);
}
