import { SettingsSection, settingsBodyClass, settingsIntroClass, settingsPageClass } from "@/components/Settings";
import { MessageSquare, TriangleAlert } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { RunError } from "@/components/RunError";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Banner } from "@/components/ui/banner";
import { Field, Input } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { type Client, ClientError } from "@/lib/client";
import { when } from "@/lib/format";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ApiError, Slack, SlackAttempt } from "@/lib/v2";

const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });
type Event = keyof Slack["events"];
/** Each event Slack can be sent, in the order shown, with what it posts. */
const EVENTS: { id: Event; label: string; note: string }[] = [
  { id: "run.ended", label: "A run ends", note: "Completed, failed or cancelled: the agent, the status, the run's title and a link to it." },
  { id: "run.needs_input", label: "A run needs you", note: "A question, an approval, a paused cap or a hand-over: what it waits on, and a link to answer it." },
  { id: "trigger.failed", label: "A trigger fails", note: "A trigger's firing could not start its run: the trigger's name and the error." },
];
const UNSET: Slack = { configured: false, secret: { name: "slack:outbound", set: false, source: null, changed_at: null }, events: { "run.ended": true, "run.needs_input": true, "trigger.failed": true } };

/** Settings → Slack (GET, PUT and DELETE /v2/settings/slack, a serve extension): the Slack incoming-webhook URL run
 *  notices are posted to, shown only by its last four characters (the URL is the credential, saved only from the owner's
 *  session and never shown again); which events are posted, each switched on or off at once; why Slack is off; a test
 *  message; and the last attempts (GET .../deliveries), newest first, with Slack's answer or why each failed. */
