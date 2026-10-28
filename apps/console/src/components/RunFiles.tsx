import { Copy, Download, FileText, Folder, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { bytes, markdown, when } from "@/lib/format";
import type { RunFile } from "@/lib/v2";
import { viewKind } from "@/lib/viewing";

/** The run's FILES tab: what it wrote, newest first, each opened in the viewer. */
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

/** The file viewer: the file's name, Copy, Download and its characters. Text and Markdown render here (Markdown
 *  sanitized); anything else is offered as a download only. */
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
  const kind = viewKind(file);
  const download = () => {
    if (text === null) return;
    const url = URL.createObjectURL(new Blob([text], { type: file.content_type ?? "application/octet-stream" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: file.path.split("/").pop() });
    a.click(); URL.revokeObjectURL(url);
  };
  return (
    <dialog ref={dialog} aria-label={file.path} onCancel={(e) => { e.preventDefault(); onClose(); }}
      className="m-0 h-full max-h-none w-full max-w-none border-0 bg-transparent p-0 text-foreground backdrop:bg-black/60 md:p-8">
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col border bg-background">
        <header className="flex items-center gap-3 border-b px-4 py-2.5">
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close"><X aria-hidden /></Button>
          <FileText className="size-4 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{file.path}</span>
          <Button size="sm" disabled={text === null} onClick={async () => { if (text !== null) { await navigator.clipboard?.writeText(text); setCopied(true); } }}><Copy aria-hidden /> {copied ? "Copied" : "Copy"}</Button>
          <Button size="sm" disabled={text === null} onClick={download}><Download aria-hidden /> Download</Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-8 md:px-16">
          {text === null ? <p className="font-mono text-[13px] text-muted-foreground">Loading the file...</p>
            : kind === "markdown" ? <article className="report mx-auto max-w-3xl" dangerouslySetInnerHTML={{ __html: markdown(text) }} />
            : kind === "text" ? <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.8]">{text}</pre>
            : <p className="font-mono text-[13px] text-muted-foreground">This file type is not shown here. Download it to open it.</p>}
        </div>
        <footer className="border-t px-4 py-2 font-mono text-[11px] text-muted-foreground">File · {text === null ? "..." : `${text.length.toLocaleString("en-US")} characters`} · {file.content_type ?? "unknown type"}</footer>
      </div>
    </dialog>
  );
}
