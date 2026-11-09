import { useEffect, useRef, useState } from "react";
import { RunError } from "@/components/RunError";
import { PerHarness, PinNote, ToolTable, toolRows } from "@/components/ToolSettings";
import { type Client, ClientError } from "@/lib/client";
import { issuesFor, ownSettings, type ToolChoice, type ToolGate } from "@/lib/toolSettings";
import type { ApiError, ToolSettings } from "@/lib/v2";

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });

/** Settings → Tools: this server's provider per capability that has a choice (`choices`, from capabilities), which every
 *  agent without its own takes, and what each resolves to on each harness. A change is saved at once (PUT), and
 *  `onSaved` reads the capabilities again: what each capability resolves to is the server's to say. `onOpen` reads them as
 *  the page opens, since the settings it reads may be newer than capabilities read earlier (another tab's change); until
 *  capabilities name the provider a row shows, its resolution reads "reading…", and a read that failed says so with
 *  Retry (`onOpen` answers whether its read landed). */
export function ToolsPage({ v2, choices, gates = [], onSaved, onOpen }: { v2: Client; choices: ToolChoice[]; gates?: ToolGate[]; onSaved: () => void; onOpen?: () => Promise<boolean> | void }) {
  const [answer, setAnswer] = useState<ToolSettings | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState<{ fields: Record<string, string>; error: ApiError | null; unread?: true } | null>(null);
  const [busy, setBusy] = useState(false);
  // A change not saved because the map couldn't be read first: kept, shown in the table, and saved by Try again.
  const [unsaved, setUnsaved] = useState<((current: ToolSettings) => ToolSettings) | null>(null);
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
  const read = ownSettings(answer, choices);
  // What the table shows: the settings read, with a change not saved yet on top.
  const own = unsaved ? unsaved(read) : read;
  const rows = toolRows(choices, gates);
  // The tools this server pins (an MCP tool's pin bounds its calls), or whose pin doesn't read, by settings key.
  const pinned = Object.entries(own).filter(([, s]) => s?.pin || s?.pin_broken);
  // Capabilities' word on what a tool resolves to holds only for the permission they were read with: one changed since
  // (deny: unavailable; ask: no search that can't wait) resolves once they are read again.
  const readFor = (name: string) => { const g = gates.find((x) => x.name === name); return !g || (own[name]?.permission ?? g.default_permission) === g.permission; };
  const { byTool, rest } = issuesFor(problem?.fields ?? {}, "", rows.map((t) => t.name));
  // Each save is the whole of the server's settings (a PUT replaces the map: a key the body leaves out takes its
  // defaults), so it is a read-modify-write: the map is read as it is now, the one field the person touched is changed,
  // and every other key and field (a permission, a provider, an MCP server's wildcard, one this console doesn't know)
  // goes back as it was.
  // A map that can't be read now is never replaced by an older one: one read earlier would drop a key another tab set
  // meanwhile. The save is refused, said so, and the change kept for Try again.
  const save = async (edit: (current: ToolSettings) => ToolSettings) => {
    const change = unsaved ? (current: ToolSettings) => edit(unsaved(current)) : edit;
    setBusy(true); setProblem(null);
    // A save's answer is the newest settings: a read still out (a Retry's) is dropped, never put back over it.
    const n = ++asked.current;
    let now: ToolSettings;
    try { now = await v2.toolSettings(); } catch {
      setUnsaved(() => change);
      setProblem({ fields: {}, error: null, unread: true });
      setBusy(false);
      return;
    }
    try {
      const saved = await v2.saveToolSettings(change(ownSettings(now, choices)));
      setUnsaved(null);
      if (n === asked.current) { setAnswer(saved); setLoadError(null); }
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
          {gates.length > 0 && <p className="mt-2 text-[14px] text-muted-foreground">Each tool's permission: <span className="font-mono text-[13px]">allow</span> runs it, <span className="font-mono text-[13px]">ask</span> makes the run wait for your approval at each call, <span className="font-mono text-[13px]">deny</span> refuses it and tells the agent why. A permission applies at the next call, in runs already going too. An agent with a permission of its own keeps it.</p>}
        </div>
        <section aria-label="This server's providers">
          {rows.length ? (
            <ToolTable label="This server's tool settings" rows={rows} settings={own} fallbackOf={(t) => t.default_provider} issues={byTool} busy={busy} onEdit={(edit) => void save(edit)}
              resolvesOf={(t, provider) => (provider === t.provider && readFor(t.name) ? <PerHarness choice={t} />
                : capsRead === "reading" ? <span className="block font-mono text-[12px] text-muted-foreground">reading…</span>
                : <span className="block text-[12px] text-muted-foreground">{capsRead === "failed" ? "What it resolves to couldn't be read." : "It changed while this page read it."} <button type="button" onClick={retry} disabled={busy} className="caps ml-1 border px-2 py-0.5 text-[11px] hover:bg-accent disabled:opacity-45">Retry</button></span>)} />
          ) : <p className="border px-3 py-4 font-mono text-[13px] text-muted-foreground">This server offers no tool with a choice of provider.</p>}
          {rest.map((m) => <p key={m} className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{m}</p>)}
          {problem?.error && <div className="mt-3 border"><RunError error={problem.error} title="The change was not saved" /></div>}
          {problem?.unread && (
            <div className="mt-3 border p-3" role="alert">
              <p className="font-mono text-[12px] text-destructive-text">Couldn't read the current settings, so nothing was saved. Try again.</p>
              <button type="button" onClick={() => void save((current) => current)} disabled={busy} className="caps mt-2 border px-3 py-1.5 text-[11px] hover:bg-accent disabled:opacity-60">Try again</button>
            </div>
          )}
          {/* A settings read that failed once the page shows settings: the table keeps the last ones read and says so, with
              Try again. A save's answer is newer, so it clears this. */}
          {loadError && (
            <div className="mt-3 border p-3" role="alert">
              <p className="font-mono text-[12px] text-destructive-text">The tool settings could not be read again: {loadError.code}: {loadError.message}</p>
              <p className="mt-1 text-[12px] text-muted-foreground">The table shows the last ones read.</p>
              <button type="button" onClick={retry} disabled={busy} className="caps mt-2 border px-3 py-1.5 text-[11px] hover:bg-accent disabled:opacity-60">Try again</button>
            </div>
          )}
        </section>
        {pinned.length > 0 && (
          <section aria-label="Pinned tools">
            <h2 className="caps text-[12px] font-semibold">Pinned tools</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">A pin bounds a tool's calls for every agent on this server, its own pin beside it.</p>
            <ul className="mt-2 border">
              {pinned.map(([name, setting]) => (
                <li key={name} data-pin={name} className="border-b px-3 py-2.5 last:border-b-0">
                  <p className="font-mono text-[13px]">{name}</p>
                  <PinNote setting={setting} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
