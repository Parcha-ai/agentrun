import { Mail, TriangleAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { RunError } from "@/components/RunError";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Field, Input } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { type Client, ClientError } from "@/lib/client";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import type { ApiError, EmailAccount, EmailAccountBody, EmailTest } from "@/lib/v2";

type Preset = "gmail" | "fastmail" | "icloud" | "other";
/** The presets a person picks from, in the server's order (email/account.ts PRESETS). */
const PRESETS: { value: Preset; label: string }[] = [{ value: "gmail", label: "Gmail" }, { value: "fastmail", label: "Fastmail" }, { value: "icloud", label: "iCloud" }, { value: "other", label: "Other" }];
/** Where each preset's person gets the password the server signs in with. */
const HOW: Record<Preset, ReactNode> = {
  gmail: <>A Google <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-primary-text underline">app password</a>. Google gives one only with 2-Step Verification on, and a company account whose admin turned app passwords off won't connect yet.</>,
  fastmail: <>A Fastmail app password with IMAP and SMTP access, made under Privacy &amp; Security in Fastmail.</>,
  icloud: <>An app-specific password, made under Sign-In and Security in your Apple Account.</>,
  other: <>Your mail server's IMAP and SMTP servers, and its password: an app password where it offers one.</>,
};
/** The server's own words for Outlook (email/account.ts OUTLOOK_REFUSAL). */
const OUTLOOK = "Outlook needs Microsoft sign-in, which this server doesn't do yet.";
const NO_ACCOUNT: EmailAccount = { configured: false, preset: null, address: null, user: null, imap: null, smtp: null, password_unreadable: false };

type Form = { preset: Preset; address: string; user: string; imapHost: string; imapPort: string; smtpHost: string; smtpPort: string };
const formOf = (a: EmailAccount | null): Form => ({
  preset: a?.preset ?? "gmail", address: a?.address ?? "", user: a?.user && a.user !== a.address ? a.user : "",
  imapHost: a?.preset === "other" ? a.imap?.host ?? "" : "", imapPort: a?.preset === "other" ? String(a.imap?.port ?? "") : "993",
  smtpHost: a?.preset === "other" ? a.smtp?.host ?? "" : "", smtpPort: a?.preset === "other" ? String(a.smtp?.port ?? "") : "465",
});
const apiError = (e: unknown): ApiError => (e instanceof ClientError ? e.toApiError() : { code: "network", message: e instanceof Error ? e.message : String(e), retryable: false });
/** A refusal's field issues by field (`address`, `imap.host`, ...), when it names any. */
const fieldsOf = (e: unknown): Record<string, string> => Object.fromEntries((e instanceof ClientError ? e.fields ?? [] : []).map((f) => [f.field, f.message]));

/** Settings → Email (GET, PUT and DELETE /v2/settings/email, POST .../test): the server's one mail account, which the
 *  agents' email tools and email triggers sign in as. A preset fills the servers (gmail, fastmail, icloud), or Other takes
 *  the person's own. The password is sealed on the server: no answer holds it, the field is empty once it is saved, and
 *  a save needs it typed again. Test signs in to IMAP and SMTP and sends nothing: the saved account, or what is typed
 *  (the saved password stands in for an empty field). Every route is a secret write, so a session that may not change
 *  secrets is told why and the page asks nothing. */
