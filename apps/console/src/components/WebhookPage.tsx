import { TriangleAlert, Webhook as WebhookIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { RunError } from "@/components/RunError";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { type Client, ClientError } from "@/lib/client";
import type { ApiError, Webhook, WebhookAttempt } from "@/lib/v2";

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });
const when = (iso: string) => new Date(iso).toLocaleString();
const SIGNING: Record<Exclude<Extract<Webhook, { configured: true }>["signing"], "sealed">, string> = {
  seal_key_missing: "Its secret can't sign here: this server was started without its seal key. Restart it with its original seal key (AGENTRUN_SEAL_KEY) to send messages again. Removing the webhook drops the messages waiting, and it can't be set again without a seal key.",
  unreadable: "Its secret can't sign here: it was sealed under another key, or is damaged. Nothing is sent until the webhook is removed and set again.",
};

/** Settings → Webhook (GET, PUT and DELETE /v2/settings/webhook, a serve extension): the URL run notices are POSTed to,
 *  signed by the Standard Webhooks spec; whether its secret signs here; why it is off; the secret, shown only on the
 *  save that made it and never kept in the page after; a test send; and the last attempts (GET .../deliveries), newest
 *  first, with the receiver's answer or why each failed, and a redelivery of any (POST .../redeliver). `atRest` is
 *  capabilities' `features.webhooks.at_rest`: with no seal key, the server keeps no secret, so no webhook is set. */
