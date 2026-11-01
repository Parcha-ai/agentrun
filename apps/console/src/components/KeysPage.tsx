import { KeyRound, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { RunError } from "@/components/RunError";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { type Client, ClientError } from "@/lib/client";
import type { ApiError, ToolKey, ToolKeyField, ToolKeys, ToolKeysReenter } from "@/lib/v2";

const REASON: Record<ToolKeysReenter["reason"], string> = {
  seal_key_missing: "This server was started without its seal key, so the keys saved here can't be opened.",
  seal_key_changed: "This server's seal key changed since these keys were saved, so they can't be opened.",
  file_unreadable: "The file this server keeps the saved keys in is damaged, so they can't be opened.",
};

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });

function fieldState(f: ToolKeyField): string {
  if (f.source === "server") return "set · from the server";
  if (f.source === "stored") return "set · saved here";
  return f.stored_unreadable ? "saved here, can't be opened" : "not set";
}

/** Settings → Tool keys: each key a tool needs, where each of its fields is set, and a form to add, change or remove the
 *  one saved here. A value goes to the server and nowhere else: the inputs are never filled from it, never kept in the
 *  page's state, and cleared after a save or a cancel. `atRest` is capabilities' `features.tool_keys.at_rest`;
 *  `onChange` follows each save and removal (the server's tools may change with its keys). */
