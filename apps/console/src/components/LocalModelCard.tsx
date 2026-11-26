import { Cpu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { type Client, ClientError } from "@/lib/client";
import { bytes } from "@/lib/format";
import type { LocalModel } from "@/lib/v2";

/** How often the card reads the pull's progress while it runs. */
export const PULL_POLL_MS = 1_000;

/** Which of its five faces the card shows: `unknown` before the machine is read or when it could not be; `recommend`, a
 *  tag to pull; `pulling`; `ready`, the tag pulled and this server's model; `none`, nothing fits or no Ollama runs. */
export type LocalModelState = "unknown" | "recommend" | "pulling" | "ready" | "none";

export function localModelState(view: LocalModel | null): LocalModelState {
  if (!view) return "unknown";
  if (view.pull?.state === "pulling") return "pulling";
  if (view.recommended.tag === null) return "none";
  if (view.recommended.pulled || (view.pull?.state === "done" && view.pull.tag === view.recommended.tag)) return "ready";
  return "recommend";
}

const OS: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/** The machine in one line: its system, memory, GPU and Ollama. */
export function machineLine(view: LocalModel): string {
  const { machine, ollama } = view;
  const gpu = machine.gpu.kind === "apple" ? "Apple silicon, unified memory" : machine.gpu.kind === "nvidia" ? `${machine.gpu.name}, ${bytes(machine.gpu.memory_bytes)}` : "GPU not read";
  // Under the faux model or a model gateway this server asks no Ollama, so the line says nothing of one.
  const asked = ollama.asked === false ? [] : [ollama.reachable ? `Ollama ${ollama.version}` : "no Ollama running"];
  return [`${OS[machine.platform] ?? machine.platform} ${machine.arch}`, `${bytes(machine.ram_bytes)} memory`, gpu, ...asked].join(" · ");
}

/** The first screen's "Free local model" card, beside the model key card while this server has no model: what this
 *  machine can run (GET /settings/local-model), one click to pull it through the owner's own Ollama (POST
 *  /settings/local-model/pull) with its progress, then ready. `onReady(tag)`, once per tag a pull here ends: the caller
 *  reads the capabilities again and picks `ollama/<tag>`; `onDone`, the person is done with the card once it is ready;
 *  `onPulling`, each time it sees a pull under way here: the caller keeps the card up from then until `onDone`, so a
 *  capabilities read that finds the model before the card's own progress read does never takes it down unreadied.
 *  Under the faux model or a model gateway (`ollama.asked` false) its only words are the refusal. A server without the
 *  route (404) or a caller who is not the owner shows no card. `pollMs`: how often a pull's progress is read (a test's 0). */
export function LocalModelCard({ v2, onReady, onDone, onPulling, pollMs = PULL_POLL_MS }: { v2: Client; onReady?: (tag: string) => void; onDone?: () => void; onPulling?: () => void; pollMs?: number }) {
  const [view, setView] = useState<LocalModel | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [starting, setStarting] = useState(false);
  const readied = useRef<string | null>(null);
  // Each read that ends, answered or not: a pull's next progress read waits on it, so a failed read (a dropped
  // connection) is followed by another, never the last while the pull goes on.
  const [reads, setReads] = useState(0);
  const read = async () => {
    try {
      setView(await v2.localModel());
      setProblem(null);
    } catch (e) {
      if (e instanceof ClientError && (e.status === 404 || e.status === 403 || e.status === 401)) setGone(true);
      else setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setReads((n) => n + 1);
    }
  };
  useEffect(() => { void read(); }, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = localModelState(view);
  // A card gone (the route or the owner refused a read) reads nothing more.
  useEffect(() => {
    if (gone || state !== "pulling") return;
    const timer = setTimeout(() => void read(), pollMs);
    return () => clearTimeout(timer);
  }, [view, reads, gone]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (state === "pulling") onPulling?.(); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ready once per tag: the capabilities read again, so the picker and the default have it.
  useEffect(() => {
    const tag = view?.recommended.tag;
    if (state === "ready" && tag && view?.pull?.state === "done" && readied.current !== tag) {
      readied.current = tag;
      onReady?.(tag);
    }
  }, [state, view]); // eslint-disable-line react-hooks/exhaustive-deps
  if (gone) return null;

  const pull = async (tag: string) => {
    setStarting(true);
    setProblem(null);
    try { setView(await v2.pullLocalModel(tag)); } catch (e) { setProblem(e instanceof Error ? e.message : String(e)); }
    finally { setStarting(false); }
  };
  const failed = view?.pull?.state === "failed" && view.pull.tag === view.recommended.tag ? view.pull.error ?? "The pull failed." : null;
  const progress = view?.pull?.state === "pulling" ? view.pull : null;
  const percent = progress && progress.total_bytes > 0 ? Math.min(100, Math.round((progress.completed_bytes / progress.total_bytes) * 100)) : 0;

  return (
    <section className="border-b bg-card px-5 py-5 md:px-8" aria-label="Free local model" data-local-model={state}>
      <div className="flex gap-3">
        <Cpu className="mt-1 size-4 shrink-0 text-primary-text" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="flex flex-wrap items-center gap-2 text-prose font-semibold">Free local model {view?.recommended.tag && <Chip tone={state === "ready" ? "success" : "plain"}>{view.recommended.tag}</Chip>}</h2>
          {view ? <p className="font-mono text-small text-muted-foreground" data-machine>{machineLine(view)}</p>
            : !problem && <p className="text-body text-muted-foreground" role="status">Reading this machine…</p>}
          {view && state !== "ready" && <p className="text-body text-muted-foreground">{view.ollama.asked === false ? view.refused ?? view.recommended.why : view.recommended.why}</p>}
          {state === "recommend" && view && (view.can_pull
            ? <Button type="button" size="sm" variant="primary" disabled={starting} onClick={() => void pull(view.recommended.tag!)}>{starting ? "Starting…" : failed ? "Try again" : `Pull ${view.recommended.tag}`}</Button>
            : <p className="text-body" role="status">{view.refused}</p>)}
          {progress && (
            <div className="space-y-1" role="status">
              <div className="h-2 w-full bg-muted" role="progressbar" aria-label={`Pulling ${progress.tag}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
              </div>
              <p className="font-mono text-small text-muted-foreground tabular-nums">{progress.status}{progress.total_bytes > 0 ? ` · ${bytes(progress.completed_bytes)} of ${bytes(progress.total_bytes)}` : ""}</p>
            </div>
          )}
          {state === "ready" && view && <>
            <p className="text-body text-success-text" role="status">Ready: {view.recommended.tag} runs here on this machine, at $0, and is this server's model for agents that name none.</p>
            {onDone && <Button type="button" size="sm" onClick={onDone}>Done</Button>}
          </>}
          {failed && state === "recommend" && <p className="font-mono text-body text-destructive-text" role="alert">The pull failed: {failed}</p>}
          {problem && (
            <div role="alert">
              <p className="font-mono text-body text-destructive-text">{view ? problem : `This machine could not be read: ${problem}`}</p>
              {!view && <Button type="button" size="sm" className="mt-2" onClick={() => void read()}>Try again</Button>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
