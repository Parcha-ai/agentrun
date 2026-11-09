import { Monitor } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { SecretRow } from "@/components/SecretRow";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { type Client, ClientError, problemOf } from "@/lib/client";
import { clock } from "@/lib/format";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ApiError, ComputerKindView, ComputerProvider, Computers } from "@/lib/v2";

/** Each kind's name and what it gives a run, in the console's words. A kind the console doesn't know yet reads as its id. */
const KIND_WORDS: Record<string, { label: string; gives: string }> = {
  none: { label: "None", gives: "The run's folder only." },
  sandbox: { label: "Sandbox", gives: "A Linux container." },
  desktop: { label: "Desktop", gives: "A screen, with a pointer and keys." },
  phone: { label: "Phone", gives: "A phone's screen and its apps." },
  browser: { label: "Browser", gives: "A browser the agent drives." },
};
const wordsOf = (kind: string) => KIND_WORDS[kind] ?? { label: kind, gives: "" };

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });

/** Said on a metered provider of a kind that bills by the minute: its minutes are the vendor's, outside the run's cap. */
const METERED = "This provider bills by the minute through your own vendor account, and those minutes aren't counted in a run's spending cap.";
const BY_THE_MINUTE: ReadonlySet<string> = new Set(["sandbox", "desktop", "phone"]);
/** A provider's secret is named "computer:<provider>:<KEY>"; its PUT takes the KEY. */
const keyOf = (name: string) => name.slice(name.lastIndexOf(":") + 1);
/** A key's form (paste or replace) or its removal's confirm, open under one row. */
type Opened = { paste: string } | { remove: string };

/** A provider's last Test connection here: the server's passed (with its detail) or failed (with its why), and when. */
type Tested = { ok: boolean; words: string; at: string };

/** Settings → Computers: every kind of computer an agent can be given, as GET /v2/computers answers it. A kind this
 *  server doesn't offer says the server's why. Each provider shows under every kind it serves, with its secrets as
 *  SecretRows (the KEY, Set or Missing, Optional unless required, where from and when, never a value), whether a run
 *  could have it now (and the server's why not), Paste or Replace of one key (PUT …/keys with that KEY), a removal
 *  (null), and Test connection (POST …/test). A save or removal reads the whole page again: a key can make a provider
 *  ready, and a kind offered, under every kind at once. Keys change only on a writable session. A metered provider of a kind
 *  that bills by the minute says so, and that those minutes are outside a run's spending cap. */
