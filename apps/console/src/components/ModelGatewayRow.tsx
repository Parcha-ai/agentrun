import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Checkbox, Field, Input } from "@/components/ui/field";
import { Picker } from "@/components/ui/picker";
import { Segmented } from "@/components/ui/segmented";
import { type Client, ClientError } from "@/lib/client";
import { when } from "@/lib/format";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ModelGateway, ModelGatewayBody, ModelGatewayTest } from "@/lib/v2";

/** The row's name, and how other words name it ("Settings → Model keys → Use a model gateway"). */
export const GATEWAY_ROW = "Use a model gateway";
/** What the row is for, under its name. */
export const GATEWAY_RUNS = "Every model through an OpenAI-compatible gateway you already run, such as LiteLLM. While it is in use, the provider keys here are not used.";
/** What the environment's gateway means here: set where AgentRun starts, and it wins. */
export const GATEWAY_FROM_ENV = "Set where AgentRun starts (AGENT_MODEL_BASE_URL), and that one wins: change it there.";

type Tier = "default" | "fast" | "strong";
const TIERS: readonly { tier: Tier; label: string; variable: string; note: string }[] = [
  { tier: "default", label: "Default model", variable: "AGENT_MODEL", note: "What an agent that names no model runs on." },
  { tier: "fast", label: "Fast model", variable: "AGENT_MODEL_FAST", note: "A workflow's fast tier. None: it runs on the default." },
  { tier: "strong", label: "Strong model", variable: "AGENT_MODEL_STRONG", note: "A workflow's strong tier. None: it runs on the default." },
];
const IDS = [{ value: "as_named", label: "As named" }, { value: "bare", label: "Bare" }] as const;
const IDS_NOTE = "How the gateway takes a model an agent names: whole (openai/gpt-6.1-sol), or bare, the part after the provider (gpt-6.1-sol).";

const words = (e: unknown): string => (e instanceof ClientError ? e.message : e instanceof Error ? e.message : String(e));
/** A 422's words by field, as the server named them. */
const fieldErrors = (e: unknown): Record<string, string> => Object.fromEntries((e instanceof ClientError ? e.fields ?? [] : []).map((f) => [f.field, f.message]));

/** Settings → Model keys' "Use a model gateway" row, over /v2/settings/model-gateway. Off: a button that opens the form.
 *  The form takes the gateway's address, its key (a password field that is never filled from the server and is cleared
 *  after a save), how it takes model ids, and the model of each tier; Test asks the gateway which models it lists (the
 *  server asks, with the address and key typed), and the tiers are then picked from them. In use: the address, the id
 *  style, the models and whether a key is saved, with Change and Stop using it. Set where AgentRun starts: the same,
 *  read-only, with what to change there. A field whose variable is set at the start shows that value, read-only.
 *  `onChange`: after a save or a removal, which changes what every agent runs on. */
