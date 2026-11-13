import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/** Work in progress with no length to show. `label` says what is being waited for, to a screen reader; leave it out
 *  when words beside the spinner already say it. Under reduced motion it stands still (styles.css). */
export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span role={label ? "status" : undefined} className="inline-flex">
      <LoaderCircle className={cn("size-4 animate-spin text-run-active", className)} aria-hidden />
      {label && <span className="sr-only">{label}</span>}
    </span>
  );
}
