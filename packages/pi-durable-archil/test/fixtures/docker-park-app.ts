// The app the docker parking round runs inside a container: the lifecycle app (test/fixtures/lifecycle-app.ts, whose flaky
// model errors once and retries after $PDA_TEST_RETRY_MS) with no serve front. Every open submits "flaky" to the root
// conversation as request `park-1`; pi deduplicates the requestId, so a later open gets the same submission. When that
// submission is done the app appends `{"ev":"answer","generation":...,"text":...}` to $PDA_TEST_OUT/<run>.jsonl.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AppContext, AppOptions } from "../../src/app.ts";
import lifecycle from "./lifecycle-app.ts";

const REQUEST_ID = "park-1";

export default async function app(where: AppContext): Promise<AppOptions> {
  const options = await lifecycle(where);
  const out = join(process.env.PDA_TEST_OUT!, `${where.ref.id}.jsonl`);
  const note = (line: Record<string, unknown>) => appendFileSync(out, `${JSON.stringify({ ...line, pid: process.pid, t: Date.now() })}\n`);
  return {
    ...options,
    async onOpen(run) {
      await options.onOpen?.(run);
      const ctx = BACKGROUND_CONTEXT;
      const conversation = await run.harness.root(ctx, options.root);
      const submission = await conversation.submit({ type: "input", requestId: REQUEST_ID, content: "flaky" }, ctx);
      note({ ev: "submitted", generation: run.generation, status: (await submission.status(ctx)).status });
      // A park or a drain closes the Harness under this wait; the next open waits again.
      void submission.wait(ctx).then(
        async (record) => {
          if (record.type !== "input" || record.status !== "done") return note({ ev: "ended", generation: run.generation, status: record.status });
          const page = await conversation.entries({ minEntryId: record.answer, maxEntryId: record.answer }, 1, undefined, ctx);
          const text = (page.items[0]?.model ?? [])
            .flatMap((m) => (m.role === "assistant" ? m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])) : []))
            .join("");
          note({ ev: "answer", generation: run.generation, text });
        },
        (err: unknown) => note({ ev: "wait ended", generation: run.generation, message: (err as Error).message }),
      );
    },
  };
}
