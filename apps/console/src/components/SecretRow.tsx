import { Button } from "@/components/ui/button";
import { ago } from "@/lib/needs";
import { SOURCE_WORDS } from "@/lib/secrets";
import { cn } from "@/lib/utils";
import type { SecretField } from "@/lib/v2";

/** One secret, the same on every page that holds one (Keys, MCP servers, Computers): its name, Set or Missing, where it
 *  comes from, when it last changed, and, on the owner's password session (`writable`), Paste for a missing one or
 *  Replace and Remove for one set here or by a sign-in. One set in the environment wins: it is greyed, with nothing to
 *  paste over it. No value is ever shown: the read has none. `note`: a word on its state (a saved one that no longer
 *  opens). An action with no handler is not offered. `required` false: a key its provider can do without (Kernel's project),
 *  said Optional, its absence no warning; left out, a secret is needed. */
export function SecretRow({ field: f, writable, required = true, disabled = false, now = Date.now, note, onPaste, onRemove }: {
  field: SecretField;
  writable: boolean;
  required?: boolean;
  /** Offered but not usable now (this server can't store a secret: no seal key). */
  disabled?: boolean;
  now?: () => number;
  note?: string;
  onPaste?: () => void;
  onRemove?: () => void;
}) {
  const env = f.source === "env";
  const acts = writable && !env;
  return (
    <li data-secret={f.name} data-source={f.source ?? "none"} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px]", env && "opacity-60")}>
      <span>{f.name}{!required && <span className="ml-2 font-sans text-[11px] text-muted-foreground">Optional</span>}</span>
      <span data-state={f.set ? "set" : required ? "missing" : "optional-missing"} className={note ? "text-warning-text" : f.set ? "text-success-text" : "text-muted-foreground"}>{f.set ? "Set" : "Missing"}</span>
      {f.source && <span className="text-muted-foreground">{SOURCE_WORDS[f.source]}</span>}
      {f.changed_at && <span className="text-muted-foreground">Changed {ago(f.changed_at, now())} ago</span>}
      {note && <span className="text-warning-text">{note}</span>}
      {acts && (
        <span className="ml-auto flex gap-2 font-sans">
          {onPaste && <Button size="sm" variant={f.set ? "outline" : "primary"} disabled={disabled} onClick={onPaste}>{f.set ? "Replace" : "Paste"}</Button>}
          {onRemove && f.set && <Button size="sm" variant="destructive" onClick={onRemove}>Remove</Button>}
        </span>
      )}
    </li>
  );
}