export function ModelGatewayRow({ v2, writable, whyNot = "sign_in", onChange }: { v2: Client; writable: boolean; whyNot?: SecretsWhyNot; onChange?: () => void }) {
  const [view, setView] = useState<ModelGateway | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    v2.modelGateway().then((body) => { if (live) setView(body); }, () => { if (live) setView(null); });
    return () => { live = false; };
  }, [v2]);
  if (!view) return null;

  const fromEnv = view.source === "env";
  const inUse = view.source !== null;
  const remove = async () => {
    setProblem(null); setBusy(true);
    try {
      setView(await v2.removeModelGateway());
      setRemoving(false);
      onChange?.();
    } catch (e) {
      setProblem(words(e));
    } finally {
      setBusy(false);
    }
  };
  const chip = view.problem ? <Chip tone="warning">refused</Chip> : fromEnv ? <Chip tone="success">set at start</Chip> : inUse ? <Chip tone="success">in use</Chip> : <Chip tone="plain">off</Chip>;
  return (
    <li aria-label={GATEWAY_ROW} className="border-b p-4 last:border-b-0">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-prose font-semibold">{GATEWAY_ROW}</span>
        {chip}
      </p>
      <p className="mt-1.5 font-mono text-small text-muted-foreground">{GATEWAY_RUNS}</p>
      <div className="mt-3 space-y-3">
        {inUse && !editing && <Summary view={view} />}
        {view.problem && <p className="font-mono text-small text-warning-text" role="status">{view.problem}</p>}
        {fromEnv && <p className="text-small text-muted-foreground">{GATEWAY_FROM_ENV}</p>}
        {!fromEnv && !writable && <p className="text-body" role="status">{WHY_NOT_WORDS[whyNot]}</p>}
        {!fromEnv && writable && !editing && !removing && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant={inUse ? "outline" : "primary"} onClick={() => { setEditing(true); setProblem(null); }}>{inUse ? "Change" : GATEWAY_ROW}</Button>
            {inUse && <Button type="button" size="sm" variant="destructive" onClick={() => { setRemoving(true); setProblem(null); }}>Stop using it</Button>}
          </div>
        )}
        {removing && (
          <div role="alertdialog" aria-label="Stop using the model gateway" className="flex flex-wrap items-center gap-3 border bg-card p-3">
            <p className="min-w-0 flex-1 text-body">Stop using this gateway, and remove its saved key? Agents then run on the provider keys here.</p>
            <Button size="sm" autoFocus onClick={() => setRemoving(false)}>Keep</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>Stop using it</Button>
          </div>
        )}
        {editing && <GatewayForm v2={v2} view={view} onCancel={() => setEditing(false)} onSaved={(next) => { setView(next); setEditing(false); onChange?.(); }} />}
        {problem && <p className="font-mono text-small text-destructive-text" role="alert">{problem}</p>}
      </div>
    </li>
  );
}

