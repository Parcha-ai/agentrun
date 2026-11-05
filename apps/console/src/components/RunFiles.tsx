import DOMPurify from "dompurify";
import { Copy, Download, FileText, Folder, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { bytes, markdown, openLinkedFile, when } from "@/lib/format";
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
export function RunFiles({ files, complete = true, truncated = false, loading = false, onOpen }: { files: RunFile[]; complete?: boolean; truncated?: boolean; loading?: boolean; onOpen: (file: RunFile) => void }) {
  if (loading) return <section aria-busy="true"><p className="border px-4 py-8 text-center font-mono text-[13px] text-muted-foreground" role="status">Reading the files...</p></section>;
  const total = files.reduce((n, f) => n + f.size_bytes, 0);
  return (
    <section>
      <p className="caps mb-2 flex items-center gap-2 text-[11px] text-muted-foreground"><Folder className="size-3.5" aria-hidden /> Files · {files.length} {files.length === 1 ? "file" : "files"} ({bytes(total)})</p>
      {(!complete || truncated) && <p className="mb-3 text-[13px] text-warning-text">Partial file list. {truncated ? "The server limited this listing." : "The server could not read every file."}</p>}
      {files.length === 0 ? (
        <p className="border px-4 py-8 text-center font-mono text-[13px] text-muted-foreground">{complete && !truncated ? "This run wrote no files." : "No files are available in this partial listing."}</p>
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

/** Authenticated file bytes, downloaded intact. Supported media render locally; HTML is sanitized in a sandbox. */
export function ArtifactViewer({ file, text, blob, error, onRetry, onClose, files = [], onOpen }: { file: RunFile; text: string | null; blob?: Blob; error?: string; onRetry?: () => void; onClose: () => void; files?: RunFile[]; onOpen?: (file: RunFile) => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  useEffect(() => { setCopied(false); setCopyError(null); }, [file.path, text]);
  const copy = async () => {
    if (text === null) return;
    setCopied(false); setCopyError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (e) { setCopyError(e instanceof Error ? e.message : String(e)); }
  };
  const dialog = useRef<HTMLDialogElement>(null);
  // A native modal dialog: focus moves in and stays in, the page behind is inert, Escape closes it, and focus goes back
  // to what opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const d = dialog.current;
    if (d && !d.open) d.showModal?.();
    return () => { d?.open && d.close(); opener?.focus?.(); };
  }, []);
  // A link in a Markdown file can open another file in this viewer: Copied belongs to the file it was said of.
  useEffect(() => setCopied(false), [file.path]);
  // The dimmed area around the file is the dialog itself (the file's panel sits inside it): a click that starts and ends
  // there closes it, as the console's other overlays do. One that starts or ends inside keeps it: a drag either way sends
  // its click to the dialog (the nearest element both ends are in), so where the press and the release were is checked.
  const pressedOutside = useRef(false);
  const releasedOutside = useRef(false);
  const kind = viewKind(file);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob && text === null) { setUrl(null); return; }
    const url = URL.createObjectURL(blob ?? new Blob([text!], { type: file.content_type ?? "application/octet-stream" }));
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [blob, text, file.content_type]);
  const [view, setView] = useState<View>(kind === "markdown" ? "rendered" : "raw");
  // A link can move this viewer to another file: that file starts as its own kind does, not as the last one was left.
  useEffect(() => setView(kind === "markdown" ? "rendered" : "raw"), [file.path]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = openLinkedFile((path) => { const f = files.find((x) => x.path === path); if (f) onOpen?.(f); });
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
          {["markdown", "text"].includes(kind) && <div className="order-last basis-full sm:order-none sm:basis-auto"><ViewToggle view={view} onView={setView} /></div>}
          <Button size="sm" disabled={text === null || !["markdown", "text", "html"].includes(kind)} onClick={() => void copy()}><Copy aria-hidden /> {copied ? "Copied" : "Copy"}</Button>
          {url ? <a href={url} download={file.path.split("/").pop()} className="inline-flex items-center gap-2 border px-3 py-2 text-[12px]"><Download className="size-4" aria-hidden /> Download</a> : <Button size="sm" disabled><Download aria-hidden /> Download</Button>}
        </header>
        {copyError && <p className="border-b px-4 py-3 text-[13px] text-destructive-text" role="alert">File could not be copied: {copyError}</p>}
        <div className="min-h-0 flex-1 overflow-auto px-6 py-8 md:px-16">
          {error ? <div role="alert"><p className="text-[13px] text-destructive-text">{error}</p><Button size="sm" className="mt-3" onClick={onRetry}>Try again</Button></div> : text === null ? <p className="font-mono text-[13px] text-muted-foreground">Loading the file...</p>
            : kind === "image" && url ? <img src={url} alt={file.path} className="mx-auto max-h-full max-w-full" />
            : kind === "audio" && url ? <audio src={url} controls aria-label={file.path} className="w-full" />
            : kind === "video" && url ? <video src={url} controls aria-label={file.path} className="max-h-full w-full" />
            : kind === "html" ? <iframe title={file.path} sandbox="" referrerPolicy="no-referrer" className="h-full min-h-96 w-full border" srcDoc={'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; form-action \'none\'">' + DOMPurify.sanitize(text)} />
            : (kind === "markdown" || kind === "text") && view === "rendered" ? <article className="report mx-auto max-w-3xl" onClick={open}
                dangerouslySetInnerHTML={{ __html: markdown(text, onOpen && { paths: files.map((f) => f.path), from: file.path.split("/").slice(0, -1).join("/") }) }} />
            : kind === "markdown" || kind === "text" ? <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.8]">{text}</pre>
            : <p className="font-mono text-[13px] text-muted-foreground">This file type is not shown here. Download it to open it.</p>}
        </div>
        <footer className="border-t px-4 py-2 font-mono text-[11px] text-muted-foreground">File · {text === null ? "..." : blob ? bytes(blob.size) : `${text.length.toLocaleString("en-US")} characters`} · {file.content_type ?? "unknown type"}</footer>
      </div>
    </dialog>
  );
}
