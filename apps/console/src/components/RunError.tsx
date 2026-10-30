import { TriangleAlert } from "lucide-react";
import type { ApiError } from "@/lib/v2";

/** A failed run's error, or a request the server refused, on the hosted console's failure card (a neutral panel, a
 *  warning mark, mono text), with the server's typed code and message as it wrote them. */
export function RunError({ error, title = "The run failed" }: { error: ApiError; title?: string }) {
  return (
    <section className="flex gap-3 bg-card px-4 py-4 md:px-5" role="alert">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive-text" aria-hidden />
      <div className="min-w-0">
        <p className="caps text-[12px] font-semibold">{title}</p>
        <p className="mt-2 break-words font-mono text-[13px] leading-relaxed">{error.message}</p>
        <p className="mt-2 font-mono text-[11px] text-muted-foreground">
          {error.code}{error.retryable ? " · retryable" : ""}{error.request_id ? ` · ${error.request_id}` : ""}
        </p>
      </div>
    </section>
  );
}
