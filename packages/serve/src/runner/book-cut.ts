// What a run's earlier claim left out when its runner went, booked by a claim that ends the run with no loop: each model
// request it admitted and never saw answered is booked once, cut, at its hold (the kernel's bookCut, the rule every
// loop's booking takes before it sends anything), so the run's cost reads what it may have spent, never an unknown.

import type { Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { modelPortFor } from "@parcha/agentrun-kernel";
import { DECISION_SESSION, TOOL_SESSION } from "@parcha/agentrun-kernel/kernel/cap";
import type { Journal } from "./loop-contract.js";
import { journalSessions } from "./sessions.js";

/** `journal` as its Harness sees it: every method its own, but close, which is the claim's to do. */
function unclosed<T extends object>(journal: T): T {
  return new Proxy(journal, {
    get(target, key) {
      if (key === "close") return async () => undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Books, under the claim that holds `journal`, every model request of the run's sessions that an earlier claim left
 *  open (bookCut: at its hold, else at an unknown price). The paid-tools and decisions sessions are not model requests'
 *  and stay as they are. Idempotent: a booked request is answered. */
export async function bookCutRequests(journal: Journal, context: Context, flush: () => Promise<void>): Promise<void> {
  const harness = await Harness.open(unclosed(journal), { models: createModels(), registry: createRegistry(), onReport: () => {} }, context);
  try {
    const sessions = journalSessions(harness, context, { flush });
    for (const key of await sessions.keys()) {
      if (key === TOOL_SESSION || key === DECISION_SESSION) continue;
      const writer = await sessions.open(key);
      await (await modelPortFor(writer, { key })).bookCut();
    }
    await flush();
  } finally {
    await harness.close(context).catch(() => undefined);
  }
}
