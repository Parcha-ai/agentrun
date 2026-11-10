import { Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { bytes } from "@/lib/format";
import { refusalOf, type Upload } from "@/lib/uploads";
import { cn } from "@/lib/utils";
import type { Capabilities } from "@/lib/client";

/** This server's upload limits (capabilities' `limits`): the largest file, and the most files one run names. Absent on a
 *  server that says nothing, and then nothing is checked here. */
/** The server's own limits (capabilities' `limits`): the largest upload (null: none), the most files a run names. */
export type UploadLimits = Partial<Pick<NonNullable<Capabilities["limits"]>, "max_upload_bytes" | "max_files_per_run">>;

/** One file the person picked: sending (`progress` 0 to 1), or sent (`file`), and `removing` while its delete is asked. */
export type Attached = { key: string; name: string; size: number; progress: number; file?: { file_id: string }; removing?: boolean };
/** A line under the picker; `about`: the file it is about, so a later delete of that file that works takes it away. */
type Said = { about?: string; text: string };

/** The files a run will name, for a start screen: each picked file is sent at once, all in parallel, and is named by the
 *  run (`fileIds`) once the server has it. A file over the server's largest upload, or past its most files a run, is
 *  refused here, before anything is sent; a refusal the server gives is said in its words, with the file's name.
 *  - Removing a file stops its send, or deletes it from the server when it was sent (`remove`). A sent file stays on the
 *    page until the server deletes it: a delete that fails says why, and Remove tries again.
 *  - `frozen`: a start that names these files is under way: no file is added or removed until it answers.
 *  - `clear` forgets every file after a run started with them (the run has its own copies; the uploads stay on the server).
 *  - A screen left with sent files no run named deletes them; a start under way keeps its own. */
export function useAttachments({ upload, remove, limits = {}, frozen = false }: { upload: Upload; remove?: (fileId: string) => Promise<unknown>; limits?: UploadLimits; frozen?: boolean }) {
  const [items, setItems] = useState<Attached[]>([]);
  const [said, setSaid] = useState<Said[]>([]);
  const sending = useRef(new Map<string, AbortController>());
  const next = useRef(0);
  // The count as of the last pick, so two picks in one tick both see the files before them.
  const count = useRef(0);
  count.current = items.length;
  // What the callbacks and the unmount see: the files on the page, whether a start holds them, and how to delete one.
  const now = useRef({ items, frozen, remove });
  now.current = { items, frozen, remove };
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const inFlight = sending.current;
    return () => {
      live.current = false;
      for (const c of inFlight.values()) c.abort();
      const { items: left, frozen: held, remove: del } = now.current;
      if (!held) for (const x of left) if (x.file && !x.removing) void del?.(x.file.file_id)?.catch(() => {});
    };
  }, []);
  const add = useCallback((files: File[]) => {
    if (now.current.frozen) return;
    const refused: Said[] = [];
    const room = limits.max_files_per_run === undefined ? Infinity : limits.max_files_per_run - count.current;
    const taken: File[] = [];
    for (const f of files) {
      if (limits.max_upload_bytes != null && f.size > limits.max_upload_bytes) refused.push({ text: `${f.name} is ${bytes(f.size)}: this server takes files up to ${bytes(limits.max_upload_bytes)}.` });
      else if (taken.length >= room) refused.push({ text: `${f.name} is not added: a run names at most ${limits.max_files_per_run} files here.` });
      else taken.push(f);
    }
    setSaid(refused);
    const added = taken.map((f) => ({ key: `f${next.current++}`, name: f.name, size: f.size, progress: 0 }));
    count.current += added.length;
    setItems((xs) => [...xs, ...added]);
    added.forEach((item, i) => {
      const control = new AbortController();
      sending.current.set(item.key, control);
      const set = (patch: Partial<Attached>) => { if (live.current) setItems((xs) => xs.map((x) => (x.key === item.key ? { ...x, ...patch } : x))); };
      upload(taken[i]!, (progress) => set({ progress }), control.signal).then(
        (file) => {
          sending.current.delete(item.key);
          // Removed while it was sent: the server keeps a file nobody will name, so it goes there too.
          if (control.signal.aborted) {
            void now.current.remove?.(file.file_id)?.catch((e) => {
              if (live.current) setSaid((rs) => [...rs, { text: `${item.name} was sent before it was stopped, and was not removed: ${refusalOf(e)}` }]);
            });
            return;
          }
          set({ file, progress: 1 });
        },
        (e) => {
          sending.current.delete(item.key);
          if (control.signal.aborted || !live.current) return;
          setItems((xs) => xs.filter((x) => x.key !== item.key));
          setSaid((rs) => [...rs, { text: `${item.name}: ${refusalOf(e)}` }]);
        },
      );
    });
  }, [limits.max_files_per_run, limits.max_upload_bytes, upload]);
  const drop = useCallback((key: string) => {
    const { items: shown, frozen: held, remove: del } = now.current;
    const item = shown.find((x) => x.key === key);
    if (held || !item || item.removing) return;
    if (!item.file || !del) {
      sending.current.get(key)?.abort();
      sending.current.delete(key);
      setItems((xs) => xs.filter((x) => x.key !== key));
      return;
    }
    setItems((xs) => xs.map((x) => (x.key === key ? { ...x, removing: true } : x)));
    setSaid((rs) => rs.filter((r) => r.about !== key));
    del(item.file.file_id).then(
      () => { if (live.current) setItems((xs) => xs.filter((x) => x.key !== key)); },
      (e) => {
        if (!live.current) return;
        setItems((xs) => xs.map((x) => (x.key === key ? { ...x, removing: false } : x)));
        setSaid((rs) => [...rs, { about: key, text: `${item.name} was not removed: ${refusalOf(e)}` }]);
      },
    );
  }, []);
  const clear = useCallback(() => {
    // The screen may go in the same tick (the run's page opens): what the unmount sees is cleared now, not at the next render.
    now.current = { ...now.current, items: [] };
    setItems([]); setSaid([]);
  }, []);
  const fileIds = items.flatMap((x) => (x.file && !x.removing ? [x.file.file_id] : []));
  return { items, refusals: said.map((r) => r.text), add, drop, clear, fileIds, frozen, busy: items.some((x) => !x.file || x.removing) };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** The start screens' file picker: a button and a drop zone, each picked file a chip with its size (and how much is sent
 *  while it is), a way to remove it, the limits under it, and any refusal in the server's words. `compact`: on a phone
 *  (< 640 px) the drop zone folds to its button alone, an icon with the limits in its title (a phone drops no files); the
 *  chips and refusals still show under it. 640 px and up are unchanged. */