export function SlackPage({ v2, writable, whyNot = "sign_in" }: {
  v2: Client;
  /** Whether this session may save or remove the URL: the session read's secrets_writable (lib/secrets.ts useSecrets). */
  writable: boolean;
  whyNot?: SecretsWhyNot;
}) {
  const [slack, setSlack] = useState<Slack | null>(null);
  const [attempts, setAttempts] = useState<SlackAttempt[]>([]);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState<{ title: string; error: ApiError } | null>(null);
  const [tested, setTested] = useState<SlackAttempt | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  // What the person types. A saved URL is never read back (the server shows its last four characters), so the field
  // starts empty and a save sends only a URL typed here.
  const [url, setUrl] = useState("");
  const asked = useRef(0);
  // The inline confirm gives the focus back to Remove when it closes without removing.
  const removeButton = useRef<HTMLButtonElement>(null);
  const cancelRemove = () => { setRemoving(false); requestAnimationFrame(() => removeButton.current?.focus()); };
  const load = () => {
    const n = ++asked.current;
    Promise.all([v2.slack(), v2.slackDeliveries()])
      .then(([s, d]) => { if (n === asked.current) { setSlack(s); setAttempts(d.attempts); setLoadError(null); } })
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
    void act("The Slack URL was not saved", async () => {
      // A first save sends the events as shown, so what the switches say is what is saved.
      setSlack(await v2.saveSlack({ url: url.trim(), ...(slack && !slack.configured ? { events: slack.events } : {}) }));
      setUrl("");
    });
  };
  const toggle = (event: Event, on: boolean) => {
    if (!slack) return;
    // Not set yet: the switch changes what the first save sends. Set: it is saved at once.
    if (!slack.configured) return setSlack({ ...slack, events: { ...slack.events, [event]: on } });
    void act("The event was not changed", async () => setSlack(await v2.saveSlack({ events: { [event]: on } })));
  };

  if (!slack) return loadError
    ? <Banner tone="error" className="m-8" actions={<Button type="button" size="xs" onClick={load}>Try again</Button>}><p className="font-mono">Slack could not be read: {loadError.code}: {loadError.message}</p></Banner>
    : <p className="p-8 text-center font-mono text-body text-muted-foreground">Loading...</p>;
  return (
    <div className="h-full overflow-auto">
      <div className={settingsPageClass}>
        <div className={settingsIntroClass}>
          <p className="caps text-label text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">Slack</h1>
          <p className="mt-2 text-lead text-muted-foreground">Post a message to a Slack channel when a run ends, when a run needs you, and when a trigger fails. Each message names the agent, the status and the run's title, with a link to the run here; never a run's input, its output or a tool's arguments.</p>
        </div>
        <div className={settingsBodyClass}>
          {problem && <RunError error={problem.error} title={problem.title} />}
          {loadError && (
            <Banner tone="error" actions={<Button type="button" size="xs" onClick={load}>Try again</Button>}>
              <p className="font-mono">Slack could not be read: {loadError.code}: {loadError.message}. What is shown may be out of date.</p>
            </Banner>
          )}
          <SettingsSection title="Channel" note={<p>In Slack, add an incoming webhook to the channel (an app with Incoming Webhooks on), then paste its URL here. The URL is a secret: anyone with it can post to the channel, so it is sealed and never shown again.</p>}>
            <section className="border bg-card p-4" aria-label="Slack URL">
              <div className="flex items-center gap-2">
                <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
                {slack.configured
                  ? <span className="min-w-0 break-all font-mono text-body">{slack.url}</span>
                  : <span className="text-body text-muted-foreground">Slack is not set.</span>}
                {slack.configured && (slack.disabled ? <Chip tone="error">off</Chip> : slack.url_state === "sealed" ? <Chip tone="success">on</Chip> : <Chip tone="warning">unreadable</Chip>)}
              </div>
              {slack.configured && slack.disabled && <p className="mt-2 text-body text-destructive-text">Off: {slack.disabled.reason}, {when(slack.disabled.at)}. Nothing is posted until a URL is saved again: paste it below.</p>}
              {slack.configured && slack.url_state !== "sealed" && (
                <p className="mt-2 flex gap-2 text-body text-warning-text"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />The saved URL can't be opened here: it was sealed under another key, or is damaged. Nothing is posted until it is saved again.</p>
              )}
              {!writable && <p role="status" className="mt-3 text-body text-muted-foreground">{WHY_NOT_WORDS[whyNot]}</p>}
              <form className="mt-4 space-y-3" onSubmit={save}>
                <Field label="Incoming-webhook URL" hint={slack.configured ? "Paste the whole URL to change it, or to turn Slack on again." : undefined}>
                  <Input name="url" type="url" required maxLength={2048} autoComplete="off" spellCheck={false} placeholder="https://hooks.slack.com/services/..." value={url} disabled={!writable} onChange={(e) => setUrl(e.target.value)} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  {slack.configured && <Button type="button" variant="outline" disabled={busy} onClick={() => act("The test was not sent", async () => setTested(await v2.testSlack()))}>Send a test</Button>}
                  {slack.configured && !removing && writable && <Button ref={removeButton} type="button" variant="outline" disabled={busy} onClick={() => setRemoving(true)}>Remove</Button>}
                  <Button type="submit" variant="primary" disabled={busy || !writable || !url.trim()}>Save</Button>
                </div>
              </form>
              {removing && (
                <div role="alertdialog" aria-label="Remove Slack" className="mt-3 flex flex-wrap items-center gap-2 text-body" onKeyDown={(e) => { if (e.key === "Escape") cancelRemove(); }}>
                  <span>The URL is removed and pending messages are dropped; the log of attempts stays.</span>
                  <Button type="button" variant="ghost" autoFocus onClick={cancelRemove}>Cancel</Button>
                  <Button type="button" variant="destructive" disabled={busy} onClick={() => { setRemoving(false); setUrl(""); setTested(null); void act("Slack was not removed", async () => { await v2.removeSlack(); setSlack(UNSET); }); }}>Remove Slack</Button>
                </div>
              )}
              {tested && <p className="mt-3 font-mono text-body" aria-label="Test send">Test send: {outcome(tested)}</p>}
            </section>
          </SettingsSection>
          <SettingsSection title="Events" note={<p>Each is posted while it is on. A change takes effect at once.</p>}>
            <ul className="border" aria-label="Events">
              {EVENTS.map((event) => (
                <li key={event.id} className="flex items-start gap-3 border-b px-4 py-3 last:border-b-0">
                  <Switch checked={slack.events[event.id]} onChange={(on) => toggle(event.id, on)} disabled={busy} label={event.label} className="mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-body">{event.label} <span className="font-mono text-small text-muted-foreground">{event.id}</span></p>
                    <p className="text-small text-muted-foreground">{event.note}</p>
                  </div>
                </li>
              ))}
            </ul>
          </SettingsSection>
          <SettingsSection label="Deliveries" title="Last deliveries" aside={<Button type="button" size="sm" onClick={load}>Refresh</Button>}>
            {attempts.length === 0
              ? <p className="border p-4 text-body text-muted-foreground">No message has been posted yet.</p>
              : (
                <ul className="border">
                  {attempts.map((a, i) => (
                    <li key={`${a.webhook_id}:${a.at}:${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-3 text-body last:border-b-0">
                      <span className="shrink-0 text-muted-foreground">{when(a.at)}</span>
                      <span className="shrink-0 font-mono">{a.type}</span>
                      <span className={a.error ? "min-w-0 flex-1 font-mono text-destructive-text" : "min-w-0 flex-1 font-mono"}>{outcome(a)}</span>
                      {a.redelivery && <Chip>redelivery</Chip>}
                      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => act("The message was not posted again", () => v2.redeliverSlack(a.webhook_id))}>Post again</Button>
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

/** An attempt as one line: Slack's answer and how long it took, or why it failed, and when it is tried again. */
function outcome(a: SlackAttempt): string {
  const answer = a.error ?? `${a.status_code}`;
  const took = a.status_code !== null ? `, ${a.latency_ms} ms` : "";
  return `${answer}${took}${a.retry_at ? `; tried again ${when(a.retry_at)}` : ""}`;
}
