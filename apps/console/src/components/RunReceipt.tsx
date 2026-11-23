import { useEffect, useState } from "react";
import { renderReceipt } from "@/components/Receipt";
import { receiptFacts, showsReceipt } from "@/lib/receipt";
import type { Run, RunTrace, RunUsage } from "@/lib/v2";

/** A finished free run's receipt on its page (lib/receipt.ts showsReceipt): its usage and trace are read once it shows,
 *  and the card is drawn by renderReceipt once both reads have answered or failed (a failed one adds nothing; with no
 *  usage there is no model to name, and no card). Nothing for any other run, which reads nothing for it. `freeRequests`:
 *  the server's free-model request limit a run (capabilities' `limits.free_model_requests`), in the receipt's words. */
export function RunReceipt({ run, agentName, readUsage, readTrace, freeRequests }: { run: Run; agentName: string; readUsage?: () => Promise<RunUsage>; readTrace?: () => Promise<RunTrace>; freeRequests?: number }) {
  const shows = showsReceipt(run);
  const [reads, setReads] = useState<{ run: string; usage?: RunUsage; trace?: RunTrace } | null>(null);
  useEffect(() => {
    if (!shows) return;
    let live = true;
    const read = <T,>(f?: () => Promise<T>) => (f ? Promise.resolve().then(f).catch(() => undefined) : Promise.resolve(undefined));
    void Promise.all([read(readUsage), read(readTrace)]).then(([usage, trace]) => { if (live) setReads({ run: run.run_id, usage, trace }); });
    return () => { live = false; };
  }, [shows, run.run_id, run.ended_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const facts = shows && reads?.run === run.run_id ? receiptFacts(run, agentName, reads.usage, reads.trace, freeRequests) : null;
  return facts ? renderReceipt(facts) : null;
}
