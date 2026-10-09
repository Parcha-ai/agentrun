// What the agent is told about the tab: no core or memory figure (the browser reports its machine's, not the sandbox's),
// and an honest sentence about what a WebAssembly process is.
import assert from "node:assert/strict";
import { test } from "node:test";
import { noticeText } from "../environment.ts";
import { tabFacts } from "../tab/runtime.ts";

test("the tab's notice states no vCPU or RAM and says it is one WebAssembly process", () => {
  const text = noticeText(tabFacts(["bash", "node", "ls", "cat"]), { id: "sw-1", from: "a Modal GPU machine", planned: true });
  assert.doesNotMatch(text, /vCPU|GB RAM/);
  assert.match(text, /no GPU/);
  assert.match(text, /one WebAssembly process inside a browser page \(32-bit, at most 4 GB of memory\)/);
});
