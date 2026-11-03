// The faux harness (faux-harness.mjs's way: one action per paid request) for relaunch-cut.test.mjs (run-end-trace's probe of
// #1424's F1). In a process opened after
// the file RELAUNCH_MARK names exists (the test makes it just before it kills the run's process), the harness comes up
// 2 s late, as a real CLI's spawn does: the run's door already serves, and onOpen writes the cut request's cost entry
// after this, before the recovered turn starts.
import { existsSync } from "node:fs";

if (process.env.RELAUNCH_MARK && existsSync(process.env.RELAUNCH_MARK)) await new Promise((resolve) => setTimeout(resolve, 2_000));

export function script(spec) {
  const text = spec.system.join("\n");
  const killed = Boolean(process.env.RELAUNCH_MARK && existsSync(process.env.RELAUNCH_MARK));
  // Turn 1 answers. Turn 2's first request leaves and is cut by the process's death; once relaunched, the recovered turn
  // holds on a fetch until the file its instructions name exists (faux-web-hold.mjs), then answers.
  const gate = /Probe the relaunch, held until (\S+)\./.exec(text)?.[1];
  if (gate) {
    const held = { call: "fetch_page", args: { url: `http://public.example/hold?until=${encodeURIComponent(gate)}` }, usd: 0.001 };
    return [{ say: "Answer 1.", usd: 0.001 }, { end: true, usd: 0.001 }, ...(killed ? [held, { say: "After the cut.", usd: 0.001 }] : [{ cut: true }]), { end: true, usd: 0.001 }];
  }
  return [{ say: "Answer.", usd: 0.001 }, { end: true, usd: 0.001 }];
}
