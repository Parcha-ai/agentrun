import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChatGPTSignIn, WhatRunsHere } from "@/components/ChatGPTSignIn";
import { KEY_ADVICE, KeyForm } from "@/components/KeysPage";
import { RunError } from "@/components/RunError";
import { Button } from "@/components/ui/button";
import { isPlanModel, ownModel, planRuns } from "@/lib/chatgpt";
import { type Capabilities, type Client, ClientError } from "@/lib/client";
import type { HarnessInfo } from "@/lib/models";
import { secretLabel, type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ApiError, ChatGPTView, ToolKey } from "@/lib/v2";

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });

/** The first screen's card while capabilities' `models.ready` is false: no agent that names no model runs here yet. With
 *  `needs` `key`, it offers the server's model keys (GET /settings/tool-keys, `kind: "model"`) and saves the one picked
 *  through PUT /settings/tool-keys/{id}, with KeysPage's form, which never holds a value; `onSaved` reads the
 *  capabilities again, and the card goes once they say ready. With `needs` `model`, the server's AGENT_MODEL is the
 *  problem, which no key fixes: it says so. `model` is the server's default (`models.default`): when it names a
 *  provider among the keys (AGENT_MODEL set, its provider's key missing), only that key runs it, so the card offers that
 *  one alone and names the model. */
/** `plan`: the server's ChatGPT sign-in (GET /settings/chatgpt), null on a server without it. Offered, the card leads with
 *  "Continue with ChatGPT", the keys behind "Add a key" beside it; `onPlan` hears each state the sign-in moves to (the
 *  page keeps the card while one waits), and once signed in the card says who and OpenAI's words on usage until `onDone`.
 *  `harnesses`: the capabilities' harnesses, listed as what runs here. */
