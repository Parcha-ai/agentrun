import { Monitor, Smartphone } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { SecretRow } from "@/components/SecretRow";
import { ListSkeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Chip } from "@/components/ui/chip";
import { Picker } from "@/components/ui/picker";
import { type Client, ClientError, problemOf } from "@/lib/client";
import { BY_THE_MINUTE, METERED } from "@/lib/computers";
import { clock, runLabel, when } from "@/lib/format";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ApiError, ComputerChoices, ComputerKeyChoices, ComputerKindView, ComputerProvider, Computers, PairedComputer, Pairing } from "@/lib/v2";

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

/** A provider's secret is named "computer:<provider>:<KEY>"; its PUT takes the KEY. */
const keyOf = (name: string) => name.slice(name.lastIndexOf(":") + 1);
/** A key's form (paste or replace) or its removal's confirm, open under one row. */
type Opened = { paste: string } | { remove: string };

/** A provider's last Test connection here: the server's passed (with its detail) or failed (with its why), and when. */
type Tested = { ok: boolean; words: string; at: string };

/** How often the page reads the computers again while a pairing code is up, so the computer that uses it shows. */
export const PAIRING_POLL_MS = 2_000;

/** Settings → Computers: first, the person's own computers paired with this server (Pair a computer: a code to type into
 *  the computer's driver with this server's address, one page for every OS; each paired computer as its hello says it,
 *  online or offline, the run that holds it and until when, and Remove). Each is
 *  also a provider of its kind in GET /v2/computers, and shows here once, in its own section. Then every kind of computer
 *  an agent can be given, as GET /v2/computers answers it. A kind this
 *  server doesn't offer says the server's why. Each provider shows under every kind it serves, with its secrets as
 *  SecretRows (the KEY, Set or Missing, Optional unless required, where from and when, never a value), whether a run
 *  could have it now (and the server's why not), Paste or Replace of one key (PUT …/keys with that KEY), a removal
 *  (null), and Test connection (POST …/test). A key the provider lists as picked (Orgo's workspace) is never pasted: once
 *  its required keys are saved, it is picked by name from the vendor's own list (KeyChoices). A save or removal reads the whole page again: a key can make a provider
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
        <p className="font-mono text-body text-destructive-text">The computers could not be read: {loadError.code}: {loadError.message}</p>
        <Button size="sm" onClick={load} className="mt-3">Try again</Button>
      </div>
    : <div className="p-5 md:p-8"><ListSkeleton label="Loading the computers" rows={3} /></div>;

  const pairedIds = new Set(view.paired.map((computer) => computer.id));
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
          <p className="caps text-label text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">Computers</h1>
          <p className="mt-2 text-lead text-muted-foreground">The computers an agent can be given, and who provides them. An agent can have a kind once one of its providers is ready. Keys are kept sealed on this server and never shown again.</p>
        </div>
        <PairedSection v2={v2} paired={view.paired} reload={load} />
        {!writable && <p role="status" className="border bg-card p-4 text-body">{WHY_NOT_WORDS[whyNot]}</p>}
        {view.kinds.map((k) => (
          <KindSection key={k.kind} kind={k} providers={k.providers.filter((p) => !pairedIds.has(p.id))} own={k.providers.filter((p) => pairedIds.has(p.id)).map((p) => p.name)}>
            {k.providers.filter((p) => !pairedIds.has(p.id)).map((p) => {
              const at = `${k.kind}/${p.id}`;
              return (
                <ProviderRow key={p.id} v2={v2} kind={k.kind} provider={p} writable={writable} serves={servesOf(p.id)} tested={tested[p.id]} testing={testing.has(p.id)}
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

/** What a paired computer is, as its hello says it, the same line for every OS: the kinds it serves, its device, its os
 *  and version, its architecture and its screen. */
