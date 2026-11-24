import { SettingsSection, settingsBodyClass, settingsIntroClass, settingsPageClass } from "@/components/Settings";
import { KeyRound } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { RunError } from "@/components/RunError";
import { ListSkeleton } from "@/components/Skeleton";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Field, Input } from "@/components/ui/field";
import { type Client, ClientError } from "@/lib/client";
import { when } from "@/lib/format";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ApiError, ApiKey, ApiKeyMade } from "@/lib/v2";

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });
/** The longest name a key takes (the server's API_KEY_NAME_MAX). */
const NAME_MAX = 64;

/** The two lines an app's environment takes for this server: where it is, and the key. */
export const envLines = (origin: string, key: string): string => `AGENTRUN_URL=${origin}\nAGENTRUN_API_KEY=${key}`;

/** Settings → AgentRun API keys (GET and POST /v2/settings/api-keys, DELETE .../{id}, a serve extension): the keys an
 *  app sends to call this server. Each key's name, when it was made and when it was last used; a form that makes one,
 *  whose value is shown only in the answer that made it, copied with one press, and never kept in the page after Done;
 *  and Revoke for each, asked first. Making and revoking take the owner's session (`writable`); any session reads the
 *  list. `origin`: the address this console is open at, which the copied lines name as AGENTRUN_URL. */