export function ComputersPage({ v2, writable, whyNot = "sign_in" }: {
  v2: Client;
  /** Whether this session may paste, replace or remove a key: the session read's secrets_writable (lib/secrets.ts useSecrets). */
  writable: boolean;
  /** Why not, when it may not: the reason line (WHY_NOT_WORDS). */
  whyNot?: SecretsWhyNot;
}) {
  const [view, setView] = useState<Computers | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  // Which row's form or removal is open, by kind and provider: a provider under two kinds opens in the one clicked.
  const [open, setOpen] = useState<{ at: string; mode: Opened } | null>(null);
  const [problem, setProblem] = useState<{ at: string; words: string } | null>(null);
  const [tested, setTested] = useState<Record<string, Tested>>({});
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const reads = useRef(0);

  const load = useCallback(() => {
    const n = ++reads.current;
    setLoadError(null);
    v2.computers().then((v) => { if (n === reads.current) setView(v); }, (e) => { if (n === reads.current) setLoadError(apiError(e)); });
  }, [v2]);
  useEffect(load, [load]);

  if (!view) return loadError
    ? <div className="m-8 border p-4" role="alert">
        <p className="font-mono text-[13px] text-destructive-text">The computers could not be read: {loadError.code}: {loadError.message}</p>
        <button type="button" onClick={load} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>
      </div>
    : <div className="p-5 md:p-8"><ListSkeleton label="Loading the computers" rows={3} /></div>;

  const servesOf = (id: string) => view.kinds.filter((k) => k.providers.some((p) => p.id === id)).map((k) => k.kind);
  const save = async (at: string, provider: ComputerProvider, keys: Record<string, string | null>): Promise<ClientError | null> => {
    setProblem(null);
    try { await v2.saveComputerKeys(provider.id, keys); } catch (e) {
      if (e instanceof ClientError && e.status === 422) return e;
      setProblem({ at, words: problemOf(e) });
      return null;
    }
    setOpen(null);
    load();
    return null;
  };
  const test = async (provider: ComputerProvider) => {
    setTesting((s) => new Set(s).add(provider.id));
    let next: Tested;
    try {
      const answer = await v2.testComputer(provider.id);
      next = answer.ok ? { ok: true, words: answer.detail, at: new Date().toISOString() } : { ok: false, words: answer.why, at: new Date().toISOString() };
    } catch (e) {
      next = { ok: false, words: problemOf(e), at: new Date().toISOString() };
    }
    setTested((t) => ({ ...t, [provider.id]: next }));
    setTesting((s) => { const left = new Set(s); left.delete(provider.id); return left; });
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        <div>
          <p className="caps text-[11px] text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">Computers</h1>
          <p className="mt-2 text-[14px] text-muted-foreground">The computers an agent can be given, and who provides them. An agent can have a kind once one of its providers is ready. Keys are kept sealed on this server and never shown again.</p>
        </div>
        {!writable && <p role="status" className="border bg-card p-4 text-[13px]">{WHY_NOT_WORDS[whyNot]}</p>}
        {view.kinds.map((k) => (
          <KindSection key={k.kind} kind={k}>
            {k.providers.map((p) => {
              const at = `${k.kind}/${p.id}`;
              return (
                <ProviderRow key={p.id} kind={k.kind} provider={p} writable={writable} serves={servesOf(p.id)} tested={tested[p.id]} testing={testing.has(p.id)}
                  open={open?.at === at ? open.mode : null} problem={problem?.at === at ? problem.words : null}
                  onOpen={(mode) => { setOpen(mode ? { at, mode } : null); setProblem(null); }}
                  onSave={(keys) => save(at, p, keys)}
                  onRemove={async (name) => { const refused = await save(at, p, { [name]: null }); if (refused) setProblem({ at, words: refused.fields?.map((f) => f.message).join(" ") || refused.message }); }}
                  onTest={() => void test(p)} />
              );
            })}
          </KindSection>
        ))}
      </div>
    </div>
  );
}

function KindSection({ kind: k, children }: { kind: ComputerKindView; children: ReactNode }) {
  const { label, gives } = wordsOf(k.kind);
  return (
    <section aria-label={label}>
      <h2 className="mb-2 flex flex-wrap items-center gap-2">
        <span className="caps text-[12px] font-semibold">{label}</span>
        {gives && <span className="text-[12px] text-muted-foreground">{gives}</span>}
        {!k.offered && <Chip tone="muted">Not offered here</Chip>}
      </h2>
      {!k.offered && k.why && <p className="mb-2 font-mono text-[12px] text-muted-foreground">{k.why}</p>}
      {k.providers.length
        ? <ul className="border">{children}</ul>
        : <p className="border p-4 text-[13px] text-muted-foreground">{k.kind === "none" ? "Nothing to set up." : "No provider serves it on this server."}</p>}
    </section>
  );
}

type RowProps = {
  /** The kind whose section this row is under. */
  kind: string;
  provider: ComputerProvider;
  writable: boolean;
  serves: string[];
  tested: Tested | undefined;
  testing: boolean;
  open: Opened | null;
  problem: string | null;
  onOpen: (mode: Opened | null) => void;
  onSave: (keys: Record<string, string>) => Promise<ClientError | null>;
  onRemove: (name: string) => Promise<void>;
  onTest: () => void;
};

