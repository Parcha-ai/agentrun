import { type FormEvent, useEffect, useRef, useState } from "react";
import { SettingsSection, settingsBodyClass, settingsIntroClass, settingsPageClass } from "@/components/Settings";
import { RunError } from "@/components/RunError";
import { SecretRow } from "@/components/SecretRow";
import { ListSkeleton } from "@/components/Skeleton";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/field";
import { type Client, ClientError } from "@/lib/client";
import { pasteFromClipboard } from "@/lib/paste";
import { secretLabel, type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ApiError, HarnessKeys, HarnessKeysEntry, SecretMeta } from "@/lib/v2";

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });

/** Which key's form or confirm is open: the harness, the key, and whether it pastes or removes. */
type Open = { harness: string; key: string; mode: "edit" | "remove" };

/** Settings → Harness keys: each harness recipe billed to its vendor's plan that this server is started with, and each
 *  key its recipe runs on, saved here for that harness alone. A run on the harness gets them at its claim, never another
 *  harness's run and never any run's tools; with every one saved, its scheduled and triggered runs run too, ahead of its
 *  owner's own sign-in. A value goes to the server and nowhere else: the input is never filled from it, never kept in the
 *  page's state, and cleared after a save or a cancel. `writable`: this is the owner's password session. */
export function HarnessKeysPage({ v2, writable, whyNot = "sign_in" }: { v2: Client; writable: boolean; whyNot?: SecretsWhyNot }) {
  const [view, setView] = useState<HarnessKeys | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [problem, setProblem] = useState<{ harness: string; title: string; error: ApiError } | null>(null);
  const asked = useRef(0);
  const load = () => {
    const n = ++asked.current;
    v2.listHarnessKeys()
      .then((v) => { if (n === asked.current) { setView(v); setLoadError(null); } })
      .catch((e) => { if (n === asked.current) setLoadError(apiError(e)); });
  };
  useEffect(load, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  // A write closes only the form that sent it: one opened on another key meanwhile keeps what was typed in it.
  const done = (started: Open | null) => { setOpen((o) => (o === started ? null : o)); load(); };

  if (!view) return loadError
    ? <Banner tone="error" className="m-8" actions={<Button type="button" size="xs" onClick={load}>Try again</Button>}><p className="font-mono">The harness keys could not be read: {loadError.code}: {loadError.message}</p></Banner>
    : <div className="p-5 md:p-8"><ListSkeleton label="Loading harness keys" rows={2} /></div>;
  return (
    <div className="h-full overflow-auto">
      <div className={settingsPageClass}>
        <div className={settingsIntroClass}>
          <p className="caps text-label text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">Harness keys</h1>
          <p className="mt-2 text-lead text-muted-foreground">The keys a harness recipe billed to its vendor's plan runs on, each saved for that harness alone: its runs get them, no other harness's run and no tool ever does. A saved key is never shown again.</p>
        </div>
        <div className={settingsBodyClass}>
          {!writable && <p className="border bg-card p-4 text-body" role="status">{WHY_NOT_WORDS[whyNot]}</p>}
          {view.harnesses.length === 0 && <p className="border bg-card p-4 text-body" role="status">This server is started with no harness recipe billed to its vendor's plan (--harness-recipe), so there is no key to save here.</p>}
          {view.harnesses.map((h) => (
            <HarnessSection key={h.id} harness={h} writable={writable} open={open?.harness === h.id ? open : null} problem={problem?.harness === h.id ? problem : null}
              onOpen={(key, mode) => { setOpen(key && mode ? { harness: h.id, key, mode } : null); setProblem(null); }}
              onSave={async (key, value) => {
                const started = open;
                try { await v2.saveHarnessKey(h.id, key, value); } catch (e) {
                  if (e instanceof ClientError && e.status === 422) return e;
                  setProblem({ harness: h.id, title: "The key was not saved", error: apiError(e) });
                  return null;
                }
                done(started);
                return null;
              }}
              onRemove={async (key) => {
                const started = open;
                try { await v2.removeHarnessKey(h.id, key); } catch (e) { setProblem({ harness: h.id, title: "The key was not removed", error: apiError(e) }); return; }
                done(started);
              }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function HarnessSection({ harness: h, writable, open, problem, onOpen, onSave, onRemove }: {
  harness: HarnessKeysEntry;
  writable: boolean;
  open: Open | null;
  problem: { title: string; error: ApiError } | null;
  onOpen: (key: string | null, mode?: Open["mode"]) => void;
  /** Resolves with a 422 to show at the input, else null (saved, or refused and said by the page). */
  onSave: (key: string, value: string) => Promise<ClientError | null>;
  onRemove: (key: string) => Promise<void>;
}) {
  const box = useRef<HTMLDivElement>(null);
  const saved = h.keys.filter((k) => k.set).length;
  const name = (k: SecretMeta) => secretLabel(k.name);
  return (
    <SettingsSection label={h.label} title={h.label}
      note={<p>{h.ready ? "Every key is saved: its runs run on them, a scheduled or triggered one too." : "Its runs run on these keys once every one is saved. Until then, a person's run takes its owner's own sign-in where the server allows one."}</p>}>
      <div ref={box} className="border p-4" data-harness={h.id}>
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-prose font-semibold">{h.id}</span>
          <Chip tone={h.ready ? "success" : "plain"}>{h.ready ? "ready" : saved ? `${saved} of ${h.keys.length} saved` : "not saved"}</Chip>
        </p>
        <ul className="mt-3 space-y-1.5">
          {h.keys.map((k) => (
            <SecretRow key={k.name} field={k} writable={writable && open === null}
              onPaste={() => void pasteFromClipboard(() => onOpen(name(k), "edit"), () => box.current?.querySelector("form")?.elements.namedItem("value") as HTMLInputElement | null)}
              onRemove={k.source === "console" ? () => onOpen(name(k), "remove") : undefined} />
          ))}
        </ul>
        {open?.mode === "edit" && <KeyForm label={h.label} keyName={open.key} replaces={h.keys.some((k) => name(k) === open.key && k.set)} onSave={(value) => onSave(open.key, value)} onCancel={() => onOpen(null)} />}
        {open?.mode === "remove" && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border bg-card p-3">
            <p className="min-w-0 flex-1 text-body">Remove {open.key} saved for {h.label}? Its runs stop getting it.</p>
            <Button size="sm" variant="destructive" onClick={() => void onRemove(open.key)}>Remove</Button>
            <Button size="sm" onClick={() => onOpen(null)}>Keep</Button>
          </div>
        )}
        {problem && <div className="mt-4 border"><RunError error={problem.error} title={problem.title} /></div>}
      </div>
    </SettingsSection>
  );
}

/** One password input for one key. Uncontrolled: React mirrors a controlled input's value into its `value` attribute, and
 *  a key must never be in the DOM. */
function KeyForm({ label, keyName, replaces, onSave, onCancel }: { label: string; keyName: string; replaces: boolean; onSave: (value: string) => Promise<ClientError | null>; onCancel: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [typed, setTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const input = () => form.current?.elements.namedItem("value") as HTMLInputElement | null;
  const clear = () => { form.current?.reset(); setTyped(false); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = input()?.value;
    if (!value) return;
    setBusy(true); setInvalid(null);
    const refused = await onSave(value);
    setBusy(false);
    if (!refused) { clear(); return; }
    setInvalid((refused.fields ?? []).map((issue) => issue.message).join(" ") || refused.message);
  };
  return (
    <form ref={form} autoComplete="off" onSubmit={(e) => void submit(e)} onInput={() => setTyped(!!input()?.value)} className="mt-4 space-y-4 border bg-card p-4" aria-label={`${label} ${keyName}`}>
      <label className="block">
        <span className="caps mb-2 block text-small font-semibold">{keyName}</span>
        {replaces && <span className="-mt-1 mb-2 block text-small text-muted-foreground">Saved already. A new value replaces it.</span>}
        <Input type="password" name="value" autoComplete="new-password" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true" />
        {invalid && <span className="mt-2 block font-mono text-small text-destructive-text" role="alert">{invalid}</span>}
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="solid" disabled={!typed || busy}>{busy ? "Saving" : "Save"}</Button>
        <Button type="button" size="sm" onClick={() => { clear(); onCancel(); }}>Cancel</Button>
      </div>
    </form>
  );
}
