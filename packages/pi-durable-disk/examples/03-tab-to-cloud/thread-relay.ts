// Tells viewers what the teaching threads are doing. A thread is a child conversation of the agent's; the pipe relays only the root's events, so the host that runs the agent also follows each thread's
// conversation and relays it as a `thread` view message (tab/threads.ts folds them for the page). The host says what its threads are (`list`: the cluster's own typed listing, never a guess at its tasks); this
// polls it, watches each conversation once (a snapshot, then every batch), and relays a thread's status when it changes. Used by the cloud host (remote-host.ts) and by a tab that runs the agent itself.
import { watchEvents } from "@earendil-works/pi-durable";
import type { AgentEventStream, Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { ThreadMsg, ThreadRef } from "./tab/threads.ts";

type Watch = (harness: Harness, conversation: number, context: Context) => Promise<AgentEventStream>;

export class ThreadRelay {
  readonly #harness: Harness;
  readonly #context: Context;
  readonly #list: () => Promise<readonly ThreadRef[]>;
  readonly #emit: (msg: ThreadMsg) => void;
  readonly #watch: Watch;
  readonly #pollMs: number;
  readonly #threads = new Map<number, { ref: ThreadRef; stream: AgentEventStream | undefined; status: string; settledSeen: boolean }>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #polling: Promise<void> = Promise.resolve();

  constructor(harness: Harness, context: Context, list: () => Promise<readonly ThreadRef[]>, emit: (msg: ThreadMsg) => void, options: { watch?: Watch; pollMs?: number } = {}) {
    this.#harness = harness;
    this.#context = context;
    this.#list = list;
    this.#emit = emit;
    this.#watch = options.watch ?? ((h, id, c) => watchEvents(h, id as never, c));
    this.#pollMs = options.pollMs ?? 1000;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => void this.poll().catch(() => undefined), Math.max(250, this.#pollMs));
    void this.poll().catch(() => undefined);
  }

  /** One look at the listing: follow a new thread, relay a changed status. Calls do not overlap. */
  poll(): Promise<void> {
    this.#polling = this.#polling.then(() => this.#poll());
    return this.#polling;
  }

  async #poll(): Promise<void> {
    for (const ref of await this.#list()) {
      const known = this.#threads.get(ref.conversation);
      if (known === undefined) {
        const stream = await this.#watch(this.#harness, ref.conversation, this.#context);
        this.#threads.set(ref.conversation, { ref, stream, status: ref.status, settledSeen: false });
        this.#emit({ kind: "thread", conversation: ref.conversation, name: ref.name, gpu: ref.gpu, status: ref.status, snapshot: stream.snapshot });
        stream.start(async (events) => this.#emit({ kind: "thread", conversation: ref.conversation, name: ref.name, gpu: ref.gpu, status: this.#threads.get(ref.conversation)?.status ?? ref.status, events: [...events] }));
      } else {
        if (known.status !== ref.status) {
          known.status = ref.status;
          this.#emit({ kind: "thread", conversation: ref.conversation, name: ref.name, gpu: ref.gpu, status: ref.status });
        }
        // A settled thread has written everything it will: one poll after it says so (its last batch has been delivered) the watch ends.
        if (ref.settled && known.stream) {
          if (known.settledSeen) {
            const stream = known.stream;
            known.stream = undefined;
            await stream.stop().catch(() => undefined);
          } else known.settledSeen = true;
        }
      }
    }
  }

  /** A viewer that joined late wants every thread's transcript again: a fresh snapshot of each, as the root's is re-sent. */
  async resend(): Promise<void> {
    for (const [conversation, t] of this.#threads) {
      const stream = await this.#watch(this.#harness, conversation, this.#context);
      this.#emit({ kind: "thread", conversation, name: t.ref.name, gpu: t.ref.gpu, status: t.status, snapshot: stream.snapshot });
      await stream.stop().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#polling.catch(() => undefined);
    for (const t of this.#threads.values()) await t.stream?.stop().catch(() => undefined);
    this.#threads.clear();
  }
}
