// The teaching threads as the page shows them: each thread is a coding agent on its own GPU with its own conversation, so each has its own transcript (a ChatView, the same one the root uses) and its tool calls
// render with the same lines and bodies. The host tells the page about them as `thread` view messages (thread-relay.ts); this is the page's side. Portable, no DOM.
import type { AgentEvent } from "@earendil-works/pi-durable";
import { ChatView } from "./chat-view.ts";

export type ThreadMsg = {
  kind: "thread";
  conversation: number;
  name: string;
  gpu: number | null;
  /** The teaching run (the TeachSkills task) that forked the thread: a second teach_skills call is a second run. */
  teach?: number;
  /** running | done | timed-out | error, as the host's own listing says */
  status: string;
  snapshot?: AgentEvent;
  events?: AgentEvent[];
};

/** What the host's listing says of one thread (the host owns what a thread is: cluster/teach-skills.ts threadsOf). */
export type ThreadRef = {
  conversation: number;
  name: string;
  gpu: number | null;
  /** queued | running while it works, then how it ended (passed, never-passed, error, timed-out, ...): the host's words. */
  status: string;
  /** The thread's task is finished: nothing more will come once what was written has been relayed. */
  settled?: boolean;
  teach?: number;
};

/** A thread still working: its status can change; once it is anything else it stays that. */
export const ACTIVE = new Set(["queued", "starting", "running"]);

export type Thread = { conversation: number; teach: number | null; name: string; gpu: number | null; status: string; chat: ChatView };

export class ThreadSet {
  #threads = new Map<number, Thread>();
  /** Bumped on every change: a view that caches what it drew compares it. */
  version = 0;

  apply(msg: ThreadMsg): void {
    let t = this.#threads.get(msg.conversation);
    if (!t) {
      t = { conversation: msg.conversation, teach: msg.teach ?? null, name: msg.name, gpu: msg.gpu, status: msg.status, chat: new ChatView() };
      this.#threads.set(msg.conversation, t);
    }
    if (ACTIVE.has(t.status)) t.status = msg.status; // forward only: a late message does not bring a finished thread back
    if (msg.snapshot) t.chat.apply(msg.snapshot);
    for (const e of msg.events ?? []) t.chat.apply(e);
    this.version++;
  }

  /** By GPU, then by conversation. */
  list(): Thread[] {
    return [...this.#threads.values()].sort((a, b) => (a.gpu ?? 1e9) - (b.gpu ?? 1e9) || a.conversation - b.conversation);
  }

  clear(): void {
    this.#threads.clear();
    this.version++;
  }
}

/**
 * Which threads belong to which teach_skills call. Each call makes one teaching run, and a run's threads carry its id (`teach`, ascending in time); the calls are in the chat's order. They are
 * lined up from the newest end (the newest call is the newest run), so an earlier call that failed before it forked anything shifts nothing for the calls after it. A call with no run gets none.
 */
export function threadsByCall(callIds: readonly string[], threads: readonly Thread[]): Map<string, Thread[]> {
  const runs = [...new Set(threads.map((t) => t.teach).filter((t): t is number => t !== null))].sort((a, b) => a - b);
  const out = new Map<string, Thread[]>();
  // A host that does not say which run a thread belongs to cannot be scoped: its threads show under the newest call.
  if (runs.length === 0) {
    if (callIds.length > 0 && threads.length > 0) out.set(callIds[callIds.length - 1]!, [...threads]);
    return out;
  }
  const n = Math.min(callIds.length, runs.length);
  for (let k = 1; k <= n; k++) out.set(callIds[callIds.length - k]!, threads.filter((t) => t.teach === runs[runs.length - k]));
  return out;
}
