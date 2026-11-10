import { type FormEvent, useEffect, useRef, useState } from "react";
import { RunError } from "@/components/RunError";
import { ProviderIcon } from "@/components/ProviderIcon";
import { SecretRow } from "@/components/SecretRow";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Banner } from "@/components/ui/banner";
import { Input } from "@/components/ui/field";
import { type Client, ClientError } from "@/lib/client";
import { when } from "@/lib/format";
import { secretLabel, type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ApiError, SecretMeta, ToolKey, ToolKeyCheck, ToolKeyField, ToolKeys, ToolKeysReenter } from "@/lib/v2";

const REASON: Record<ToolKeysReenter["reason"], string> = {
  seal_key_missing: "This server was started without its seal key, so the keys saved here can't be opened.",
  seal_key_changed: "This server's seal key changed since these keys were saved, so they can't be opened.",
  file_unreadable: "The file this server keeps the saved keys in is damaged, so they can't be opened.",
};

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });

/** A saved key's check, as its row says it; null when there is none to say. */
function checkLine(label: string, check: ToolKeyCheck | null | undefined): string | null {
  if (!check) return null;
  if (check.state === "accepted") return `${label} accepted this key · ${when(check.at)}`;
  return `Not checked: ${check.reason}${check.at ? ` · ${when(check.at)}` : ""}`;
}

/** A saved field that no longer opens, said at its row. */
const UNREADABLE = "can't be opened: paste it again";

/** The keys page's groups, in order: the model providers' keys, then the tools'. `label` is the heading here, and how
 *  words elsewhere name the group ("Settings → Model keys"). */
export const KEY_GROUPS = [{ kind: "model", label: "Model keys" }, { kind: "tool", label: "Tool keys" }] as const;

/** The word on a model key, said wherever the console asks for one: an OpenRouter key runs every model, Jev included. */
export const KEY_ADVICE = "We recommend an OpenRouter key with a dollar cap and an expiration date. Do not share this key with anyone.";

/** Settings → Tool keys: each model provider's key (`kind: "model"`) and each key a tool needs, where each of its fields is
 *  set, and a form to add, change or remove the one saved here. A value goes to the server and nowhere else: the
 *  inputs are never filled from it, never kept in the page's state, and cleared after a save or a cancel. `atRest` is
 *  capabilities' `features.tool_keys.at_rest`; `onChange` follows each save and removal (the server's tools and models
 *  may change with its keys). */
