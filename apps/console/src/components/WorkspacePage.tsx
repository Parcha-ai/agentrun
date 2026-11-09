import { HardDrive } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { SecretRow } from "@/components/SecretRow";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { type Client, ClientError, problemOf } from "@/lib/client";
import { clock } from "@/lib/format";
import { SIGN_IN_TO_CHANGE } from "@/lib/secrets";
import type { ApiError, Archil, ArchilBody } from "@/lib/v2";

/** The page's one line about the disk, as decided: nothing else is said about disk state. */
const COPY = "Runs keep their folders on this Archil disk. The server never mounts it; computers that support it mount a run's folder.";

// The page's only other words are its labels: what a field takes, the server says when it refuses one.
const FIELDS: { name: "diskId" | "region" | "s3Url" | "image"; label: string; placeholder?: string }[] = [
  { name: "diskId", label: "Disk id" },
  { name: "region", label: "Region" },
  { name: "s3Url", label: "S3 URL", placeholder: "https://" },
  { name: "image", label: "Image", placeholder: "Archil's default (recommended)" },
];
type Fields = Record<(typeof FIELDS)[number]["name"], string>;
const fieldsOf = (v: Archil): Fields => ({ diskId: v.diskId ?? "", region: v.region ?? "", s3Url: v.s3Url ?? "", image: v.image ?? "" });

/** Archil's one key, by the name the read gives and the PUT takes. */
const KEY = "ARCHIL_API_KEY";

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });

/** Settings → Workspace: Archil, the disk runs keep their folders on (Mode 2), as GET /v2/workspace/archil answers it. On
 *  or off with its disk and region; its fields and its secret as a SecretRow said ARCHIL_API_KEY (never a value). Save
 *  sends the fields, and the key only when pasted (PUT), and a refusal is said under its field; Remove asks, then saves
 *  the key null; Test (POST …/test) says the server's detail or its why as given; Turn off (DELETE) asks first, and the
 *  key is kept. */
