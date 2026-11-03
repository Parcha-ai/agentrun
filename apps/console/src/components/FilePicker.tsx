import { Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { bytes } from "@/lib/format";
import { refusalOf, type Upload } from "@/lib/uploads";
import { cn } from "@/lib/utils";

/** This server's upload limits (capabilities' `limits`): the largest file, and the most files one run names. Absent on a
 *  server that says nothing, and then nothing is checked here. */
export type UploadLimits = { max_upload_bytes?: number; max_files_per_run?: number };

/** One file the person picked: sending (`progress` 0 to 1), or sent (`file`). */
export type Attached = { key: string; name: string; size: number; progress: number; file?: { file_id: string } };

/** The files a run will name, for a start screen: each picked file is sent at once, all in parallel, and is named by the
 *  run (`fileIds`) once the server has it. A file over the server's largest upload, or past its most files a run, is
 *  refused here, before anything is sent; a refusal the server gives is said in its words, with the file's name. Removing
 *  a file stops its send, or deletes it from the server when it was sent (`remove`); `clear` forgets every file after a
 *  run started with them (the run keeps its own copies). */
export function useAttachments({ upload, remove, limits = {} }: { upload: Upload; remove?: (fileId: string) => Promise<unknown>; limits?: UploadLimits }) {
  const [items, setItems] = useState<Attached[]>([]);
  const [refusals, setRefusals] = useState<string[]>([]);
  const sending = useRef(new Map<string, AbortController>());
  const next = useRef(0);
  // The count as of the last pick, so two picks in one tick both see the files before them.
  const count = useRef(0);
  count.current = items.length;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const inFlight = sending.current;
    return () => { live.current = false; for (const c of inFlight.values()) c.abort(); };
  }, []);
  const add = useCallback((files: File[]) => {
    const said: string[] = [];
    const room = limits.max_files_per_run === undefined ? Infinity : limits.max_files_per_run - count.current;
    const taken: File[] = [];
    for (const f of files) {
      if (limits.max_upload_bytes !== undefined && f.size > limits.max_upload_bytes) said.push(`${f.name} is ${bytes(f.size)}: this server takes files up to ${bytes(limits.max_upload_bytes)}.`);
      else if (taken.length >= room) said.push(`${f.name} is not added: a run names at most ${limits.max_files_per_run} files here.`);
      else taken.push(f);
    }
    setRefusals(said);
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
          if (control.signal.aborted) { void remove?.(file.file_id)?.catch(() => {}); return; }
          set({ file, progress: 1 });
        },
        (e) => {
          sending.current.delete(item.key);
          if (control.signal.aborted || !live.current) return;
          setItems((xs) => xs.filter((x) => x.key !== item.key));
          setRefusals((rs) => [...rs, `${item.name}: ${refusalOf(e)}`]);
        },
      );
    });
  }, [limits.max_files_per_run, limits.max_upload_bytes, remove, upload]);
  const drop = useCallback((key: string) => {
    const item = items.find((x) => x.key === key);
    sending.current.get(key)?.abort();
    sending.current.delete(key);
    setItems((xs) => xs.filter((x) => x.key !== key));
    if (item?.file) void remove?.(item.file.file_id)?.catch(() => {});
  }, [items, remove]);
  const clear = useCallback(() => { setItems([]); setRefusals([]); }, []);
  const fileIds = items.flatMap((x) => (x.file ? [x.file.file_id] : []));
  return { items, refusals, add, drop, clear, fileIds, busy: items.some((x) => !x.file) };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** The start screens' file picker: a button and a drop zone, each picked file a chip with its size (and how much is sent
 *  while it is), a way to remove it, the limits under it, and any refusal in the server's words. */
export function FilePicker({ attachments, limits = {}, disabled }: { attachments: Attachments; limits?: UploadLimits; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { items, refusals, add, drop } = attachments;
  const said = [limits.max_files_per_run !== undefined ? `up to ${limits.max_files_per_run} files` : null, limits.max_upload_bytes !== undefined ? `${bytes(limits.max_upload_bytes)} each` : null].filter(Boolean).join(", ");
  return (
    <div
      className={cn("border border-dashed px-3 py-2.5", over ? "border-primary bg-primary/5" : "border-border")}
      onDragOver={(e) => { if (disabled) return; e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) add([...e.dataTransfer.files]); }}
      role="group"
      aria-label="Files for the run"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => input.current?.click()} disabled={disabled}><Paperclip aria-hidden /> Attach files</Button>
        <span className="text-[12px] text-muted-foreground">or drop them here{said ? ` (${said})` : ""}. The run finds them in inputs/.</span>
        <input ref={input} type="file" multiple hidden aria-label="Pick files" onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </div>
      {items.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attached files">
          {items.map((x) => (
            <li key={x.key} className="flex h-7 items-center gap-2 border bg-card px-2 font-mono text-[12px]">
              <span className="max-w-[16rem] truncate" title={x.name}>{x.name}</span>
              <span className="text-muted-foreground">{bytes(x.size)}</span>
              {!x.file && <span className="text-muted-foreground" aria-label={`${x.name} sent ${Math.round(x.progress * 100)}%`}>{Math.round(x.progress * 100)}%</span>}
              <button type="button" onClick={() => drop(x.key)} aria-label={`Remove ${x.name}`} className="text-muted-foreground hover:text-foreground"><X className="size-3.5" aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
      {refusals.length > 0 && <ul className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{refusals.map((r, i) => <li key={`${i}:${r}`}>{r}</li>)}</ul>}
    </div>
  );
}