export function FilePicker({ attachments, limits = {}, disabled, compact = false }: { attachments: Attachments; limits?: UploadLimits; disabled?: boolean; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { items, refusals, add, drop } = attachments;
  // Nothing changes while a start that names these files is under way.
  const off = disabled || attachments.frozen;
  const said = [limits.max_files_per_run !== undefined ? `up to ${limits.max_files_per_run} files` : null, limits.max_upload_bytes != null ? `${bytes(limits.max_upload_bytes)} each` : null].filter(Boolean).join(", ");
  return (
    <div
      className={cn("border border-dashed px-3 py-2.5", over ? "border-primary bg-primary/5" : "border-border", compact && "max-sm:border-0 max-sm:p-0")}
      onDragOver={(e) => { if (off) return; e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!off) add([...e.dataTransfer.files]); }}
      role="group"
      aria-label="Files for the run"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => input.current?.click()} disabled={off} title={compact ? `Attach files${said ? ` (${said})` : ""}` : undefined} className={cn(compact && "max-sm:h-10 max-sm:w-10 max-sm:px-0")}>
          <Paperclip aria-hidden /> <span className={cn(compact && "max-sm:sr-only")}>Attach files</span>
        </Button>
        <span className={cn("text-[12px] text-muted-foreground", compact && "max-sm:hidden")}>or drop them here{said ? ` (${said})` : ""}. The run finds them in inputs/.</span>
        <input ref={input} type="file" multiple hidden aria-label="Pick files" onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </div>
      {items.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attached files">
          {items.map((x) => (
            <li key={x.key} className="flex h-7 items-center gap-2 border bg-card px-2 font-mono text-[12px]">
              <span className="max-w-[16rem] truncate" title={x.name}>{x.name}</span>
              <span className="text-muted-foreground">{bytes(x.size)}</span>
              {!x.file && <span className="text-muted-foreground" aria-label={`${x.name} sent ${Math.round(x.progress * 100)}%`}>{Math.round(x.progress * 100)}%</span>}
              {x.removing && <span className="text-muted-foreground">removing</span>}
              <button type="button" onClick={() => drop(x.key)} disabled={off || x.removing} aria-label={`Remove ${x.name}`} className="text-muted-foreground hover:text-foreground disabled:opacity-45"><X className="size-3.5" aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
      {items.some((x) => !x.file) && <p className="mt-2 text-[12px] text-muted-foreground" role="status">The run can start once every file is sent.</p>}
      {refusals.length > 0 && <ul className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{refusals.map((r, i) => <li key={`${i}:${r}`}>{r}</li>)}</ul>}
    </div>
  );
}