function machineOf(computer: PairedComputer): string {
  const device = computer.device ? `${computer.device.maker} ${computer.device.model}` : null;
  const os = computer.os_version ? `${computer.os} ${computer.os_version}` : computer.os;
  const screen = computer.screen ? `screen ${computer.screen.width}×${computer.screen.height} at ${computer.screen.scale}x` : null;
  return [computer.serves.map((kind) => wordsOf(kind).label).join(", ") || wordsOf(computer.kind).label, device, os, computer.arch, screen].filter(Boolean).join(" · ");
}

/** What its driver offers: its groups, then each feature that is off, with why. */
function offersOf(computer: PairedComputer): string {
  // The server lists only true or {off}; anything else is skipped, so a driver's malformed hello never breaks the page.
  const off = Object.entries(computer.features ?? {}).flatMap(([name, value]) => (value !== true && typeof value?.off === "string" ? [`${name} off: ${value.off}`] : []));
  return [`Offers ${computer.groups.join(", ")}`, ...off].join(" · ");
}

/** The person's own computers: Pair a computer (a code, its countdown, and where to type it), then each paired computer
 *  with its state and Remove. While a code is up the page reads the computers again every PAIRING_POLL_MS, and the
 *  computer that used the code is said by name. */
function PairedSection({ v2, paired, reload }: { v2: Client; paired: PairedComputer[]; reload: () => void }) {
  // The code shown, as the server made it (its `id` names the pairing): the computer that used it is the one the server
  // lists with that pairing, so another tab's pairing with another code never counts as this one's.
  const [pairing, setPairing] = useState<{ code: Pairing } | null>(null);
  const [making, setMaking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [joined, setJoined] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const left = pairing ? Date.parse(pairing.code.expires_at) - now : 0;
  const live = pairing !== null && left > 0;

  useEffect(() => {
    if (!live) return;
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const poll = setInterval(reload, PAIRING_POLL_MS);
    return () => { clearInterval(tick); clearInterval(poll); };
  }, [live, reload]);
  useEffect(() => {
    if (!pairing) return;
    const used = paired.find((computer) => computer.pairing === pairing.code.id);
    if (used) { setJoined(used.name); setPairing(null); }
  }, [paired, pairing]);

  const make = async () => {
    setMaking(true); setProblem(null); setJoined(null);
    try {
      const code = await v2.createPairing();
      setNow(Date.now());
      setPairing({ code });
    } catch (e) {
      setProblem(problemOf(e));
    }
    setMaking(false);
  };
  const remove = async (id: string) => {
    setProblem(null);
    try { await v2.removeComputer(id); } catch (e) { setProblem(problemOf(e)); return; }
    setRemoving(null);
    reload();
  };
  const countdown = `${Math.floor(Math.max(0, left) / 60_000)}:${String(Math.floor((Math.max(0, left) % 60_000) / 1_000)).padStart(2, "0")}`;

  return (
    <section aria-label="Your computers">
      <h2 className="mb-2 flex flex-wrap items-center gap-2">
        <span className="caps text-small font-semibold">Your computers</span>
        <span className="text-small text-muted-foreground">A computer or phone of your own, attached by the driver you run on it. An agent can be given it as its computer.</span>
      </h2>
      {pairing
        ? <div data-pairing className="mb-3 space-y-3 border bg-card p-4">
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <div>
                <p className="caps text-label text-muted-foreground">Server address</p>
                <p data-address className="mt-1 font-mono text-prose font-semibold">{window.location.origin}</p>
              </div>
              <div>
                <p className="caps text-label text-muted-foreground">Pairing code</p>
                <p data-code className="mt-1 font-mono text-2xl font-semibold">{pairing.code.code}</p>
              </div>
            </div>
            {live
              ? <p className="text-body">Type both into the driver on the computer. The code pairs one computer, once, in the next <span data-countdown className="font-mono">{countdown}</span>.</p>
              : <p role="status" className="text-body text-muted-foreground">This code has expired. Make a new one.</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void make()} disabled={making}>{making ? "Making…" : "New code"}</Button>
              <Button size="sm" variant="ghost" onClick={() => setPairing(null)}>Done</Button>
            </div>
          </div>
        : <div className="mb-3 flex flex-wrap items-center gap-3">
            <Button size="sm" variant="primary" onClick={() => void make()} disabled={making}>{making ? "Making…" : "Pair a computer"}</Button>
            {joined && <p role="status" className="text-body text-success-text">Paired {joined}.</p>}
          </div>}
      {problem && <p role="alert" className="mb-3 border border-destructive/50 px-3 py-2 font-mono text-small text-destructive-text">{problem}</p>}
      {paired.length
        ? <ul className="border">
            {paired.map((computer) => (
              <li key={computer.id} data-paired={computer.id} className="border-b p-4 last:border-b-0">
                <div className="flex flex-wrap items-start gap-3">
                  {computer.serves.includes("phone") ? <Smartphone className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden /> : <Monitor className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span data-provider className="font-mono text-prose font-semibold">{computer.name}</span>
                      {computer.online ? <Chip tone="success">Online</Chip> : <Chip tone="muted">Offline</Chip>}
                      {computer.held_by_run && <Chip tone="active">In use by run {runLabel(computer.held_by_run)}</Chip>}
                      {computer.unserved && <Chip tone="warning">No agent can use it</Chip>}
                    </p>
                    {computer.unserved && <p data-unserved role="status" className="mt-1.5 text-small text-warning-text">{computer.unserved}</p>}
                    {computer.held_by_run && computer.held_until && <p data-held-until className="mt-1.5 text-small text-muted-foreground">The run's hold ends by {when(computer.held_until)}, released or not.</p>}
                    {!computer.online && <p className="mt-1.5 font-mono text-small text-muted-foreground">Open its driver on that computer: it dials this server.</p>}
                    <p data-machine className="mt-2 text-small text-muted-foreground">{machineOf(computer)}</p>
                    {computer.groups.length > 0 && <p data-offers className="mt-1 text-small text-muted-foreground">{offersOf(computer)}</p>}
                    <p className="mt-1 text-small text-muted-foreground">{`Driver ${computer.driver} · paired ${when(computer.created_at)}${computer.seen_at ? ` · last attached ${when(computer.seen_at)}` : ""}`}</p>
                  </div>
                  <Button size="sm" onClick={() => { setRemoving(computer.id); setProblem(null); }} disabled={removing !== null}>Remove</Button>
                </div>
                {removing === computer.id && (
                  <div data-confirm className="mt-4 flex flex-wrap items-center gap-3 border bg-card p-3">
                    <p className="min-w-0 flex-1 text-body">Remove {computer.name}? Its driver stops dialing and asks for a new code{computer.held_by_run ? ", and the run using it loses it" : ""}.</p>
                    <Button size="sm" variant="destructive" onClick={() => void remove(computer.id)}>Remove</Button>
                    <Button size="sm" onClick={() => setRemoving(null)}>Cancel</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        : <p className="border p-4 text-body text-muted-foreground">None paired yet. Pair a computer, then type the server address and its code into the driver on it.</p>}
    </section>
  );
}

function KindSection({ kind: k, providers, own, children }: { kind: ComputerKindView; providers: ComputerProvider[]; own: string[]; children: ReactNode }) {
  const { label, gives } = wordsOf(k.kind);
  return (
    <section aria-label={label}>
      <h2 className="mb-2 flex flex-wrap items-center gap-2">
        <span className="caps text-small font-semibold">{label}</span>
        {gives && <span className="text-small text-muted-foreground">{gives}</span>}
        {!k.offered && <Chip tone="muted">Not offered here</Chip>}
      </h2>
      {!k.offered && k.why && <p className="mb-2 font-mono text-small text-muted-foreground">{k.why}</p>}
      {own.length > 0 && <p className="mb-2 text-small text-muted-foreground">Also served by your computers: {own.join(", ")}.</p>}
      {providers.length
        ? <ul className="border">{children}</ul>
        : <p className="border p-4 text-body text-muted-foreground">{k.kind === "none" ? "Nothing to set up." : own.length ? "No other provider serves it on this server." : "No provider serves it on this server."}</p>}
    </section>
  );
}

type RowProps = {
  v2: Client;
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

function ProviderRow({ v2, kind, provider: p, writable, serves, tested, testing, open, problem, onOpen, onSave, onRemove, onTest }: RowProps) {
  const pasting = open && "paste" in open ? open.paste : null;
  const removing = open && "remove" in open ? open.remove : null;
  return (
    <li className="border-b p-4 last:border-b-0">
      <div className="flex flex-wrap items-start gap-3">
        <Monitor className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span data-provider className="font-mono text-prose font-semibold">{p.name}</span>
            {p.ready ? <Chip tone="success">Ready</Chip> : <Chip>Not ready</Chip>}
            {p.metered && <span data-metered className="text-small text-muted-foreground">Metered</span>}
          </p>
          {!p.ready && p.why && <p className="mt-1.5 font-mono text-small text-muted-foreground">{p.why}</p>}
          {p.metered && BY_THE_MINUTE.has(kind) && <p className="mt-1.5 text-small text-muted-foreground">{METERED}</p>}
          {p.secrets.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {/* SecretRow says a secret by its KEY (secretLabel); the PUT takes the KEY too. A row's buttons wait while its
                  form or confirm is open. */}
              {p.secrets.map((secret) => {
                const key = keyOf(secret.name);
                // A picked key is chosen from the vendor's list below (KeyChoices), never pasted.
                const picked = p.picked?.includes(secret.name) ?? false;
                return <SecretRow key={secret.name} field={secret} required={p.required.includes(secret.name)} writable={writable && !open}
                  {...(picked ? {} : { onPaste: () => onOpen({ paste: key }) })} onRemove={() => onOpen({ remove: key })} />;
              })}
            </ul>
          )}
          {p.picked && p.picked.length > 0 && p.required.every((name) => p.secrets.some((secret) => secret.name === name && secret.set)) && (
            <KeyChoices v2={v2} provider={p} writable={writable && !open} onSave={onSave} />
          )}
          {tested && (
            <p data-test className={`mt-2 text-small ${tested.ok ? "text-success-text" : "text-destructive-text"}`}>{`${tested.ok ? "Passed" : "Failed"} · ${clock(tested.at)} · ${tested.words}`}</p>
          )}
          <p className="mt-2 text-small text-muted-foreground">{p.secrets.length ? "" : "No key. "}Serves: {serves.join(", ")}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={onTest} disabled={testing}>{testing ? "Testing…" : "Test connection"}</Button>
        </div>
      </div>
      {writable && pasting && <ComputerKeyForm provider={p.name} name={pasting} set={p.secrets.some((secret) => keyOf(secret.name) === pasting && secret.set)} onSave={onSave} onCancel={() => onOpen(null)} />}
      {writable && removing && (
        <div data-confirm className="mt-4 flex flex-wrap items-center gap-3 border bg-card p-3">
          <p className="min-w-0 flex-1 text-body">Remove {removing} saved on this server?</p>
          <Button size="sm" variant="destructive" onClick={() => void onRemove(removing)}>Remove</Button>
          <Button size="sm" onClick={() => onOpen(null)}>Cancel</Button>
        </div>
      )}
      {problem && <p role="alert" className="mt-4 border border-destructive/50 px-3 py-2 font-mono text-small text-destructive-text">{problem}</p>}
    </li>
  );
}

/** A provider's picked keys (Orgo's workspace), once its required keys are saved: each one's choices as GET
 *  …/choices reads them from the vendor with those keys, in a Picker showing each by its label (a workspace's name,
 *  never its id) and the one saved now; picking one saves its value under the KEY (PUT …/keys), and the page reads
 *  everything again. Where there is none to pick, the server's why. One choice and none saved: it is used, said so.
 *  Read again whenever a key of the provider changes. */
function KeyChoices({ v2, provider: p, writable, onSave }: { v2: Client; provider: ComputerProvider; writable: boolean; onSave: RowProps["onSave"] }) {
  const [answer, setAnswer] = useState<ComputerChoices | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState<{ key: string; value: string } | null>(null);
  const stamp = p.secrets.map((secret) => `${secret.name}:${secret.set}:${secret.changed_at ?? ""}`).join(" ");
  useEffect(() => {
    let live = true;
    setAnswer(null); setProblem(null);
    v2.computerChoices(p.id).then((read) => { if (live) setAnswer(read); }, (e) => { if (live) setProblem(problemOf(e)); });
    return () => { live = false; };
  }, [v2, p.id, stamp]);
  const pick = async (choice: ComputerKeyChoices, value: string) => {
    setSaving({ key: choice.key, value }); setProblem(null);
    const refused = await onSave({ [choice.key]: value });
    setSaving(null);
    if (refused) setProblem(refused.fields?.map((f) => f.message).join(" ") || refused.message);
  };
  if (problem && !answer) return <p role="alert" className="mt-3 font-mono text-small text-destructive-text">{`The choices could not be read: ${problem}`}</p>;
  if (!answer) return <p role="status" className="mt-3 text-small text-muted-foreground">Reading the choices…</p>;
  return (
    <div className="mt-3 space-y-3">
      {answer.choices.map((choice) => {
        // The key as the page knows it: set from the environment, the server reads that and a pick here is never used;
        // set but not among the options (gone from the vendor's list), the server still uses the saved one until a pick.
        const secret = p.secrets.find((one) => keyOf(one.name) === choice.key);
        const env = secret?.source === "env";
        return (
          <div key={choice.key} data-choices={choice.key} className="border bg-card p-3">
            <p className="caps mb-2 text-small font-semibold">{choice.key}</p>
            {"why" in choice
              ? <p data-why className="font-mono text-small text-warning-text">{choice.why}</p>
              : <>
                  <Picker label={`${p.name} ${choice.key}`} value={saving?.key === choice.key ? saving.value : choice.saved ?? ""} disabled={!writable || env || saving !== null}
                    options={choice.options.map((option) => ({ value: option.value, label: option.label }))} placeholder="Pick one"
                    onChange={(value) => void pick(choice, value)} className="w-full max-w-md" />
                  <p data-choice-note className={`mt-2 text-small ${secret?.set && choice.saved === undefined ? "text-warning-text" : "text-muted-foreground"}`}>
                    {env ? `Set in the environment where AgentRun starts, and that one is used: change ${choice.key} there.`
                      : choice.saved !== undefined ? "Picked and saved on this server."
                      : secret?.set ? `The ${choice.key} saved on this server is not one of these any more, and runs still ask for it: pick one.`
                      : choice.options.length === 1 ? `The only one, ${choice.options[0]!.label}, is used while none is picked.`
                      : `${choice.options.length} to pick from. Pick the one this server's computers use.`}
                  </p>
                </>}
          </div>
        );
      })}
      {problem && <p role="alert" className="font-mono text-small text-destructive-text">{problem}</p>}
    </div>
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
        <span className="caps mb-2 block text-small font-semibold">{name}</span>
        {set && <span className="-mt-1 mb-2 block text-small text-muted-foreground">A new value replaces the one saved.</span>}
        <Input type="password" name={name} autoComplete="new-password" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true" />
        {invalid?.field && <span className="mt-2 block font-mono text-small text-destructive-text" role="alert">{invalid.field}</span>}
      </label>
      {invalid?.message && <p className="font-mono text-small text-destructive-text" role="alert">{invalid.message}</p>}
      <p className="text-small text-muted-foreground">Kept sealed on this server. It is never shown again, here or anywhere.</p>
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="solid" disabled={!typed || busy}>{busy ? "Saving" : "Save"}</Button>
        <Button type="button" size="sm" onClick={() => { clear(); onCancel(); }}>Cancel</Button>
      </div>
    </form>
  );
}