function ProviderRow({ kind, provider: p, writable, serves, tested, testing, open, problem, onOpen, onSave, onRemove, onTest }: RowProps) {
  const pasting = open && "paste" in open ? open.paste : null;
  const removing = open && "remove" in open ? open.remove : null;
  return (
    <li className="border-b p-4 last:border-b-0">
      <div className="flex flex-wrap items-start gap-3">
        <Monitor className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span data-provider className="font-mono text-[15px] font-semibold">{p.name}</span>
            {p.ready ? <Chip tone="success">Ready</Chip> : <Chip>Not ready</Chip>}
            {p.metered && <span data-metered className="text-[12px] text-muted-foreground">Metered</span>}
          </p>
          {!p.ready && p.why && <p className="mt-1.5 font-mono text-[12px] text-muted-foreground">{p.why}</p>}
          {p.metered && BY_THE_MINUTE.has(kind) && <p className="mt-1.5 text-[12px] text-muted-foreground">{METERED}</p>}
          {p.secrets.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {/* SecretRow says a secret by its KEY (secretLabel); the PUT takes the KEY too. A row's buttons wait while its
                  form or confirm is open. */}
              {p.secrets.map((secret) => {
                const key = keyOf(secret.name);
                return <SecretRow key={secret.name} field={secret} required={p.required.includes(secret.name)} writable={writable && !open}
                  onPaste={() => onOpen({ paste: key })} onRemove={() => onOpen({ remove: key })} />;
              })}
            </ul>
          )}
          {tested && (
            <p data-test className={`mt-2 text-[12px] ${tested.ok ? "text-success-text" : "text-destructive-text"}`}>{`${tested.ok ? "Passed" : "Failed"} · ${clock(tested.at)} · ${tested.words}`}</p>
          )}
          <p className="mt-2 text-[12px] text-muted-foreground">{p.secrets.length ? "" : "No key. "}Serves: {serves.join(", ")}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={onTest} disabled={testing}>{testing ? "Testing…" : "Test connection"}</Button>
        </div>
      </div>
      {writable && pasting && <ComputerKeyForm provider={p.name} name={pasting} set={p.secrets.some((secret) => keyOf(secret.name) === pasting && secret.set)} onSave={onSave} onCancel={() => onOpen(null)} />}
      {writable && removing && (
        <div data-confirm className="mt-4 flex flex-wrap items-center gap-3 border bg-card p-3">
          <p className="min-w-0 flex-1 text-[13px]">Remove {removing} saved on this server?</p>
          <Button size="sm" variant="destructive" onClick={() => void onRemove(removing)}>Remove</Button>
          <Button size="sm" onClick={() => onOpen(null)}>Cancel</Button>
        </div>
      )}
      {problem && <p role="alert" className="mt-4 border border-destructive/50 px-3 py-2 font-mono text-[12px] text-destructive-text">{problem}</p>}
    </li>
  );
}

/** One key's password input, as the other secrets pages' forms: uncontrolled, as a key must never be in the DOM (React
 *  mirrors a controlled input's value into its attribute). Sends that KEY alone. */
function ComputerKeyForm({ provider, name, set, onSave, onCancel }: { provider: string; name: string; set: boolean; onSave: RowProps["onSave"]; onCancel: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [typed, setTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<{ field: string | null; message: string } | null>(null);
  const valueOf = () => (form.current?.elements.namedItem(name) as HTMLInputElement | null)?.value ?? "";
  const clear = () => { form.current?.reset(); setTyped(false); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = valueOf();
    if (!value) return;
    setBusy(true); setInvalid(null);
    const refused = await onSave({ [name]: value });
    setBusy(false);
    if (!refused) { clear(); return; }
    const mine = refused.fields?.find((issue) => issue.field === name);
    const rest = (refused.fields ?? []).filter((issue) => issue.field !== name).map((issue) => issue.message);
    setInvalid(mine ? { field: mine.message, message: rest.join(" ") } : { field: null, message: rest.join(" ") || refused.message });
  };
  return (
    <form ref={form} autoComplete="off" onSubmit={(e) => void submit(e)} onInput={() => setTyped(!!valueOf())} className="mt-4 space-y-4 border bg-card p-4" aria-label={`${provider} ${name}`}>
      <label className="block">
        <span className="caps mb-2 block text-[12px] font-semibold">{name}</span>
        {set && <span className="-mt-1 mb-2 block text-[12px] text-muted-foreground">A new value replaces the one saved.</span>}
        <input type="password" name={name} autoComplete="new-password" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true"
          className="w-full border bg-background px-3 py-2.5 font-mono text-[13px] outline-none focus:border-border-strong" />
        {invalid?.field && <span className="mt-2 block font-mono text-[12px] text-destructive-text" role="alert">{invalid.field}</span>}
      </label>
      {invalid?.message && <p className="font-mono text-[12px] text-destructive-text" role="alert">{invalid.message}</p>}
      <p className="text-[12px] text-muted-foreground">Kept sealed on this server. It is never shown again, here or anywhere.</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="solid" disabled={!typed || busy}>{busy ? "Saving" : "Save"}</Button>
        <Button type="button" size="sm" onClick={() => { clear(); onCancel(); }}>Cancel</Button>
      </div>
    </form>
  );
}
