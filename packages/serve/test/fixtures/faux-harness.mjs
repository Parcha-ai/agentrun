// The faux harness's script for serve's tests: one action per paid request, across the session's turns, by what the
// agent's instructions say. The script is read again at every open, so what a later process does can depend on a file.
import { existsSync } from "node:fs";

export function script(spec) {
  const text = spec.system.join("\n");
  if (/Make three requests\./.test(text)) return [{ call: "read", args: { path: "a.txt" }, usd: 0.001 }, { say: "Read it.", usd: 0.002 }, { end: true, usd: 0.004 }];
  const wait = /Wait for (\S+) before the answer\./.exec(text)?.[1];
  if (wait) return [{ call: "read", args: { path: "a.txt" }, usd: 0.002 }, ...(existsSync(wait) ? [] : [{ hang: true }]), { say: "Done after the wait.", usd: 0.004 }, { end: true, usd: 0.001 }];
  // A chat: each turn says its answer and ends.
  return Array.from({ length: 10 }, (_, i) => [{ say: `Answer ${i + 1}.`, usd: 0.001 }, { end: true, usd: 0.001 }]).flat();
}