export function ApiKeysPage({ v2, writable, whyNot = "sign_in", origin }: { v2: Client; writable: boolean; whyNot?: SecretsWhyNot; origin: string }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [limit, setLimit] = useState<number | null>(null);
  // Why this server makes no key now, in its own words (it is one person's); null when it makes them.
  const [refused, setRefused] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [made, setMade] = useState<ApiKeyMade | null>(null);
  const [problem, setProblem] = useState<{ title: string; error: ApiError } | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // Revoke, asked first, in the key's own row. Cancel puts the focus back on that row's button.
  const [revoking, setRevoking] = useState<string | null>(null);
  const revokeButtons = useRef(new Map<string, HTMLButtonElement>());
  // A new key takes the focus once the page has drawn it, so a keyboard and a screen reader land on it.
  const madeBox = useRef<HTMLElement>(null);
  const [focusMade, setFocusMade] = useState(false);
  const asked = useRef(0);
  const load = () => {
    const n = ++asked.current;
    v2.apiKeys()
      .then((v) => { if (n === asked.current) { setKeys(v.keys); setLimit(v.limit); setRefused(v.refused ?? null); setLoadError(null); } })
      .catch((e) => { if (n === asked.current) setLoadError(apiError(e)); });
  };
  useEffect(load, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focusMade || !made) return;
    madeBox.current?.focus();
    setFocusMade(false);
  }, [focusMade, made]);
  const act = async (title: string, work: () => Promise<unknown>) => {
    setProblem(null); setBusy(true);
    try { await work(); } catch (e) { setProblem({ title, error: apiError(e) }); } finally { setBusy(false); }
    load();
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void act("The key was not made", async () => {
      // Shown this once: the answer that made it holds it, and nothing reads it again.
      setMade(await v2.createApiKey(name.trim()));
      setName("");
      setFocusMade(true);
    });
  };
  const cancelRevoke = (id: string) => { setRevoking(null); requestAnimationFrame(() => revokeButtons.current.get(id)?.focus()); };
  const revoke = (key: ApiKey) => {
    setRevoking(null);
    void act("The key was not revoked", async () => {
      await v2.revokeApiKey(key.id);
      // The key just shown is gone with its revocation: its panel would offer a key that opens nothing.
      setMade((shown) => (shown?.id === key.id ? null : shown));
    });
  };

  if (!keys) return loadError
    ? <Banner tone="error" className="m-8" actions={<Button type="button" size="xs" onClick={load}>Try again</Button>}><p className="font-mono">The API keys could not be read: {loadError.code}: {loadError.message}</p></Banner>
    : <div className={settingsPageClass}><ListSkeleton label="Loading API keys" rows={3} /></div>;
  const full = limit !== null && keys.length >= limit;
  return (
    <div className="h-full overflow-auto">
      <div className={settingsPageClass}>
        <div className={settingsIntroClass}>
          <p className="caps text-label text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">AgentRun API keys</h1>
          <p className="mt-2 text-lead text-muted-foreground">Keys your apps send to call this server: its API under <span className="font-mono">/v2</span> and its MCP endpoint. An app sends one as <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>. To save a model or tool provider's key instead, open <a className="underline" href="#/settings/keys">API Keys</a>.</p>
        </div>
        <div className={settingsBodyClass}>
          {problem && <RunError error={problem.error} title={problem.title} />}
          {loadError && (
            <Banner tone="error" actions={<Button type="button" size="xs" onClick={load}>Try again</Button>}>
              <p className="font-mono">The API keys could not be read: {loadError.code}: {loadError.message}. What is shown may be out of date.</p>
            </Banner>
          )}
          {made && (
            <section ref={madeBox} tabIndex={-1} className="border border-warning/50 bg-warning/5 p-4 outline-none" aria-label="New API key">
              <p className="caps text-small font-semibold text-warning-text">The key for {made.name}, shown this once</p>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2"><code className="min-w-0 break-all font-mono text-body">{made.api_key}</code><CopyButton text={made.api_key} label="Copy key" /></div>
              <p className="mt-3 text-body text-muted-foreground">Keep it in your app's secrets, never in a repository. This server never shows it again: if it is lost, revoke it and make another.</p>
              <p className="mt-3 text-body text-muted-foreground">As environment variables, for an app that reads them:</p>
              <div className="mt-2 flex min-w-0 flex-wrap items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto border bg-card p-3 font-mono text-small" aria-label="Environment variables">{envLines(origin, made.api_key)}</pre>
                <CopyButton text={envLines(origin, made.api_key)} label="Copy both" />
              </div>
              <Button type="button" variant="outline" className="mt-3" onClick={() => setMade(null)}>Done</Button>
            </section>
          )}
          <SettingsSection title="Make a key" note={<p>One key for each app, so revoking one stops that app alone. The key is shown once, here, when it is made.</p>}>
            <form className="border bg-card p-4" onSubmit={create} aria-label="Make an API key">
              {!writable && <p role="status" className="mb-3 text-body text-muted-foreground">{WHY_NOT_WORDS[whyNot]}</p>}
              {refused && <p role="status" className="mb-3 text-body text-warning-text">{refused}</p>}
              {full && <p role="status" className="mb-3 text-body text-warning-text">This server keeps at most {limit} keys. Revoke one you no longer use to make another.</p>}
              <Field label="Name" hint="What the key is for: the app or the person that will hold it.">
                <Input name="name" required maxLength={NAME_MAX} autoComplete="off" placeholder="For example: billing app" value={name} disabled={!writable || full || !!refused} onChange={(e) => setName(e.target.value)} />
              </Field>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button type="submit" variant="primary" disabled={busy || !writable || full || !!refused || !name.trim()}>Make key</Button>
              </div>
            </form>
          </SettingsSection>
          <SettingsSection label="Keys" title={limit === null ? "Keys" : `Keys · ${keys.length} of ${limit}`} note={<p>A token this server was started with (<span className="font-mono">AGENTRUN_TOKEN</span>) is set in its environment and is not listed here.</p>}>
            {keys.length === 0
              ? <p className="border p-4 text-body text-muted-foreground">No key has been made yet.</p>
              : (
                <ul className="border">
                  {keys.map((key) => (
                    <li key={key.id} className="border-b px-4 py-3 text-body last:border-b-0">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 break-words font-semibold">{key.name}</span>
                        <span className="text-small text-muted-foreground">Made {when(key.created_at)}</span>
                        <span className="text-small text-muted-foreground">{key.last_used_at ? `Last used ${when(key.last_used_at)}` : "Never used"}</span>
                        {writable && revoking !== key.id && (
                          <Button ref={(node) => { if (node) revokeButtons.current.set(key.id, node); else revokeButtons.current.delete(key.id); }} type="button" variant="outline" size="sm" disabled={busy} aria-label={`Revoke ${key.name}`} onClick={() => setRevoking(key.id)}>Revoke</Button>
                        )}
                      </div>
                      {revoking === key.id && (
                        <div role="alertdialog" aria-label={`Revoke ${key.name}?`} className="mt-3 flex flex-wrap items-center gap-2" onKeyDown={(e) => { if (e.key === "Escape") cancelRevoke(key.id); }}>
                          <span>Every app that sends this key is refused at once. This cannot be undone.</span>
                          <Button type="button" variant="ghost" autoFocus onClick={() => cancelRevoke(key.id)}>Cancel</Button>
                          <Button type="button" variant="destructive" disabled={busy} onClick={() => revoke(key)}>Revoke the key</Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