export function EmailPage({ v2, writable, whyNot = "sign_in" }: { v2: Client; writable: boolean; whyNot?: SecretsWhyNot }) {
  const [account, setAccount] = useState<EmailAccount | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [form, setForm] = useState<Form>(formOf(null));
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<{ title: string; error: ApiError } | null>(null);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [tested, setTested] = useState<EmailTest | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const asked = useRef(0);
  const shown = (a: EmailAccount) => { setAccount(a); setForm(formOf(a)); };
  const load = () => {
    const n = ++asked.current;
    v2.emailAccount().then((a) => { if (n === asked.current) { shown(a); setLoadError(null); } }).catch((e) => { if (n === asked.current) setLoadError(apiError(e)); });
  };
  useEffect(() => { if (writable) load(); }, [v2, writable]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (field: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [field]: e.target.value }));
  /** The account as typed, the password only when one is typed. */
  const body = (): Partial<EmailAccountBody> => ({
    preset: form.preset, address: form.address.trim(), ...(password ? { password } : {}),
    ...(form.preset === "other" ? { ...(form.user.trim() ? { user: form.user.trim() } : {}), imap: { host: form.imapHost.trim(), port: Number(form.imapPort) }, smtp: { host: form.smtpHost.trim(), port: Number(form.smtpPort) } } : {}),
  });
  const act = async (title: string, work: () => Promise<void>) => {
    setProblem(null); setRefused({}); setBusy(true);
    try { await work(); } catch (e) { const fields = fieldsOf(e); if (Object.keys(fields).length) setRefused(fields); else setProblem({ title, error: apiError(e) }); } finally { setBusy(false); }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act("The account was not saved", async () => {
      shown(await v2.saveEmailAccount(body() as EmailAccountBody));
      // Sealed on the server now: the page keeps no copy.
      setPassword(""); setTested(null);
    });
  };
  const test = () => act("The account was not tested", async () => { setTested(null); setTested(await v2.testEmailAccount(body())); });
  const remove = () => act("The account was not removed", async () => {
    setRemoving(false); await v2.removeEmailAccount(); shown(NO_ACCOUNT); setPassword(""); setTested(null);
  });

  const header = (
    <div>
      <p className="caps text-label text-muted-foreground">Settings</p>
      <h1 className="mt-1 text-2xl font-semibold">Email</h1>
      <p className="mt-2 text-lead text-muted-foreground">The mail account your agents read, file and draft in, over IMAP and SMTP, and the account email triggers watch. Its password is sealed on this server and never shown again. Nothing is sent without asking you first.</p>
    </div>
  );
  if (!writable) return <div className="h-full overflow-auto"><div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">{header}<p role="status" className="border bg-card p-4 text-body">{WHY_NOT_WORDS[whyNot]}</p></div></div>;
  if (!account) return loadError
    ? <Banner tone="error" className="m-8" actions={<Button type="button" size="xs" onClick={load}>Try again</Button>}><p className="font-mono">The email account could not be read: {loadError.code}: {loadError.message}</p></Banner>
    : <p className="p-8 text-center font-mono text-body text-muted-foreground">Loading...</p>;
  const saved = account.configured || account.password_unreadable;
  const other = form.preset === "other";
  const hostField = (which: "imap" | "smtp", label: string, placeholder: string) => (
    <div className="grid grid-cols-[1fr_7rem] gap-2">
      <Field label={`${label} server`} error={refused[`${which}.host`]}><Input name={`${which}_host`} value={which === "imap" ? form.imapHost : form.smtpHost} onChange={set(which === "imap" ? "imapHost" : "smtpHost")} placeholder={placeholder} spellCheck={false} autoCapitalize="off" /></Field>
      <Field label="Port" error={refused[`${which}.port`]}><Input name={`${which}_port`} inputMode="numeric" value={which === "imap" ? form.imapPort : form.smtpPort} onChange={set(which === "imap" ? "imapPort" : "smtpPort")} /></Field>
    </div>
  );
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        {header}
        {problem && <RunError error={problem.error} title={problem.title} />}
        {loadError && (
          <Banner tone="error" actions={<Button type="button" size="xs" onClick={load}>Try again</Button>}>
            <p className="font-mono">The email account could not be read: {loadError.code}: {loadError.message}. What is shown may be out of date.</p>
          </Banner>
        )}
        <section className="border bg-card p-4" aria-label="Email account">
          <div className="flex flex-wrap items-center gap-2">
            <Mail className="size-4 text-muted-foreground" aria-hidden />
            {saved
              ? <span className="min-w-0 break-all font-mono text-body">{account.address}</span>
              : <span className="text-body text-muted-foreground">No email account is saved. The agents' email tools and email triggers need one.</span>}
            {account.configured && <Chip tone="success">saved</Chip>}
            {saved && account.preset && <Chip>{PRESETS.find((p) => p.value === account.preset)?.label ?? account.preset}</Chip>}
          </div>
          {saved && account.imap && account.smtp && (
            <p className="mt-2 font-mono text-small text-muted-foreground">IMAP {account.imap.host}:{account.imap.port} · SMTP {account.smtp.host}:{account.smtp.port}{account.user && account.user !== account.address ? ` · signs in as ${account.user}` : ""}</p>
          )}
          {account.configured && <p className="mt-2 text-small text-muted-foreground">Its password is sealed on this server. It is never shown again; type it again only to change the account.</p>}
          {account.password_unreadable && (
            <p className="mt-2 flex gap-2 text-body text-warning-text"><TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />Its password can't be opened here: it was sealed under another key, or is damaged. The agents can't read or send mail until it is saved again.</p>
          )}
        </section>
        <form className="space-y-4 border bg-card p-4" aria-label="Account" onSubmit={save}>
          <Field label="Provider" group="heading" note={OUTLOOK} error={refused.preset}>
            <Segmented name="email-preset" label="Provider" value={form.preset} onChange={(preset) => setForm((f) => ({ ...f, preset }))} options={PRESETS} />
          </Field>
          <p className="text-small text-muted-foreground">{HOW[form.preset]}</p>
          <Field label="Address" error={refused.address}>
            <Input name="address" inputMode="email" autoComplete="username" spellCheck={false} autoCapitalize="off" placeholder="you@example.com" value={form.address} onChange={set("address")} />
          </Field>
          {other && <Field label="Sign-in name" optional note="When the server's sign-in isn't the address." error={refused.user}><Input name="user" spellCheck={false} autoCapitalize="off" value={form.user} onChange={set("user")} /></Field>}
          <Field label={form.preset === "other" ? "Password" : "App password"} error={refused.password}>
            <Input name="password" type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="off" autoCorrect="off" data-1p-ignore data-lpignore="true"
              placeholder={account.configured ? "Sealed on this server: type it again to save a change" : ""} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {other && hostField("imap", "IMAP", "imap.example.com")}
          {other && hostField("smtp", "SMTP", "smtp.example.com")}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="solid" disabled={busy || !form.address.trim() || !password}>Save</Button>
            <Button type="button" variant="outline" disabled={busy || !form.address.trim() || (!password && !account.configured)} onClick={() => void test()}>Test</Button>
            {saved && !removing && <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoving(true)}>Remove</Button>}
          </div>
          {removing && (
            <div className="flex flex-wrap items-center gap-2 text-body">
              <span>The agents' email tools and email triggers stop until an account is saved again.</span>
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>Remove the account</Button>
              <Button type="button" variant="ghost" onClick={() => setRemoving(false)}>Cancel</Button>
            </div>
          )}
          {tested && (
            <div aria-label="Test" className="space-y-1 font-mono text-body">
              {(["imap", "smtp"] as const).map((side) => (
                <p key={side} className="flex flex-wrap items-center gap-2">
                  <Chip tone={tested[side].ok ? "success" : "error"}>{side === "imap" ? "IMAP" : "SMTP"}</Chip>
                  <span className={tested[side].ok ? "" : "text-destructive-text"}>{tested[side].message}</span>
                </p>
              ))}
              <p className="text-small text-muted-foreground">{tested.ok ? "Both signed in. Nothing was sent, and nothing was saved by the test." : "Nothing was sent, and nothing was saved by the test."}</p>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