/** The gateway in use, as the page reads it: never its key, only whether one is set and where from. */
function Summary({ view }: { view: ModelGateway }) {
  const key = view.secret.set ? (view.secret.source === "env" ? "set where AgentRun starts" : `saved${view.secret.changed_at ? ` · ${when(view.secret.changed_at)}` : ""}`) : "none (each run brings its own)";
  const rows: [string, string][] = [
    ["Address", view.base_url ?? ""],
    ["Key", key],
    ["Model ids", view.ids === "bare" ? "bare" : "as named"],
    ...TIERS.map(({ tier, label }) => [label, view.models[tier] ?? "none"] as [string, string]),
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-small">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="caps text-label text-muted-foreground">{name}</dt>
          <dd className="min-w-0 break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The form. The key's input is uncontrolled, so its value is never in the page's state or the DOM's attributes. */
function GatewayForm({ v2, view, onCancel, onSaved }: { v2: Client; view: ModelGateway; onCancel: () => void; onSaved: (view: ModelGateway) => void }) {
  const [base, setBase] = useState(view.base_url ?? "");
  const [ids, setIds] = useState<ModelGateway["ids"]>(view.ids);
  const [models, setModels] = useState<Record<Tier, string>>({ default: view.models.default ?? "", fast: view.models.fast ?? "", strong: view.models.strong ?? "" });
  const [noKey, setNoKey] = useState(false);
  const [listed, setListed] = useState<string[] | null>(null);
  const [tested, setTested] = useState<ModelGatewayTest | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const atStart = (variable: string) => view.set_at_start.includes(variable);
  const typedKey = () => keyRef.current?.value.trim() || undefined;

  const test = async () => {
    setTesting(true); setTested(null); setErrors({});
    try {
      // "Use no key" tests with none (api_key null), never the saved key, so a test that passes is what Save will use.
      const key = typedKey();
      const answer = await v2.testModelGateway({ ...(base.trim() ? { base_url: base.trim() } : {}), ...(noKey ? { api_key: null } : key ? { api_key: key } : {}) });
      setTested(answer);
      if (answer.ok) {
        setListed(answer.models);
        // The default, when none is picked yet, is the first model the gateway lists: shown, and changed before a save.
        if (!models.default && !atStart("AGENT_MODEL") && answer.models[0]) setModels((m) => ({ ...m, default: answer.models[0]! }));
      }
    } catch (e) {
      setErrors(fieldErrors(e));
      setTested({ ok: false, why: words(e) });
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setErrors({}); setProblem(null);
    const key = typedKey();
    const body: ModelGatewayBody = {
      base_url: base.trim(),
      ...(noKey ? { api_key: null } : key ? { api_key: key } : {}),
      ...(atStart("AGENT_MODEL_GATEWAY_IDS") ? {} : { ids }),
      models: Object.fromEntries(TIERS.filter(({ variable }) => !atStart(variable)).flatMap(({ tier }): [Tier, string | null][] => (models[tier] ? [[tier, models[tier]]] : tier === "default" ? [] : [[tier, null]]))),
    };
    try {
      const next = await v2.saveModelGateway(body);
      if (keyRef.current) keyRef.current.value = "";
      onSaved(next);
    } catch (e) {
      const byField = fieldErrors(e);
      setErrors(byField);
      if (!Object.keys(byField).length) setProblem(words(e));
    } finally {
      setSaving(false);
    }
  };

  const modelField = ({ tier, label, variable, note }: (typeof TIERS)[number]) => {
    if (atStart(variable)) return (
      <Field key={tier} label={label} hint={`Set where AgentRun starts (${variable}), and that one wins.`}>
        <Input value={view.models[tier] ?? ""} readOnly />
      </Field>
    );
    const value = models[tier];
    const set = (next: string) => setModels((m) => ({ ...m, [tier]: next }));
    const options = [...(tier === "default" ? [] : [{ value: "", label: "None" }]), ...[...new Set([...(listed ?? []), ...(value ? [value] : [])])].map((id) => ({ value: id, label: id }))];
    return (
      <Field key={tier} label={label} required={tier === "default"} optional={tier !== "default"} note={note} error={errors[`models.${tier}`]}>
        {listed?.length
          ? <Picker label={label} value={value} onChange={set} options={options} placeholder="Pick a model" />
          : <Input name={`model_${tier}`} value={value} onChange={(e) => set(e.target.value)} placeholder={tier === "default" ? "Test the gateway to list its models" : "None"} autoComplete="off" spellCheck={false} />}
      </Field>
    );
  };

  return (
    <form className="space-y-4 border bg-background p-4" aria-label="Model gateway" onSubmit={(e) => void save(e)}>
      <Field label="Gateway address" required note="Its OpenAI-compatible API, such as https://gateway.example/v1: https, or http on this machine." error={errors.base_url}>
        <Input name="base_url" type="url" value={base} onChange={(e) => setBase(e.target.value)} placeholder="https://gateway.example/v1" autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Key" optional note={view.secret.set && view.secret.source === "console" ? "A key is saved: leave this empty to keep it (for the same address)." : "Sent as a bearer token, kept sealed here, never shown again. None: each run brings its own (model_key)."} error={errors.api_key}>
        <Input ref={keyRef} name="api_key" type="password" autoComplete="off" disabled={noKey} placeholder={view.secret.set && view.secret.source === "console" ? "Saved" : ""} />
      </Field>
      {view.secret.set && view.secret.source === "console" && <Checkbox name="no_key" checked={noKey} onChange={(e) => setNoKey(e.target.checked)} label="Use no key" note="The saved key is removed when you save." />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" disabled={testing || (!base.trim() && !view.base_url)} aria-busy={testing || undefined} onClick={() => void test()}>{testing ? "Testing" : "Test"}</Button>
        {tested?.ok && <p className="text-small text-success-text" role="status">The gateway lists {tested.models.length} {tested.models.length === 1 ? "model" : "models"}{tested.models.length ? ": pick the defaults below." : "."}</p>}
      </div>
      {tested && !tested.ok && <p className="font-mono text-small text-destructive-text" role="alert">{tested.why}</p>}
      <Field label="Model ids" group="heading" note={atStart("AGENT_MODEL_GATEWAY_IDS") ? "Set where AgentRun starts (AGENT_MODEL_GATEWAY_IDS), and that one wins." : IDS_NOTE}>
        {atStart("AGENT_MODEL_GATEWAY_IDS")
          ? <p className="font-mono text-body">{view.ids === "bare" ? "Bare" : "As named"}</p>
          : <Segmented label="Model ids" name="ids" value={ids} onChange={setIds} options={IDS} />}
      </Field>
      {TIERS.map(modelField)}
      {problem && <p className="font-mono text-small text-destructive-text" role="alert">{problem}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" variant="primary" disabled={saving} aria-busy={saving || undefined}>{saving ? "Saving" : "Save"}</Button>
      </div>
    </form>
  );
}
