import { Copy, Download, FileText, Folder, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { bytes, markdown, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RunFile } from "@/lib/v2";
import { viewKind } from "@/lib/viewing";

type View = "rendered" | "raw";
const VIEWS: { id: View; label: string }[] = [{ id: "rendered", label: "Rendered" }, { id: "raw", label: "Raw" }];

/** Rendered (Markdown, sanitized) or Raw (the file's exact text): a segmented pick, as Mission Control's range is. */
function ViewToggle({ view, onView }: { view: View; onView: (view: View) => void }) {
  return (
    <div className="flex" role="radiogroup" aria-label="View">
      {VIEWS.map((v) => (
        <label key={v.id} className={cn("caps -ml-px cursor-pointer border px-3 py-1.5 text-[11px] first:ml-0 has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-2", view === v.id ? "relative border-foreground bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
          <input type="radio" name="file-view" value={v.id} checked={view === v.id} onChange={() => onView(v.id)} className="sr-only" />{v.label}
        </label>
      ))}
    </div>
  );
}

/** The run's FILES tab: what it wrote, in the server's path order, each opened in the viewer. */
export function RunFiles({ files, onOpen }: { files: RunFile[]; onOpen: (file: RunFile) => void }) {
  const total = files.reduce((n, f) => n + f.size_bytes, 0);
  return (
    <section>
      <p className="caps mb-2 flex items-center gap-2 text-[11px] text-muted-foreground"><Folder className="size-3.5" aria-hidden /> Files · {files.length} {files.length === 1 ? "file" : "files"} ({bytes(total)})</p>
      {files.length === 0 ? (
        <p className="border px-4 py-8 text-center font-mono text-[13px] text-muted-foreground">This run wrote no files.</p>
      ) : (
        <ul className="border">
          {files.map((f) => (
            <li key={f.path} className="border-b last:border-b-0">
              <button type="button" onClick={() => onOpen(f)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent">
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{f.path}</span>
                <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{when(f.modified_at)}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{bytes(f.size_bytes)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The file viewer: the file's name, Copy, Download and its characters. Text and Markdown show here, Rendered (Markdown,
 *  sanitized) or Raw (the exact text, each line its own, in monospace): a Markdown file opens Rendered, any other text
 *  Raw, and the toggle switches either. Anything else is offered as a download only. */
export function ArtifactViewer({ file, text, onClose }: { file: RunFile; text: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  // A native modal dialog: focus moves in and stays in, the page behind is inert, Escape closes it, and focus goes back
  // to what opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const d = dialog.current;
    if (d && !d.open) d.showModal?.();
    return () => { d?.open && d.close(); opener?.focus?.(); };
  }, []);
  // The dimmed area around the file is the dialog itself (the file's panel sits inside it): a click that starts and ends
  // there closes it, as the console's other overlays do. One that starts or ends inside keeps it: a drag either way sends
  // its click to the dialog (the nearest element both ends are in), so where the press and the release were is checked.
  const pressedOutside = useRef(false);
  const releasedOutside = useRef(false);
  const kind = viewKind(file);
  const [view, setView] = useState<View>(kind === "markdown" ? "rendered" : "raw");
  const download = () => {
    if (text === null) return;
    const url = URL.createObjectURL(new Blob([text], { type: file.content_type ?? "application/octet-stream" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: file.path.split("/").pop() });
    a.click(); URL.revokeObjectURL(url);
  };
  return (
    <dialog ref={dialog} aria-label={file.path} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onMouseDown={(e) => { pressedOutside.current = e.target === e.currentTarget; }}
      onMouseUp={(e) => { releasedOutside.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (pressedOutside.current && releasedOutside.current && e.target === e.currentTarget) onClose(); pressedOutside.current = releasedOutside.current = false; }}
      className="m-0 h-full max-h-none w-full max-w-none border-0 bg-transparent p-0 text-foreground backdrop:bg-black/60 md:p-8">
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col border bg-background">
        {/* On a phone the toggle takes a row of its own under the rest, so Copy and Download stay on screen. */}
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close"><X aria-hidden /></Button>
          <FileText className="size-4 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{file.path}</span>
          {kind !== "download" && <div className="order-last basis-full sm:order-none sm:basis-auto"><ViewToggle view={view} onView={setView} /></div>}
          <Button size="sm" disabled={text === null} onClick={async () => { if (text !== null) { await navigator.clipboard?.writeText(text); setCopied(true); } }}><Copy aria-hidden /> {copied ? "Copied" : "Copy"}</Button>
          <Button size="sm" disabled={text === null} onClick={download}><Download aria-hidden /> Download</Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-8 md:px-16">
          {text === null ? <p className="font-mono text-[13px] text-muted-foreground">Loading the file...</p>
            : kind === "download" ? <p className="font-mono text-[13px] text-muted-foreground">This file type is not shown here. Download it to open it.</p>
            : view === "rendered" ? <article className="report mx-auto max-w-3xl" dangerouslySetInnerHTML={{ __html: markdown(text) }} />
            : <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.8]">{text}</pre>}
        </div>
        <footer className="border-t px-4 py-2 font-mono text-[11px] text-muted-foreground">File · {text === null ? "..." : `${text.length.toLocaleString("en-US")} characters`} · {file.content_type ?? "unknown type"}</footer>
      </div>
    </dialog>
  );
}
