// The faux harness's script for serve's tests: one action per paid request, across the session's turns, by what the
// agent's instructions say. The script is read again at every open, so what a later process does can depend on a file.
import { existsSync } from "node:fs";

export function script(spec) {
  const text = spec.system.join("\n");
  // As real harnesses do, a request that goes on calls a tool, and the turn's last request is its answer.
  if (/Make three requests\./.test(text)) return [{ call: "read", args: { path: "a.txt" }, usd: 0.001 }, { call: "read", args: { path: "b.txt" }, usd: 0.002 }, { say: "Read it.", usd: 0.004 }];
  if (/Price unknown\./.test(text)) return [{ say: "Priced unknown.", usd: null }];
  // A chat whose second turn has a request of unknown price.
  if (/Second turn unpriced\./.test(text)) return [{ say: "Answer 1.", usd: 0.001 }, { end: true, usd: 0.001 }, { say: "Answer 2.", usd: null }, { end: true, usd: 0.001 }];
  const wait = /Wait for (\S+) before the answer\./.exec(text)?.[1];
  if (wait) return [{ call: "read", args: { path: "a.txt" }, usd: 0.002 }, ...(existsSync(wait) ? [] : [{ hang: true }]), { say: "Done after the wait.", usd: 0.004 }];
  // A request admitted and never answered, until the file exists: a crash then cuts it.
  const cut = /Cut until (\S+)\./.exec(text)?.[1];
  if (cut) return [{ call: "read", args: { path: "a.txt" }, usd: 0.002 }, ...(existsSync(cut) ? [] : [{ cut: true }]), { say: "After the cut.", usd: 0.004 }];
  // A request answered and booked with nothing after it until the file exists: no boundary writes its entry.
  const hold = /Hold until (\S+)\./.exec(text)?.[1];
  if (hold) return [{ say: "Halfway.", usd: 0.002 }, ...(existsSync(hold) ? [] : [{ hang: true }]), { say: "Done holding.", usd: 0.004 }];
  // A chat: each turn says its answer and ends.
  return Array.from({ length: 10 }, (_, i) => [{ say: `Answer ${i + 1}.`, usd: 0.001 }, { end: true, usd: 0.001 }]).flat();
}