export function WebhookPage({ v2, atRest }: { v2: Client; atRest?: "sealed" | "unavailable" }) {
  const [webhook, setWebhook] = useState<Webhook | null>(null);
  const [attempts, setAttempts] = useState<WebhookAttempt[]>([]);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ title: string; error: ApiError } | null>(null);
  const [tested, setTested] = useState<WebhookAttempt | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const asked = useRef(0);
  const load = () => {
    const n = ++asked.current;
    Promise.all([v2.webhook(), v2.webhookDeliveries()])
      .then(([w, d]) => { if (n === asked.current) { setWebhook(w); setAttempts(d.attempts); setLoadError(null); if (w.configured) setUrl((u) => u || w.url); } })
      .catch((e) => { if (n === asked.current) setLoadError(apiError(e)); });
  };
  useEffect(load, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (title: string, work: () => Promise<unknown>) => {
    setProblem(null); setBusy(true);
    try { await work(); } catch (e) { setProblem({ title, error: apiError(e) }); } finally { setBusy(false); }
    load();
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act("The webhook was not saved", async () => {
      const saved = await v2.saveWebhook(url.trim());
      // Shown this once: the answer that made it holds it, and nothing reads it again. The answer is the webhook as
      // saved, shown at once, whatever the read after it does.
      if (saved.secret) setSecret(saved.secret);
      const { secret: _shown, ...view } = saved;
      setWebhook(view);
    });
  };
  const cantStore = atRest === "unavailable";

  if (!webhook) return loadError
    ? <div className="m-8 border p-4" role="alert"><p className="font-mono text-[13px] text-destructive-text">The webhook could not be read: {loadError.code}: {loadError.message}</p><button type="button" onClick={load} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button></div>
    : <p className="p-8 text-center font-mono text-[13px] text-muted-foreground">Loading...</p>;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        <div>
          <p className="caps text-[11px] text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">Webhook</h1>
          <p className="mt-2 text-[14px] text-muted-foreground">One URL this server POSTs to when a run needs its person (`run.needs_input`) and when it ends (`run.ended`), signed by the Standard Webhooks spec, so a receiver checks each message with any of that spec's libraries.</p>
        </div>
        {problem && <RunError error={problem.error} title={problem.title} />}
        {loadError && (
          <div className="border p-4" role="alert">
            <p className="font-mono text-[13px] text-destructive-text">The webhook could not be read: {loadError.code}: {loadError.message}. What is shown may be out of date.</p>
            <button type="button" onClick={load} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>
          </div>
        )}
        {secret && (
          <section className="border border-warning/50 bg-warning/5 p-4" aria-label="Webhook secret">
            <p className="caps text-[12px] font-semibold text-warning-text">The signing secret, shown this once</p>
            <p className="mt-2 break-all font-mono text-[13px]">{secret}</p>
            <p className="mt-2 text-[13px] text-muted-foreground">Keep it where the receiver checks <span className="font-mono">webhook-signature</span>. This server never shows it again.</p>
            <Button type="button" variant="outline" className="mt-3" onClick={() => setSecret(null)}>Done</Button>
          </section>
        )}
        <section className="border bg-card p-4" aria-label="Webhook URL">
          <div className="flex items-center gap-2">
            <WebhookIcon className="size-4 text-muted-foreground" aria-hidden />
            {webhook.configured
              ? <span className="min-w-0 break-all font-mono text-[13px]">{webhook.url}</span>
              : <span className="text-[13px] text-muted-foreground">No webhook is set.</span>}
            {webhook.configured && (webhook.disabled ? <Chip tone="error">off</Chip> : webhook.signing === "sealed" ? <Chip tone="success">on</Chip> : <Chip tone="warning">not signing</Chip>)}
          </div>
          {webhook.configured && webhook.disabled && <p className="mt-2 text-[13px] text-destructive-text">Off: {webhook.disabled.reason}, {when(webhook.disabled.at)}. Nothing is sent until the URL is saved again.</p>}
          {webhook.configured && webhook.signing !== "sealed" && (
            <p className="mt-2 flex gap-2 text-[13px] text-warning-text"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />{SIGNING[webhook.signing]}</p>
          )}
          {cantStore && !webhook.configured && <p className="mt-2 text-[13px] text-muted-foreground" role="status">This server can't keep a webhook secret: it was started without a seal key, and never keeps one in the clear.</p>}
          <form className="mt-4 flex flex-wrap gap-2" onSubmit={save}>
            <input name="url" type="url" required maxLength={2048} placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)}
              className="h-9 min-w-[280px] flex-1 border bg-background px-3 font-mono text-[13px]" aria-label="Webhook URL" disabled={cantStore && !webhook.configured} />
            <Button type="submit" variant="solid" disabled={busy || (cantStore && !webhook.configured) || !url.trim()}>Save</Button>
            {webhook.configured && <Button type="button" variant="outline" disabled={busy} onClick={() => act("The test was not sent", async () => setTested(await v2.testWebhook()))}>Send a test</Button>}
            {webhook.configured && !removing && <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoving(true)}>Remove</Button>}
          </form>
          {removing && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
              <span>Its pending messages are dropped; the log of attempts stays.</span>
              <Button type="button" variant="destructive" disabled={busy} onClick={() => { setRemoving(false); setUrl(""); setTested(null); void act("The webhook was not removed", async () => { await v2.removeWebhook(); setWebhook({ configured: false }); setSecret(null); }); }}>Remove the webhook</Button>
              <Button type="button" variant="ghost" onClick={() => setRemoving(false)}>Cancel</Button>
            </div>
          )}
          {tested && <p className="mt-3 font-mono text-[13px]" aria-label="Test send">Test send: {outcome(tested)}</p>}
        </section>
        <section aria-label="Deliveries">
          <div className="flex items-center justify-between">
            <h2 className="caps text-[12px] font-semibold text-muted-foreground">Last deliveries</h2>
            <Button type="button" variant="ghost" onClick={load}>Refresh</Button>
          </div>
          {attempts.length === 0
            ? <p className="mt-2 border p-4 text-[13px] text-muted-foreground">No message has been tried yet.</p>
            : (
              <ul className="mt-2 border">
                {attempts.map((a, i) => (
                  <li key={`${a.webhook_id}:${a.at}:${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-3 text-[13px] last:border-b-0">
                    <span className="w-[170px] shrink-0 text-muted-foreground">{when(a.at)}</span>
                    <span className="w-[130px] shrink-0 font-mono">{a.type}</span>
                    <span className={a.error ? "min-w-0 flex-1 font-mono text-destructive-text" : "min-w-0 flex-1 font-mono"}>{outcome(a)}</span>
                    {a.redelivery && <Chip>redelivery</Chip>}
                    <span className="font-mono text-[12px] text-muted-foreground" title={a.webhook_id}>{a.webhook_id.slice(0, 12)}…</span>
                    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => act("The message was not sent again", () => v2.redeliverWebhook(a.webhook_id))}>Redeliver</Button>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </div>
    </div>
  );
}

/** An attempt as one line: the answer and how long it took, or why it failed, and when it is tried again. */
function outcome(a: WebhookAttempt): string {
  const answer = a.error ?? `${a.status_code}`;
  const took = a.status_code !== null ? `, ${a.latency_ms} ms` : "";
  return `${answer}${took}${a.retry_at ? `; tried again ${when(a.retry_at)}` : ""}`;
}
