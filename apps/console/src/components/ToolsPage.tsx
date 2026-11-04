import { useEffect, useRef, useState } from "react";
import { RunError } from "@/components/RunError";
import { PerHarness, ToolTable } from "@/components/ToolSettings";
import { type Client, ClientError } from "@/lib/client";
import { issuesFor, ownSettings, type ToolChoice } from "@/lib/toolSettings";
import type { ApiError, ToolSettings } from "@/lib/v2";

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });

/** Settings → Tools: this server's provider per capability that has a choice (`choices`, from capabilities), which every
 *  agent without its own takes, and what each resolves to on each harness. A change is saved at once (PUT), and
 *  `onSaved` reads the capabilities again: what each capability resolves to is the server's to say. `onOpen` reads them as
 *  the page opens, since the settings it reads may be newer than capabilities read earlier (another tab's change); until
 *  capabilities name the provider a row shows, its resolution reads "reading…", and a read that failed says so with
 *  Retry (`onOpen` answers whether its read landed). */
export function ToolsPage({ v2, choices, onSaved, onOpen }: { v2: Client; choices: ToolChoice[]; onSaved: () => void; onOpen?: () => Promise<boolean> | void }) {
  const [answer, setAnswer] = useState<ToolSettings | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState<{ fields: Record<string, string>; error: ApiError | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  const load = () => {
    const n = ++asked.current;
    v2.toolSettings().then((s) => { if (n === asked.current) { setAnswer(s); setLoadError(null); } }, (e) => { if (n === asked.current) setLoadError(apiError(e)); });
  };
  useEffect(load, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  // Where the last capabilities read this page asked for stands: under way, failed, or landed. Once it has ended, a row
  // its answer still doesn't cover (it failed, or the provider moved again between the two reads) offers Retry, which
  // reads the settings and the capabilities again; only while it is under way does a row say "reading…".
  const [capsRead, setCapsRead] = useState<"reading" | "failed" | "landed">("reading");
  const readCaps = () => { setCapsRead("reading"); void Promise.resolve(onOpen?.()).then((ok) => setCapsRead(ok === false ? "failed" : "landed")); };
  const retry = () => { load(); readCaps(); };
  useEffect(readCaps, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!answer) return loadError
    ? (
      <div className="m-8 border p-4" role="alert">
        <p className="font-mono text-[13px] text-destructive-text">The tool settings could not be read: {loadError.code}: {loadError.message}</p>
        <button type="button" onClick={load} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>
      </div>
    )
    : <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading...</p>;
  const own = ownSettings(answer, choices);
  const { byTool, rest } = issuesFor(problem?.fields ?? {}, "", choices.map((t) => t.name));
  // Each change is the whole of the server's settings: a capability the body leaves out takes its default.
  const save = async (next: ToolSettings) => {
    setBusy(true); setProblem(null);
    // A save's answer is the newest settings: a read still out (a Retry's) is dropped, never put back over it.
    const n = ++asked.current;
    try {
      const saved = await v2.saveToolSettings(next);
      if (n === asked.current) setAnswer(saved);
      onSaved();
    } catch (e) {
      setProblem(e instanceof ClientError && e.status === 422 && e.fields?.length
        ? { fields: Object.fromEntries(e.fields.map((f) => [f.field, f.message])), error: null }
        : { fields: {}, error: apiError(e) });
    }
    setBusy(false);
  };
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        <div>
          <p className="caps text-[11px] text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">Tools</h1>
          <p className="mt-2 text-[14px] text-muted-foreground">This server's provider for each tool that has a choice, and what it resolves to on each harness. A change is saved at once and applies to every run launched from then on. An agent with a provider of its own keeps it.</p>
        </div>
        <section aria-label="This server's providers">
          {choices.length ? (
            <ToolTable label="This server's tool providers" rows={choices} settings={own} fallbackOf={(t) => t.default_provider} issues={byTool} busy={busy} onChange={(next) => void save(next)}
              resolvesOf={(t, provider) => (provider === t.provider ? <PerHarness choice={t} />
                : capsRead === "reading" ? <span className="block font-mono text-[12px] text-muted-foreground">reading…</span>
                : <span className="block text-[12px] text-muted-foreground">{capsRead === "failed" ? "What it resolves to couldn't be read." : "It changed while this page read it."} <button type="button" onClick={retry} disabled={busy} className="caps ml-1 border px-2 py-0.5 text-[11px] hover:bg-accent disabled:opacity-45">Retry</button></span>)} />
          ) : <p className="border px-3 py-4 font-mono text-[13px] text-muted-foreground">This server offers no tool with a choice of provider.</p>}
          {rest.map((m) => <p key={m} className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{m}</p>)}
          {problem?.error && <div className="mt-3 border"><RunError error={problem.error} title="The change was not saved" /></div>}
        </section>
      </div>
    </div>
  );
}