export function ModelKeyCard({ v2, needs, model, onSaved, writable, whyNot = "sign_in", plan, onPlan, onDone, harnesses, source, routePrefix }: { v2: Client; needs?: "key" | "model" | null; model?: string | null; onSaved?: () => void; writable: boolean; whyNot?: SecretsWhyNot; plan?: ChatGPTView | null; onPlan?: (v: ChatGPTView) => void; onDone?: () => void; harnesses?: readonly HarnessInfo[]; source?: Capabilities["models"]["source"]; routePrefix?: string | null }) {
  const [rows, setRows] = useState<ToolKey[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [planView, setPlanView] = useState(plan ?? null);
  useEffect(() => { setPlanView(plan ?? null); }, [plan]);
  const [keysOpen, setKeysOpen] = useState(false);
  const asked = useRef(0);
  const load = () => {
    const n = ++asked.current;
    v2.listToolKeys()
      .then((v) => { if (n === asked.current) { setRows(v.keys.filter((k) => k.kind === "model")); setLoadError(null); } })
      .catch((e) => { if (n === asked.current) setLoadError(apiError(e)); });
  };
  useEffect(() => { if (needs !== "model") load(); }, [v2, needs]); // eslint-disable-line react-hooks/exhaustive-deps
  // The default's provider, when the server's default names one of these keys: that key alone runs it. The plan's own
  // model (chatgpt/<id>, the default once signed in, or AGENT_MODEL's) names no key, also behind a gateway, which sends it
  // under its route prefix (agent-model/chatgpt/<id>). A gateway's other defaults keep the prefix as their "provider".
  const provider = model?.includes("/") && !isPlanModel(ownModel(model, routePrefix)) ? model.slice(0, model.indexOf("/")) : undefined;
  const required = rows?.find((k) => k.id === provider);
  const offered = required ? [required] : rows;
  const picked = rows?.find((k) => k.id === pick);
  // The fields this card may set: any not set in the environment (its secret, "model:<KEY>", says), which wins.
  const own = picked?.fields.filter((f) => picked.secrets.find((s) => secretLabel(s.name) === f.name)?.source !== "env") ?? [];
  // The ChatGPT sign-in, offered where it gives the server its model: not for a default the server names (AGENT_MODEL),
  // which only its provider's key runs. Offered, the keys wait behind "Add a key".
  const planOffered = !!planView && needs !== "model" && !provider;
  const keysShown = needs !== "model" && (!planOffered || keysOpen);
  const moved = (v: ChatGPTView) => { setPlanView(v); onPlan?.(v); };
  const whatRuns = harnesses && <WhatRunsHere harnesses={harnesses} />;

  // The first sign-in: who, and OpenAI's words on usage, until the person is done with them.
  if (planOffered && planView.state === "signed_in") return (
    <section className="border-b bg-card px-5 py-5 md:px-8" aria-label="Model key">
      <div className="flex gap-3">
        <KeyRound className="mt-1 size-4 shrink-0 text-success-text" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="text-prose font-semibold">Signed in with ChatGPT</h2>
          <ChatGPTSignIn v2={v2} view={planView} onView={moved} />
          {whatRuns}
          <Button type="button" size="sm" onClick={() => onDone?.()}>Done</Button>
        </div>
      </div>
    </section>
  );

  return (
    <section className="border-b bg-card px-5 py-5 md:px-8" aria-label="Model key">
      <div className="flex gap-3">
        <KeyRound className="mt-1 size-4 shrink-0 text-warning-text" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="text-prose font-semibold">{needs === "model" ? "This server's default model doesn't run" : planOffered ? "Sign in with ChatGPT or add a model key to run agents" : "Add a model key to run agents"}</h2>
          {needs === "model"
            ? <p className="text-body text-muted-foreground">The server's AGENT_MODEL names a model it doesn't know, so an agent that names no model can't run. Set AGENT_MODEL to a provider/model-id where the server starts, or name a model in each agent.</p>
            : required
            ? <p className="text-body text-muted-foreground">This server's default model is <span className="font-mono">{model}</span>, and no {required.label} key is set, so an agent that names no model can't run. Save the {required.label} key: such an agent then runs on that model.</p>
            : planOffered
            ? <>
                <p className="text-body text-muted-foreground">This server has no model yet, so an agent that names no model can't run.</p>
                <ChatGPTSignIn v2={v2} view={planView} onView={moved} writable={writable} whyNot={whyNot}
                  beside={<Button type="button" size="sm" aria-expanded={keysOpen} onClick={() => setKeysOpen((open) => !open)}>Add a key</Button>} />
                <p className="text-body text-muted-foreground">{planRuns(source, model, routePrefix)}</p>
                {keysOpen && <p className="text-body text-muted-foreground">{KEY_ADVICE}</p>}
              </>
            : <><p className="text-body text-muted-foreground">No model provider's key is set on this server, so an agent that names no model can't run. Save one: such an agent then runs on that provider's everyday model.</p>
              <p className="text-body text-muted-foreground">{KEY_ADVICE}</p></>}
          {keysShown && loadError && (
            <div role="alert">
              <p className="font-mono text-body text-destructive-text">The keys could not be read: {loadError.code}: {loadError.message}</p>
              <Button type="button" onClick={load} size="sm" className="mt-2">Try again</Button>
            </div>
          )}
          {keysShown && rows && !writable && <p className="text-body" role="status">{WHY_NOT_WORDS[whyNot]}</p>}
          {keysShown && rows && writable && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Provider">
              {offered!.map((k) => (
                <Button key={k.id} size="sm" variant={pick === k.id ? "solid" : "primary"} aria-pressed={pick === k.id} onClick={() => { setPick(pick === k.id ? null : k.id); setProblem(null); }}>{k.label}</Button>
              ))}
            </div>
          )}
          {keysShown && picked && writable && (own.length
            ? <KeyForm key={picked.id} tool={picked} fields={own} onCancel={() => setPick(null)}
                onSave={async (values) => {
                  setProblem(null);
                  try { await v2.saveToolKey(picked.id, values); } catch (e) {
                    if (e instanceof ClientError && e.status === 422) return e;
                    setProblem(apiError(e));
                    return null;
                  }
                  setPick(null);
                  load();
                  onSaved?.();
                  return null;
                }} />
            : <p className="text-body text-muted-foreground">The server sets the {picked.label} key when it starts: change it there.</p>)}
          {problem && <div className="border"><RunError error={problem} title="The key was not saved" /></div>}
          {whatRuns}
          <p className="text-small text-muted-foreground">Every key is in <a className="underline underline-offset-2 hover:text-foreground" href="#/settings/keys">Settings</a>, and so is a model gateway you already run (LiteLLM or another): Use a model gateway.</p>
        </div>
      </div>
    </section>
  );
}
