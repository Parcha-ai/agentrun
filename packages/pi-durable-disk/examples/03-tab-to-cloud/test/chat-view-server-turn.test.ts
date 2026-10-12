// The chat never shows the server's own turn (the home check-in) as a message the person said; the model still has it, and the agent's reply to it shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SERVER_TURN } from "../placement.ts";
import { ChatView } from "../tab/chat-view.ts";

const entry = (id: number, kind: string, role: string, content: string) => ({ id, kind, model: [{ role, content }] }) as never;

test("a user line the server wrote is not drawn as a user bubble; the person's own line and the agent's reply are", () => {
  const view = new ChatView();
  view.apply({
    type: "snapshot",
    entries: [
      entry(1, "pi.user", "user", "teach it to walk"),
      entry(2, "pi.user", "user", `${SERVER_TURN}You are back in your user's browser. Say one short sentence.\n\nChecked by the server just now: yes. 1 skill is home and installed: walk.`),
      ({ id: 3, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "I am back, and it learned to walk." }] }] }) as never,
    ],
    tools: [],
  } as never);
  const items = view.items();
  assert.deepEqual(items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text), ["teach it to walk"]);
  assert.ok(items.some((i) => i.kind === "assistant"));
  assert.equal(items.some((i) => JSON.stringify(i).includes("Checked by the server")), false);
});
