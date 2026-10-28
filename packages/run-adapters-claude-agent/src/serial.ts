// The session's writer, serialized, written for AgentRun. The adapter opens a new drive on the same writer after an
// interrupt halts the old one, and the halted drive may still have a write in flight (a tool's outcome that finished as
// the interrupt landed). With reads and appends on one chain, the new drive's first read waits for that write, so it
// folds the outcome instead of taking the intent for one a dead process abandoned (which would report a `never` tool
// that ran as "it may or may not have taken effect", and drop its result).
import type { SessionWriter } from "@parcha/agentrun-adapters";

/** `writer` with every read and append run one at a time, in call order. A failed one rejects for its caller only. */
export function serialWriter(writer: SessionWriter): SessionWriter {
  let chain: Promise<unknown> = Promise.resolve();
  const next = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.then(work);
    chain = run.catch(() => undefined);
    return run;
  };
  return { key: writer.key, read: () => next(() => writer.read()), append: (records) => next(() => writer.append(records)) };
}
