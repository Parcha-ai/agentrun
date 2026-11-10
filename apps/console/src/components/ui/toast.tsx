import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

export type ToastTone = "neutral" | "success" | "warning" | "error";
export type ToastInput = { title: React.ReactNode; description?: React.ReactNode; tone?: ToastTone; /** Milliseconds on screen; 0 stays until dismissed. Default: 5000, and 0 for an error. */ duration?: number };
type Shown = ToastInput & { id: number };

const ToastContext = React.createContext<((t: ToastInput) => void) | null>(null);
const ICON: Record<ToastTone, [typeof Info, string]> = { neutral: [Info, "text-muted-foreground"], success: [CircleCheck, "text-success-text"], warning: [TriangleAlert, "text-warning-text"], error: [CircleAlert, "text-destructive-text"] };
const DEFAULT_MS = 5000;

/** Says a toast: `const toast = useToast(); toast({ title: "Copied" })`. Outside a ToastProvider it says nothing. */
export function useToast() {
  return React.useContext(ToastContext) ?? noToast;
}
const noToast = () => {};

/** One toast: it leaves by itself when its time is up, and waits while the pointer or the keyboard is on it. */
function ToastCard({ toast, done }: { toast: Shown; done: (id: number) => void }) {
  const onDone = React.useCallback(() => done(toast.id), [done, toast.id]);
  const tone = toast.tone ?? "neutral";
  const ms = toast.duration ?? (tone === "error" ? 0 : DEFAULT_MS);
  // The pointer and the keyboard hold it separately: leaving with one never lets go for the other.
  const [hovered, setHovered] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const held = hovered || focused;
  React.useEffect(() => {
    if (!ms || held) return;
    const timer = setTimeout(onDone, ms);
    return () => clearTimeout(timer);
  }, [ms, held, onDone]);
  const [Icon, colour] = ICON[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      className="pointer-events-auto flex w-full items-start gap-3 border border-border-strong bg-card p-3 text-body text-card-foreground shadow-float motion-safe:animate-toast-in">
      <Icon className={cn("mt-0.5 size-4 shrink-0", colour)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{toast.title}</p>
        {toast.description && <p className="mt-0.5 text-small text-muted-foreground">{toast.description}</p>}
      </div>
      <button type="button" onClick={onDone} aria-label="Dismiss" className="-m-1 shrink-0 p-1 text-muted-foreground hover:text-foreground"><X className="size-3.5" aria-hidden /></button>
    </div>
  );
}

/** Holds the page's toasts, in the bottom corner over everything: a short word that something the person just did
 *  worked (or did not), which needs no answer and leaves by itself. Put one around the app. What must stay until it
 *  is dealt with is a Banner; what needs an answer is a Dialog. At most three show; a fourth pushes the oldest out. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Shown[]>([]);
  const next = React.useRef(0);
  const toast = React.useCallback((t: ToastInput) => setToasts((all) => [...all, { ...t, id: next.current++ }].slice(-3)), []);
  const done = React.useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* Always in the page, so a screen reader is already listening when the first toast arrives. */}
      <div role="region" aria-label="Notifications" aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-toast flex flex-col gap-2 sm:left-auto sm:w-[22rem]">
        {toasts.map((t) => <ToastCard key={t.id} toast={t} done={done} />)}
      </div>
    </ToastContext.Provider>
  );
}