export function KeysPage({ v2, atRest, onChange }: { v2: Client; atRest?: "sealed" | "unavailable"; onChange?: () => void }) {
  const [view, setView] = useState<ToolKeys | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [noSealing, setNoSealing] = useState(false);
  const [open, setOpen] = useState<{ id: string; mode: "edit" | "remove" } | null>(null);
  const [problem, setProblem] = useState<{ id: string; title: string; error: ApiError } | null>(null);
  const asked = useRef(0);
  const load = () => {
    const n = ++asked.current;
    v2.listToolKeys()
      .then((v) => { if (n === asked.current) { setView(v); setLoadError(null); } })
      .catch((e) => { if (n === asked.current) setLoadError(apiError(e)); });
  };
  useEffect(load, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  const cantStore = atRest === "unavailable" || noSealing;
  // A write closes only the form that sent it: one opened on another row meanwhile keeps what was typed in it.
  const closeIf = (started: typeof open) => setOpen((o) => (o === started ? null : o));
  const done = (started: typeof open) => { closeIf(started); load(); onChange?.(); };
  const refused = (id: string, title: string, e: unknown, started: typeof open) => {
    // Nothing can be saved on this server: every form closes, and what was typed goes with it.
    if (e instanceof ClientError && e.code === "no_sealing_key") { setNoSealing(true); setOpen(null); return; }
    setProblem({ id, title, error: apiError(e) });
    // The server may know better than the list shown (a key its launcher now holds): read it again.
    if (e instanceof ClientError && e.code === "key_set_by_server") { closeIf(started); load(); }
  };

  if (!view) return loadError
    ? <ReadError error={loadError} onRetry={load} />
    : <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading...</p>;
  const reenter = view.reenter;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        <div>
          <p className="caps text-[11px] text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">Tool keys</h1>
          <p className="mt-2 text-[14px] text-muted-foreground">A tool's key, kept on this server for every agent that uses the tool. A saved key is never shown again.</p>
        </div>
        {loadError && <ReadError inline error={loadError} onRetry={load} />}
        {reenter && (
          <section className="flex gap-3 border border-warning/50 bg-warning/5 p-4" role="alert" aria-label="Keys to enter again">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />
            <div className="min-w-0 text-[13px]">
              <p className="caps text-[12px] font-semibold text-warning-text">Enter these keys again</p>
              <p className="mt-2">{REASON[reenter.reason]}</p>
              <p className="mt-2 font-mono">{reenter.fields.length ? reenter.fields.join(", ") : "Which keys it held is not known: enter again each key you had saved."}</p>
            </div>
          </section>
        )}
        {cantStore && (
          <p className="border bg-card p-4 font-mono text-[13px]" role="status">
            This server can't store keys: it was started without a seal key. Set each key where the server starts ({view.keys.flatMap((k) => k.fields.map((f) => f.name)).join(", ")}).
          </p>
        )}
        <ul className="border">
          {view.keys.map((k) => (
            <KeyRow key={k.id} tool={k} cantStore={cantStore} again={!!reenter && k.fields.some((f) => f.stored_unreadable || reenter.fields.includes(f.name))}
              open={open?.id === k.id ? open.mode : null} problem={problem?.id === k.id ? problem : null}
              onOpen={(mode) => { setOpen(mode ? { id: k.id, mode } : null); setProblem(null); }}
              onSave={async (values) => {
                const started = open;
                try { await v2.saveToolKey(k.id, values); } catch (e) {
                  if (e instanceof ClientError && e.status === 422) return e;
                  refused(k.id, "The key was not saved", e, started);
                  return null;
                }
                done(started);
                return null;
              }}
              onRemove={async () => {
                const started = open;
                try { await v2.removeToolKey(k.id); } catch (e) { refused(k.id, "The key was not removed", e, started); return; }
                done(started);
              }} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function ReadError({ error, onRetry, inline = false }: { error: ApiError; onRetry: () => void; inline?: boolean }) {
  return (
    <div className={inline ? "border p-4" : "m-8 border p-4"} role="alert">
      <p className="font-mono text-[13px] text-destructive-text">The tool keys could not be read: {error.code}: {error.message}</p>
      <button type="button" onClick={onRetry} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>
    </div>
  );
}

type RowProps = {
  tool: ToolKey;
  cantStore: boolean;
  again: boolean;
  open: "edit" | "remove" | null;
  problem: { title: string; error: ApiError } | null;
  onOpen: (mode: "edit" | "remove" | null) => void;
  /** Resolves with a 422 to show by field, else null (saved, or refused and said by the page). */
  onSave: (values: Record<string, string>) => Promise<ClientError | null>;
  onRemove: () => Promise<void>;
};

function KeyRow({ tool: k, cantStore, again, open, problem, onOpen, onSave, onRemove }: RowProps) {
  const own = k.fields.filter((f) => f.source !== "server");
  const setCount = k.fields.filter((f) => f.set).length;
  const saved = k.fields.some((f) => f.source === "stored" || f.stored_unreadable);
  return (
    <li className="border-b p-4 last:border-b-0">
      <div className="flex flex-wrap items-start gap-3">
        <KeyRound className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[15px] font-semibold">{k.label}</span>
            <Chip tone={setCount === k.fields.length ? "success" : "plain"}>{setCount === k.fields.length ? "set" : setCount ? `${setCount} of ${k.fields.length} set` : "not set"}</Chip>
            {again && <Chip tone="warning">enter again</Chip>}
          </p>
          <p className="mt-1.5 font-mono text-[12px] text-muted-foreground">
            Unlocks {k.unlocks.join(", ")} · Harnesses {k.harnesses.length === 1 ? `${k.harnesses[0]} only` : k.harnesses.join(", ")}
          </p>
          <ul className="mt-3 space-y-1">
            {k.fields.map((f) => (
              <li key={f.name} className="flex flex-wrap gap-x-3 font-mono text-[12px]">
                <span>{f.name}</span>
                <span className={f.stored_unreadable ? "text-warning-text" : f.set ? "text-success-text" : "text-muted-foreground"}>{fieldState(f)}</span>
              </li>
            ))}
          </ul>
          {!own.length && <p className="mt-3 text-[12px] text-muted-foreground">Set when the server starts, and that one wins: change it where the server is started.</p>}
        </div>
        {own.length > 0 && open === null && (
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={cantStore} onClick={() => onOpen("edit")}>{own.some((f) => f.set) ? "Change" : "Add key"}</Button>
            {saved && <Button size="sm" variant="destructive" onClick={() => onOpen("remove")}>Remove</Button>}
          </div>
        )}
      </div>
      {open === "edit" && <KeyForm tool={k} fields={own} cantStore={cantStore} onSave={onSave} onCancel={() => onOpen(null)} />}
      {open === "remove" && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border bg-card p-3">
          <p className="min-w-0 flex-1 text-[13px]">Remove the {k.label} key saved here?{k.fields.some((f) => f.source === "server") ? " The server's own stays." : ""}</p>
          <Button size="sm" variant="destructive" onClick={() => void onRemove()}>Remove</Button>
          <Button size="sm" onClick={() => onOpen(null)}>Keep</Button>
        </div>
      )}
      {problem && <div className="mt-4 border"><RunError error={problem.error} title={problem.title} /></div>}
    </li>
  );
}

/** One password input per field the page may set. The inputs are uncontrolled: React mirrors a controlled input's
 *  value into its `value` attribute, and a key must never be in the DOM. Only the fields typed in are sent. */
function KeyForm({ tool: k, fields, cantStore, onSave, onCancel }: { tool: ToolKey; fields: ToolKeyField[]; cantStore: boolean; onSave: RowProps["onSave"]; onCancel: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [typed, setTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<{ fields: Record<string, string>; message: string | null } | null>(null);
  const typedIn = () => fields.some((f) => (form.current?.elements.namedItem(f.name) as HTMLInputElement | null)?.value);
  const clear = () => { form.current?.reset(); setTyped(false); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const values: Record<string, string> = {};
    for (const f of fields) {
      const v = (form.current?.elements.namedItem(f.name) as HTMLInputElement | null)?.value;
      if (v) values[f.name] = v;
    }
    if (!Object.keys(values).length) return;
    setBusy(true); setInvalid(null);
    const refused = await onSave(values);
    setBusy(false);
    if (!refused) { clear(); return; }
    const byField: Record<string, string> = {};
    const rest: string[] = [];
    for (const issue of refused.fields ?? []) {
      const name = issue.field.startsWith("values.") ? issue.field.slice("values.".length) : null;
      if (name && fields.some((f) => f.name === name)) byField[name] = issue.message;
      else rest.push(issue.message);
    }
    setInvalid({ fields: byField, message: rest.length ? rest.join(" ") : Object.keys(byField).length ? null : refused.message });
  };
  return (
    <form ref={form} autoComplete="off" onSubmit={(e) => void submit(e)} onInput={() => setTyped(!!typedIn())} className="mt-4 space-y-4 border bg-card p-4" aria-label={`${k.label} key`}>
      {fields.map((f) => (
        <label key={f.name} className="block">
          <span className="caps mb-2 block text-[12px] font-semibold">{f.name}</span>
          {f.set && <span className="-mt-1 mb-2 block text-[12px] text-muted-foreground">Saved already. A new value replaces it; leave it empty to keep it.</span>}
          <input type="password" name={f.name} autoComplete="new-password" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true"
            className="w-full border bg-background px-3 py-2.5 font-mono text-[13px] outline-none focus:border-border-strong" />
          {invalid?.fields[f.name] && <span className="mt-2 block font-mono text-[12px] text-destructive-text" role="alert">{invalid.fields[f.name]}</span>}
        </label>
      ))}
      {invalid?.message && <p className="font-mono text-[12px] text-destructive-text" role="alert">{invalid.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="solid" disabled={!typed || busy || cantStore}>{busy ? "Saving" : "Save"}</Button>
        <Button type="button" size="sm" onClick={() => { clear(); onCancel(); }}>Cancel</Button>
      </div>
    </form>
  );
}
