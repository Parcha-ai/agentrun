import { Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";

const MANUAL = "The browser won't copy here. Select it and copy it.";

/** One press puts `text` on the clipboard and says Copied beside the button, read by a screen reader as it changes. The
 *  clipboard needs a secure page: with none, or a write the browser refuses, it says to select the text instead, so the
 *  text it copies is always shown beside it too. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [said, setSaid] = useState<string | null>(null);
  const copy = () => {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip?.writeText) { setSaid(MANUAL); return; }
    clip.writeText(text).then(() => setSaid("Copied"), () => setSaid(MANUAL));
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" onClick={copy}><Copy aria-hidden /> {label}</Button>
      {said && <span className="font-mono text-label text-muted-foreground" role="status">{said}</span>}
    </span>
  );
}