export function WorkspacePage({ v2, writable }: {
  v2: Client;
  /** Whether this session may paste, replace or remove a key (lib/secrets.ts useSecretsWritable). */
  writable: boolean;
}) {
  const [view, setView] = useState<Archil | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [fields, setFields] = useState<Fields>({ diskId: "", region: "", s3Url: "", image: "" });
  const [invalid, setInvalid] = useState<{ fields: Record<string, string>; message: string | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; words: string; at: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // The key's password input (Paste or Replace) or its removal's confirm; the row's buttons wait while either is open.
  const [pasting, setPasting] = useState(false);
  const [removingKey, setRemovingKey] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const reads = useRef(0);

  const take = useCallback((v: Archil) => { setView(v); setFields(fieldsOf(v)); }, []);
  const load = useCallback(() => {
    const n = ++reads.current;
    setLoadError(null);
    v2.archil().then((v) => { if (n === reads.current) take(v); }, (e) => { if (n === reads.current) setLoadError(apiError(e)); });
  }, [v2, take]);
  useEffect(load, [load]);

  if (!view) return loadError
    ? <div className="m-8 border p-4" role="alert">
        <p className="font-mono text-[13px] text-destructive-text">Archil's settings could not be read: {loadError.code}: {loadError.message}</p>
        <button type="button" onClick={load} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>
      </div>
    : <div className="p-5 md:p-8"><ListSkeleton label="Loading Archil's settings" rows={2} /></div>;

  const keyValue = () => (form.current?.elements.namedItem(KEY) as HTMLInputElement | null)?.value ?? "";
  const put = async (key: string | null | undefined) => {
    const body: ArchilBody = { diskId: fields.diskId, region: fields.region, s3Url: fields.s3Url, ...(fields.image ? { image: fields.image } : {}), ...(key !== undefined ? { keys: { [KEY]: key } } : {}) };
    setBusy(true); setInvalid(null); setProblem(null);
    try {
      const answer = await v2.saveArchil(body);
      setPasting(false); setRemovingKey(false);
      take(answer);
    } catch (err) {
      if (err instanceof ClientError && err.status === 422) {
        const byField: Record<string, string> = {};
        const rest: string[] = [];
        for (const issue of err.fields ?? []) {
          const name = issue.field.startsWith("keys.") ? issue.field.slice("keys.".length) : issue.field;
          if (FIELDS.some((f) => f.name === name) || name === KEY) byField[name] = issue.message;
          else rest.push(issue.message);
        }
        setInvalid({ fields: byField, message: rest.length ? rest.join(" ") : Object.keys(byField).length ? null : err.message });
      } else setProblem(problemOf(err));
    } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => { e.preventDefault(); void put(pasting && keyValue() ? keyValue() : undefined); };
  const test = async () => {
    setTesting(true);
    try {
      const answer = await v2.testArchil();
      setTested(answer.ok ? { ok: true, words: answer.detail, at: new Date().toISOString() } : { ok: false, words: answer.why, at: new Date().toISOString() });
    } catch (err) {
      setTested({ ok: false, words: problemOf(err), at: new Date().toISOString() });
    } finally { setTesting(false); }
  };
  const turnOff = async () => {
    setProblem(null);
    try { take(await v2.archilOff()); setConfirming(false); } catch (err) { setProblem(problemOf(err)); }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        <div>
          <p className="caps text-[11px] text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">Workspace</h1>
          <p className="mt-2 text-[14px] text-muted-foreground">{COPY}</p>
        </div>
        {!writable && <p role="status" className="border bg-card p-4 text-[13px]">{SIGN_IN_TO_CHANGE}</p>}
        <section aria-label="Archil" className="border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <HardDrive className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-mono text-[15px] font-semibold">Archil</span>
            <span data-state>{view.on ? <Chip tone="success">On</Chip> : <Chip>Off</Chip>}</span>
            {view.on && <span data-disk className="font-mono text-[12px] text-muted-foreground">{`${view.diskId ?? ""} · ${view.region ?? ""}`}</span>}
            <span className="flex-1" />
            <Button size="sm" onClick={() => void test()} disabled={testing}>{testing ? "Testing…" : "Test"}</Button>
            {view.on && <Button size="sm" variant="destructive" onClick={() => setConfirming(true)}>Turn off</Button>}
          </div>
          {tested && <p data-test className={`mt-3 text-[12px] ${tested.ok ? "text-success-text" : "text-destructive-text"}`}>{`${tested.ok ? "Passed" : "Failed"} · ${clock(tested.at)} · ${tested.words}`}</p>}
          {confirming && (
            <div data-confirm className="mt-4 flex flex-wrap items-center gap-3 border bg-card p-3">
              <p className="min-w-0 flex-1 text-[13px]">Turn Archil off? Its keys are kept, for turning it on again.</p>
              <Button size="sm" variant="destructive" onClick={() => void turnOff()}>Turn off</Button>
              <Button size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          )}
          {problem && <p role="alert" className="mt-4 border border-destructive/50 px-3 py-2 font-mono text-[12px] text-destructive-text">{problem}</p>}

          <form ref={form} autoComplete="off" onSubmit={save} className="mt-5 space-y-4" aria-label="Archil settings">
            {FIELDS.map((f) => (
              <label key={f.name} className="block">
                <span className="caps mb-2 block text-[12px] font-semibold">{f.label}</span>
                <input name={f.name} value={fields[f.name]} placeholder={f.placeholder} spellCheck={false} autoCapitalize="off" autoCorrect="off"
                  onChange={(e) => { const value = e.currentTarget.value; setFields((now) => ({ ...now, [f.name]: value })); }}
                  className="w-full border bg-background px-3 py-2.5 font-mono text-[13px] outline-none focus:border-border-strong" />
                {invalid?.fields[f.name] && <span className="mt-2 block font-mono text-[12px] text-destructive-text" role="alert">{invalid.fields[f.name]}</span>}
              </label>
            ))}
            {/* The key sits with the settings it saves with; SecretRow's buttons never submit this form. */}
            <ul>
              {view.keys.filter((key) => key.name === KEY).map((key) => (
                <SecretRow key={key.name} field={key} label={KEY} writable={writable && !pasting && !removingKey}
                  onPaste={() => setPasting(true)} onRemove={() => setRemovingKey(true)} />
              ))}
            </ul>
            {writable && removingKey && (
              <div data-confirm-key className="flex flex-wrap items-center gap-3 border bg-card p-3">
                <p className="min-w-0 flex-1 text-[13px]">Remove {KEY} saved on this server?</p>
                <Button type="button" size="sm" variant="destructive" onClick={() => void put(null)}>Remove</Button>
                <Button type="button" size="sm" onClick={() => setRemovingKey(false)}>Cancel</Button>
              </div>
            )}
            {writable && pasting && (
              // Uncontrolled, as every key field: a key must never be in the DOM, and it is sent only when typed in.
              <label className="block">
                <span className="caps mb-2 block text-[12px] font-semibold">{KEY}</span>
                <input type="password" name={KEY} autoComplete="new-password" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true"
                  className="w-full border bg-background px-3 py-2.5 font-mono text-[13px] outline-none focus:border-border-strong" />
                {invalid?.fields[KEY] && <span className="mt-2 block font-mono text-[12px] text-destructive-text" role="alert">{invalid.fields[KEY]}</span>}
              </label>
            )}
            {writable && pasting && <Button type="button" size="sm" onClick={() => setPasting(false)}>Cancel</Button>}
            {invalid?.message && <p className="font-mono text-[12px] text-destructive-text" role="alert">{invalid.message}</p>}
            <Button type="submit" size="sm" variant="solid" disabled={busy}>{busy ? "Saving" : view.on ? "Save" : "Turn on"}</Button>
          </form>
        </section>
      </div>
    </div>
  );
}
