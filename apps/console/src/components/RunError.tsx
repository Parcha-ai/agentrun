import { CircleAlert } from "lucide-react";
import type { ApiError } from "@/lib/v2";

/** A failed run's error, or a request the server refused: its typed code and message, as the server wrote them. */
export function RunError({ error, title = "The run failed" }: { error: ApiError; title?: string }) {
  return (
    <section className="border border-destructive/40 bg-run-error p-4" role="alert">
      <p className="caps flex items-center gap-2 text-[11px] text-destructive-text"><CircleAlert className="size-3.5" aria-hidden /> {title}</p>
      <p className="mt-2 break-words text-[15px] leading-relaxed">{error.message}</p>
      <p className="mt-3 font-mono text-[11px] text-muted-foreground">
        {error.code}{error.retryable ? " · retryable" : ""}{error.request_id ? ` · ${error.request_id}` : ""}
      </p>
    </section>
  );
}
