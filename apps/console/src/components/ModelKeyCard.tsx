import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { KeyForm } from "@/components/KeysPage";
import { RunError } from "@/components/RunError";
import { Button } from "@/components/ui/button";
import { type Client, ClientError } from "@/lib/client";
import { secretLabel, type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ApiError, ToolKey } from "@/lib/v2";

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });

/** The first screen's card while capabilities' `models.ready` is false: no agent that names no model runs here yet. With
 *  `needs` `key`, it offers the server's model keys (GET /settings/tool-keys, `kind: "model"`) and saves the one picked
 *  through PUT /settings/tool-keys/{id}, with KeysPage's form, which never holds a value; `onSaved` reads the
 *  capabilities again, and the card goes once they say ready. With `needs` `model`, the server's AGENT_MODEL is the
 *  problem, which no key fixes: it says so. `model` is the server's default (`models.default`): when it names a
 *  provider among the keys (AGENT_MODEL set, its provider's key missing), only that key runs it, so the card offers that
 *  one alone and names the model. `atRest` is `features.tool_keys.at_rest`. */
export function ModelKeyCard({ v2, needs, model, atRest, onSaved, writable, whyNot = "sign_in" }: { v2: Client; needs?: "key" | "model" | null; model?: string | null; atRest?: "sealed" | "unavailable"; onSaved?: () => void; writable: boolean; whyNot?: SecretsWhyNot }) {
  const [rows, setRows] = useState<ToolKey[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [noSealing, setNoSealing] = useState(false);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const asked = useRef(0);
  const load = () => {
    const n = ++asked.current;
    v2.listToolKeys()
      .then((v) => { if (n === asked.current) { setRows(v.keys.filter((k) => k.kind === "model")); setLoadError(null); } })
      .catch((e) => { if (n === asked.current) setLoadError(apiError(e)); });
  };
  useEffect(() => { if (needs !== "model") load(); }, [v2, needs]); // eslint-disable-line react-hooks/exhaustive-deps
  // The default's provider, when the server's default names one of these keys: that key alone runs it.
  const provider = model?.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
  const required = rows?.find((k) => k.id === provider);
  const offered = required ? [required] : rows;
  const cantStore = atRest === "unavailable" || noSealing;
  const picked = rows?.find((k) => k.id === pick);
  // The fields this card may set: any not set in the environment (its secret, "model:<KEY>", says), which wins.
  const own = picked?.fields.filter((f) => picked.secrets.find((s) => secretLabel(s.name) === f.name)?.source !== "env") ?? [];

  return (
    <section className="border-b bg-card px-5 py-5 md:px-8" aria-label="Model key">
      <div className="mx-auto flex max-w-[1600px] gap-3">
        <KeyRound className="mt-1 size-4 shrink-0 text-warning-text" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <h2 className="text-[15px] font-semibold">{needs === "model" ? "This server's default model doesn't run" : "Add a model key to run agents"}</h2>
          {needs === "model"
            ? <p className="text-[13px] text-muted-foreground">The server's AGENT_MODEL names a model it doesn't know, so an agent that names no model can't run. Set AGENT_MODEL to a provider/model-id where the server starts, or name a model in each agent.</p>
            : required
            ? <p className="text-[13px] text-muted-foreground">This server's default model is <span className="font-mono">{model}</span>, and no {required.label} key is set, so an agent that names no model can't run. Save the {required.label} key: such an agent then runs on that model.</p>
            : <p className="text-[13px] text-muted-foreground">No model provider's key is set on this server, so an agent that names no model can't run. Save one: such an agent then runs on that provider's everyday model.</p>}
          {needs !== "model" && loadError && (
            <div role="alert">
              <p className="font-mono text-[13px] text-destructive-text">The keys could not be read: {loadError.code}: {loadError.message}</p>
              <button type="button" onClick={load} className="caps mt-2 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>
            </div>
          )}
          {needs !== "model" && rows && cantStore && (
            <p className="font-mono text-[13px]" role="status">This server can't store keys: it was started without a seal key. Set one where the server starts ({rows.flatMap((k) => k.fields.map((f) => f.name)).join(", ")}).</p>
          )}
          {needs !== "model" && rows && !cantStore && !writable && <p className="text-[13px]" role="status">{WHY_NOT_WORDS[whyNot]}</p>}
          {needs !== "model" && rows && !cantStore && writable && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Provider">
              {offered!.map((k) => (
                <Button key={k.id} size="sm" variant={pick === k.id ? "solid" : "primary"} aria-pressed={pick === k.id} onClick={() => { setPick(pick === k.id ? null : k.id); setProblem(null); }}>{k.label}</Button>
              ))}
            </div>
          )}
          {picked && !cantStore && writable && (own.length
            ? <KeyForm key={picked.id} tool={picked} fields={own} cantStore={cantStore} onCancel={() => setPick(null)}
                onSave={async (values) => {
                  setProblem(null);
                  try { await v2.saveToolKey(picked.id, values); } catch (e) {
                    if (e instanceof ClientError && e.status === 422) return e;
                    if (e instanceof ClientError && e.code === "no_sealing_key") setNoSealing(true);
                    else setProblem(apiError(e));
                    return null;
                  }
                  setPick(null);
                  load();
                  onSaved?.();
                  return null;
                }} />
            : <p className="text-[13px] text-muted-foreground">The server sets the {picked.label} key when it starts: change it there.</p>)}
          {problem && <div className="border"><RunError error={problem} title="The key was not saved" /></div>}
          <p className="text-[12px] text-muted-foreground">Every key is in <a className="underline underline-offset-2 hover:text-foreground" href="#/settings/keys">Settings</a>.</p>
        </div>
      </div>
    </section>
  );
}