/** `writable`: this is the owner's password session (session.secrets_writable), the one that may paste a key. */
export function KeysPage({ v2, atRest, onChange, writable, whyNot = "sign_in" }: { v2: Client; atRest?: "sealed" | "unavailable"; onChange?: () => void; writable: boolean; whyNot?: SecretsWhyNot }) {
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
    : <div className="p-5 md:p-8"><ListSkeleton label="Loading the tool keys" rows={3} /></div>;
  const reenter = view.reenter;
  // The model providers' keys first, then the tools': headed only when there are both.
  const groups = KEY_GROUPS.map((g) => ({ ...g, keys: view.keys.filter((k) => (k.kind === "model") === (g.kind === "model")) })).filter((g) => g.keys.length);
  const row = (k: ToolKey) => (
    <KeyRow key={k.id} tool={k} cantStore={cantStore} writable={writable} again={!!reenter && k.fields.some((f) => f.stored_unreadable || reenter.fields.includes(f.name))}
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
  );
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        <div>
          <p className="caps text-label text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">Keys</h1>
          <p className="mt-2 text-lead text-muted-foreground">A model provider's key, which every agent runs on, and a tool's key, for every agent that uses the tool, kept on this server. A saved key is never shown again.</p>
        </div>
        {!writable && <p className="border bg-card p-4 text-body" role="status">{WHY_NOT_WORDS[whyNot]}</p>}
        {loadError && <ReadError inline error={loadError} onRetry={load} />}
        {reenter && (
          <Banner tone="warning" role="alert" aria-label="Keys to enter again" title="Enter these keys again">
            <p>{REASON[reenter.reason]}</p>
            <p className="mt-2 font-mono">{reenter.fields.length ? reenter.fields.join(", ") : "Which keys it held is not known: enter again each key you had saved."}</p>
          </Banner>
        )}
        {cantStore && (
          <p className="border bg-card p-4 font-mono text-body" role="status">
            This server can't store keys: it was started without a seal key. Set each key where the server starts ({view.keys.flatMap((k) => k.fields.map((f) => f.name)).join(", ")}).
          </p>
        )}
        {groups.map((g) => (
          <section key={g.label} aria-label={g.label}>
            {groups.length > 1 && <h2 className="caps mb-2 text-small font-semibold text-muted-foreground">{g.label}</h2>}
            {g.kind === "model" && <p className="mb-2 text-body text-muted-foreground">{KEY_ADVICE}</p>}
            <ul className="border">{g.keys.map(row)}</ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function ReadError({ error, onRetry, inline = false }: { error: ApiError; onRetry: () => void; inline?: boolean }) {
  return (
    <Banner tone="error" className={inline ? undefined : "m-8"} actions={<Button type="button" size="xs" onClick={onRetry}>Try again</Button>}>
      <p className="font-mono">The tool keys could not be read: {error.code}: {error.message}</p>
    </Banner>
  );
}

type RowProps = {
  tool: ToolKey;
  cantStore: boolean;
  writable: boolean;
  again: boolean;
  open: "edit" | "remove" | null;
  problem: { title: string; error: ApiError } | null;
  onOpen: (mode: "edit" | "remove" | null) => void;
  /** Resolves with a 422 to show by field, else null (saved, or refused and said by the page). */
  onSave: (values: Record<string, string>) => Promise<ClientError | null>;
  onRemove: () => Promise<void>;
};

function KeyRow({ tool: k, cantStore, writable, again, open, problem, onOpen, onSave, onRemove }: RowProps) {
  // Each field's secret ("tool:<KEY>"), and each secret's field (the form's input, and whether a saved one still opens).
  const secretOf = (f: ToolKeyField) => k.secrets.find((s) => secretLabel(s.name) === f.name);
  const fieldOf = (s: SecretMeta) => k.fields.find((f) => f.name === secretLabel(s.name));
  // The fields this page may set: any not set in the environment, which wins.
  const own = k.fields.filter((f) => secretOf(f)?.source !== "env");
  const setCount = k.secrets.filter((s) => s.set).length;
  return (
    <li className="border-b p-4 last:border-b-0">
      <div className="flex flex-wrap items-start gap-3">
        <ProviderIcon id={k.id} className="mt-1" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-prose font-semibold">{k.label}</span>
            <Chip tone={setCount === k.secrets.length ? "success" : "plain"}>{setCount === k.secrets.length ? "set" : setCount ? `${setCount} of ${k.secrets.length} set` : "not set"}</Chip>
            {again && <Chip tone="warning">enter again</Chip>}
          </p>
          <p className="mt-1.5 font-mono text-small text-muted-foreground">
            {k.kind === "model" ? "Model provider" : `Unlocks ${k.unlocks.join(", ")}`}
            {/* A key no harness reads (one only a decision provider uses) names no harnesses, not an empty list. */}
            {k.harnesses.length > 0 && ` · Harnesses ${k.harnesses.length === 1 ? `${k.harnesses[0]} only` : k.harnesses.join(", ")}`}
          </p>
          {checkLine(k.label, k.check) && <p className={`mt-1.5 text-small ${k.check?.state === "accepted" ? "text-success-text" : "text-muted-foreground"}`}>{checkLine(k.label, k.check)}</p>}
          {/* Paste and Replace open the key's form (a key's fields go together); Remove asks to remove what is saved here.
              None while a form or a confirm is open. */}
          <ul className="mt-3 space-y-1.5">
            {k.secrets.map((s) => (
              <SecretRow key={s.name} field={s} stateSaid={k.secrets.length === 1} writable={writable && open === null} disabled={cantStore} note={fieldOf(s)?.stored_unreadable ? UNREADABLE : undefined}
                onPaste={() => onOpen("edit")} onRemove={s.source === "console" ? () => onOpen("remove") : undefined} />
            ))}
          </ul>
          {!own.length && <p className="mt-3 text-small text-muted-foreground">Set when the server starts, and that one wins: change it where the server is started.</p>}
        </div>
      </div>
      {open === "edit" && <KeyForm tool={k} fields={own} cantStore={cantStore} onSave={onSave} onCancel={() => onOpen(null)} />}
      {open === "remove" && (
        <div className="mt-4 flex flex-wrap items-center gap-3 border bg-card p-3">
          <p className="min-w-0 flex-1 text-body">Remove the {k.label} key saved here?{k.secrets.some((s) => s.source === "env") ? " The one set in the environment stays." : ""}</p>
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
export function KeyForm({ tool: k, fields, cantStore, onSave, onCancel }: { tool: ToolKey; fields: ToolKeyField[]; cantStore: boolean; onSave: RowProps["onSave"]; onCancel: () => void }) {
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
          <span className="caps mb-2 block text-small font-semibold">{f.name}</span>
          {f.set && <span className="-mt-1 mb-2 block text-small text-muted-foreground">Saved already. A new value replaces it; leave it empty to keep it.</span>}
          <Input type="password" name={f.name} autoComplete="new-password" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true" />
          {invalid?.fields[f.name] && <span className="mt-2 block font-mono text-small text-destructive-text" role="alert">{invalid.fields[f.name]}</span>}
        </label>
      ))}
      {invalid?.message && <p className="font-mono text-small text-destructive-text" role="alert">{invalid.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="solid" disabled={!typed || busy || cantStore}>{busy ? "Saving" : "Save"}</Button>
        <Button type="button" size="sm" onClick={() => { clear(); onCancel(); }}>Cancel</Button>
      </div>
    </form>
  );
}
