// open-after-effect.mjs's wrapper of the app's options: onOpen waits until the run's node log ends the named call node.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ended = (root, label) => {
  const file = join(root, "nodes.jsonl");
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf8").split("\n").some((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.t === "effect.end" && entry.label === label;
    } catch {
      return false;
    }
  });
};

export function openAfterEffect(where, options) {
  const label = process.env.AGENTRUN_TEST_OPEN_AFTER_EFFECT;
  const onOpen = options.onOpen;
  if (!label || !onOpen) return options;
  return {
    ...options,
    onOpen: async (durable) => {
      for (const end = Date.now() + 20_000; !ended(where.root, label) && Date.now() < end;) await sleep(20);
      if (process.env.AGENTRUN_TEST_OPEN_AFTER_SIGNAL) writeFileSync(process.env.AGENTRUN_TEST_OPEN_AFTER_SIGNAL, ended(where.root, label) ? "ended" : "timed out");
      return onOpen(durable);
    },
  };
}
