import { Plug, TriangleAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { SecretRow } from "@/components/SecretRow";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import type { Client } from "@/lib/client";
import { when } from "@/lib/format";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import { type McpAuth, type McpPreview, mcpProblem, type McpRefresh, type McpServer, NO_SEAL_KEY, signInFailure } from "@/lib/mcp";

type Problem = ReturnType<typeof mcpProblem>;
type SignIn = { server: string; ok: boolean; error?: string };
const MAX_HEADERS = 8;

/** A saved server's credential, as its row says it. */
const CREDENTIAL: Record<string, [string, "success" | "warning" | "plain"]> = {
  sealed: ["sealed", "success"], expired: ["sign-in expired", "warning"], unreadable: ["can't be opened: enter it again", "warning"], seal_key_missing: ["no seal key now", "warning"],
};

/** Settings → MCP servers: the remote MCP servers this server keeps, each with its tools and its credential's state, and
 *  a form to add one: its address and credential, a preview of the tools it lists, then Save. A credential goes to the
 *  server and nowhere else: its inputs are uncontrolled (React would mirror a value into the DOM), never filled from a
 *  read, and cleared once sent to be kept. `atRest` is capabilities' `features.mcp_client.at_rest`; `signIn`, the
 *  outcome an OAuth sign-in's way back names (`#/settings/mcp?server=&sign_in=`); `open` takes the browser to a sign-in. */
/** `writable`: this is the owner's password session (session.secrets_writable), the one that may type a credential. */
export function McpServersPage({ v2, atRest, signIn, writable, whyNot = "sign_in", open = (url) => location.assign(url) }: { v2: Client; atRest?: "sealed" | "unavailable"; signIn?: SignIn; writable: boolean; whyNot?: SecretsWhyNot; open?: (url: string) => void }) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [loadError, setLoadError] = useState<Problem | null>(null);
  const [form, setForm] = useState<{ saved?: McpServer } | null>(null);
  const asked = useRef(0);
  const load = () => {
    const n = ++asked.current;
    v2.listMcpServers().then((r) => { if (n === asked.current) { setServers(r.servers); setUnreadable(!!r.file_unreadable); setLoadError(null); } }, (e) => { if (n === asked.current) setLoadError(mcpProblem(e)); });
  };
  useEffect(load, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  // The outcome is said once: a reload of the page does not say it again.
  useEffect(() => { if (signIn && location.hash.includes("sign_in=")) history.replaceState(null, "", "#/settings/mcp"); }, [signIn]);
  const cantStore = atRest === "unavailable";
  const startSignIn = async (name: string, body: Parameters<Client["startMcpSignIn"]>[1]) => open((await v2.startMcpSignIn(name, body)).authorization_url);
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="caps text-[11px] text-muted-foreground">Settings</p>
            <h1 className="mt-1 text-2xl font-semibold">MCP servers</h1>
            <p className="mt-2 text-[14px] text-muted-foreground">A remote MCP server's tools, for any agent you grant them to in its Tools step. A saved credential is never shown again.</p>
          </div>
          {!form && <Button size="sm" variant="primary" onClick={() => setForm({})}>Add server</Button>}
        </div>
        {signIn && (
          <p className={`border p-4 text-[13px] ${signIn.ok ? "border-success/50 text-success-text" : "border-warning/50 text-warning-text"}`} role="status">
            {signIn.ok ? `Signed in to ${signIn.server}. Its tools are saved.` : `Signing in to ${signIn.server} failed: ${signInFailure(signIn.error)}.`}
          </p>
        )}
        {cantStore && <p className="border bg-card p-4 font-mono text-[13px]" role="status">{NO_SEAL_KEY}</p>}
        {!writable && <p className="border bg-card p-4 text-[13px]" role="status">{WHY_NOT_WORDS[whyNot]}</p>}
        {unreadable && <Warning>The file this server keeps its MCP servers in can't be read: restore it or remove it. Nothing is written over it.</Warning>}
        {loadError && (
          <div className="border p-4" role="alert">
            <p className="font-mono text-[13px] text-destructive-text">The MCP servers could not be read. {loadError.text}</p>
            <button type="button" onClick={load} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>
          </div>
        )}
        {/* A save that lands after its form was closed (Cancel, or another Change) closes no form opened since. */}
        {form && <ServerForm key={form.saved?.name ?? "new"} v2={v2} saved={form.saved} cantStore={cantStore} writable={writable} signIn={startSignIn} onCancel={() => setForm(null)} onSaved={((mine) => () => { setForm((open) => (open === mine ? null : open)); load(); })(form)} />}
        {servers && (servers.length
          ? <ul className="border">{servers.map((s) => <ServerRow key={s.name} v2={v2} server={s} writable={writable && !form} signIn={startSignIn} onChange={() => setForm({ saved: s })} onChanged={load} />)}</ul>
          : <p className="border px-3 py-4 font-mono text-[13px] text-muted-foreground">No MCP server is saved here yet.</p>)}
        <PrivateHosts v2={v2} />
      </div>
    </div>
  );
}

const Warning = ({ children }: { children: ReactNode }) => (
  <p className="flex gap-3 border border-warning/50 bg-warning/5 p-4 text-[13px]" role="alert"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />{children}</p>
);
const Said = ({ problem }: { problem: Problem }) => (
  <div role="alert"><p className="font-mono text-[13px] text-destructive-text">{problem.text}</p>{problem.detail && <p className="mt-1 text-[12px] text-muted-foreground">{problem.detail}</p>}</div>
);

function ServerRow({ v2, server: s, writable, signIn, onChange, onChanged }: { v2: Client; server: McpServer; writable: boolean; signIn: (name: string, body: { url: string }) => Promise<void>; onChange: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<McpRefresh | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const run = async (work: () => Promise<void>) => { setBusy(true); setProblem(null); try { await work(); } catch (e) { setProblem(mcpProblem(e)); } setBusy(false); };
  const [said, tone] = s.credential ? CREDENTIAL[s.credential] ?? [s.credential, "plain"] : ["no credential", "plain" as const];
  const oauth = s.auth.type === "oauth";
  const changes = note && [["Added", note.added], ["Removed", note.removed], ["Changed", note.changed]].filter(([, names]) => names.length).map(([what, names]) => `${what} ${(names as string[]).join(", ")}`);
  return (
    <li data-server={s.name} className="border-b p-4 last:border-b-0">
      <div className="flex flex-wrap items-start gap-3">
        <Plug className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2"><span className="font-mono text-[15px] font-semibold">{s.name}</span><Chip tone={tone}>{said}</Chip>{!!s.not_metered?.length && <Chip tone="plain">not metered</Chip>}</p>
          <p className="mt-1.5 break-all font-mono text-[12px] text-muted-foreground">{s.url}</p>
          {oauth && s.oauth && <p className="mt-1 font-mono text-[12px] text-muted-foreground">Signed in with OAuth{s.oauth.scopes.length ? ` · ${s.oauth.scopes.join(" ")}` : ""}{s.oauth.client === "pre-registered" && s.oauth.client_id ? ` · client ${s.oauth.client_id}` : ""}{s.credential === "expired" ? " · sign-in expired: sign in again" : s.oauth.expires_at ? ` · token until ${when(s.oauth.expires_at)}` : ""}</p>}
          <details className="mt-2">
            <summary className="cursor-pointer font-mono text-[12px]">{s.tools.length} tool{s.tools.length === 1 ? "" : "s"}</summary>
            <ul className="mt-1 space-y-0.5">{s.tools.map((t) => <li key={t.name} className="font-mono text-[12px]">{t.name}{s.prices?.[t.name] !== undefined && <span className="text-muted-foreground"> · ${s.prices[t.name]} a call</span>}{s.not_metered?.includes(t.name) && <span className="text-muted-foreground"> · not metered</span>}</li>)}</ul>
          </details>
          {/* Its one secret ("mcp:<server>": its bearer token, its headers' values, or its sign-in), as every secret's row.
              Replace opens the server's form; a sign-in's has none: its Sign in is the write. */}
          {s.secret && <ul className="mt-2"><SecretRow field={s.secret} label={AUTH_LABEL[s.auth.type]} writable={writable} onPaste={oauth ? undefined : onChange} /></ul>}
          {changes && <p className="mt-2 font-mono text-[12px]" role="status">{changes.length ? changes.join(" · ") : "No change: it lists the same tools."}</p>}
        </div>
        {!confirm && (
          <div className="flex flex-wrap gap-2">
            {oauth && s.credential !== "sealed" && writable && <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => signIn(s.name, { url: s.url, ...(s.oauth?.scopes.length ? { scopes: s.oauth.scopes } : {}) }))}>Sign in again</Button>}
            {/* The list is read again however the refresh went: a refusal (a sign-in expired or revoked) changes the credential's state too. */}
            <Button size="sm" disabled={busy} onClick={() => void run(async () => { try { setNote(await v2.refreshMcpServer(s.name)); } finally { onChanged(); } })}>Refresh</Button>
            <Button size="sm" disabled={busy} onClick={onChange}>Change</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirm(true)}>Delete</Button>
          </div>
        )}
      </div>
      {confirm && (
        <div role="alertdialog" aria-label={`Delete ${s.name}`} className="mt-4 flex flex-wrap items-center gap-3 border bg-card p-3">
          <p className="min-w-0 flex-1 text-[13px]">Delete {s.name}? Its credential goes with it, and an agent that grants its tools can't call them.</p>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(async () => { await v2.deleteMcpServer(s.name); onChanged(); })}>Delete</Button>
          <Button size="sm" onClick={() => setConfirm(false)}>Keep</Button>
        </div>
      )}
      {problem && <div className="mt-3"><Said problem={problem} /></div>}
    </li>
  );
}

/** Settings → MCP servers → Private network hosts: the hosts an MCP server's sign-in may reach on a private network,
 *  none by default. Each add or remove sends the whole list, and the list shown is the one the server answers it kept.
 *  Only the owner's password session changes it: the server refuses a token, and the console says its words. */
function PrivateHosts({ v2 }: { v2: Client }) {
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<Problem | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const load = () => void v2.mcpPrivateHosts().then((r) => { setHosts(r.hosts); setLoadError(null); }, (e) => setLoadError(mcpProblem(e)));
  useEffect(load, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (next: string[]): Promise<boolean> => {
    setBusy(true); setProblem(null);
    try { setHosts((await v2.saveMcpPrivateHosts(next)).hosts); return true; } catch (e) { setProblem(mcpProblem(e)); return false; } finally { setBusy(false); }
  };
  const allow = async (e: FormEvent) => {
    e.preventDefault();
    if (hosts && draft.trim() && (await save([...hosts, draft.trim()]))) setDraft("");
  };
  return (
    <section aria-labelledby="mcp-private-hosts" className="space-y-3 border bg-card p-4">
      <h2 id="mcp-private-hosts" className="caps text-[12px] font-semibold">Private network hosts</h2>
      <p className="text-[13px] text-muted-foreground">Off by default. A host listed here may run an MCP server's sign-in on your private network (10.x, 172.16–31.x, 192.168.x, 100.64–127.x, fc00::/7), over https only; never this machine, loopback or a link-local address such as cloud metadata.</p>
      {loadError && (
        <div role="alert">
          <p className="font-mono text-[13px] text-destructive-text">The private network hosts could not be read. {loadError.text}</p>
          <button type="button" onClick={load} className="caps mt-3 border px-3 py-2 text-[12px] hover:bg-accent">Try again</button>
        </div>
      )}
      {hosts && (hosts.length
        ? <ul aria-label="Allowed private network hosts" className="border bg-background">{hosts.map((host) => (
            <li key={host} data-host={host} className="flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0">
              <span className="break-all font-mono text-[13px]">{host}</span>
              <Button size="sm" disabled={busy} onClick={() => void save(hosts.filter((h) => h !== host))}>Remove</Button>
            </li>
          ))}</ul>
        : <p className="border bg-background px-3 py-3 font-mono text-[13px] text-muted-foreground">No host is allowed: a sign-in on a private network is refused.</p>)}
      {hosts && (
        <form onSubmit={(e) => void allow(e)} aria-label="Allow a private network host" className="flex gap-2">
          <input name="mcp-private-host" aria-label="Host name or IP address" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="auth.corp.example" spellCheck={false} autoCapitalize="off" autoCorrect="off" className={input} />
          <Button type="submit" size="sm" variant="solid" disabled={busy || !draft.trim()}>Allow</Button>
        </form>
      )}
      {problem && <Said problem={problem} />}
    </section>
  );
}

const input = "w-full border bg-background px-3 py-2.5 font-mono text-[13px] outline-none focus:border-border-strong";
const secret = { type: "password", autoComplete: "new-password", spellCheck: false, autoCapitalize: "off", autoCorrect: "off", "data-1p-ignore": true, "data-lpignore": "true", className: input } as const;
const AUTH: [McpAuth["type"], string][] = [["none", "None"], ["bearer", "Bearer token"], ["headers", "Headers"], ["oauth", "Sign in with OAuth"]];
/** A server's one secret ("mcp:<server>"), as its row says it: by the kind of credential it is. */
const AUTH_LABEL: Record<McpAuth["type"], string> = { none: "Credential", bearer: "Bearer token", headers: "Headers", oauth: "OAuth sign-in" };

/** Add a server, or change a saved one (`saved`: its name stays, and a credential left empty is the sealed one kept).
 *  A new server is previewed before it can be saved; any change of its address or credential asks for another. */
function ServerForm({ v2, saved, cantStore, writable, signIn, onCancel, onSaved }: { v2: Client; saved?: McpServer; cantStore: boolean; writable: boolean; signIn: (name: string, body: Parameters<Client["startMcpSignIn"]>[1]) => Promise<void>; onCancel: () => void; onSaved: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [name, setName] = useState(saved?.name ?? "");
  const [url, setUrl] = useState(saved?.url ?? "");
  const [type, setType] = useState<McpAuth["type"]>(saved?.auth.type ?? "none");
  const [headerRows, setHeaderRows] = useState(Math.max(1, saved?.auth.headers?.length ?? 0));
  const [preview, setPreview] = useState<McpPreview | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  // Each change of the address or the credential: a preview's answer counts only for the inputs it was asked for.
  const edits = useRef(0);
  const edited = () => { edits.current++; setPreview(null); };
  const value = (field: string) => ((form.current?.elements.namedItem(field) as HTMLInputElement | null)?.value ?? "").trim();
  // A saved OAuth server keeps its sign-in only while nothing it signed in with changes: other scopes, a client, or
  // another origin need a new sign-in, which Save can't make, so the form offers that instead.
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const originOf = (u: string) => { try { return new URL(u).origin; } catch { return u; } };
  const checkSignIn = (t = type) => setNeedsSignIn(!!saved && t === "oauth" && (saved.auth.type !== "oauth" || value("mcp-scopes") !== (saved.oauth?.scopes.join(" ") ?? "")
    || !!value("mcp-client-id") || !!value("mcp-client-secret") || originOf(value("mcp-url")) !== originOf(saved.url)));
  useEffect(() => checkSignIn(), [type]); // eslint-disable-line react-hooks/exhaustive-deps
  // The credential typed: none typed is none sent, which a save takes as "keep the sealed one".
  const auth = (): McpAuth => {
    if (type === "bearer") return value("mcp-token") ? { type, token: value("mcp-token") } : { type };
    if (type !== "headers") return { type };
    const headers = Object.fromEntries(Array.from({ length: headerRows }, (_, i) => [value(`mcp-header-name-${i}`), value(`mcp-header-value-${i}`)]).filter(([k, v]) => k && v));
    return Object.keys(headers).length ? { type, headers } : { type };
  };
  const act = async (work: () => Promise<void>) => { setBusy(true); setProblem(null); try { await work(); } catch (e) { setProblem(mcpProblem(e)); } setBusy(false); };
  const startSignIn = () => act(() => {
    const scopes = value("mcp-scopes").split(/\s+/).filter(Boolean);
    const client = value("mcp-client-id");
    return signIn(name.trim(), { url: url.trim(), ...(scopes.length ? { scopes } : {}), ...(client ? { client_id: client, ...(value("mcp-client-secret") ? { client_secret: value("mcp-client-secret") } : {}) } : {}) });
  });
  const runPreview = () => {
    const asked = edits.current;
    void act(async () => {
      try {
        const answer = await v2.previewMcpServer(url.trim(), auth());
        if (asked === edits.current) setPreview(answer);
      } catch (e) { if (asked === edits.current) throw e; }
    });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (type === "oauth" && (!saved || needsSignIn)) return void startSignIn();
    // No prices are sent: this form sets none, and the server keeps the saved ones for the tools still listed at the same
    // address when a PUT has none.
    void act(async () => { await v2.saveMcpServer(name.trim(), url.trim(), auth()); form.current?.reset(); onSaved(); });
  };
  const canSave = !busy && !!name.trim() && !!url.trim() && (!!saved || !!preview);
  const keepNote = (what: string) => saved?.credential === "sealed" && saved.auth.type === type && <span className="-mt-1 mb-2 block text-[12px] text-muted-foreground">Saved. {what}</span>;
  return (
    <form ref={form} autoComplete="off" onSubmit={submit} aria-label={saved ? `Change ${saved.name}` : "Add an MCP server"} className="space-y-4 border bg-card p-4"
      onInput={(e) => { if ((e.target as HTMLInputElement).name !== "mcp-name") edited(); checkSignIn(); }}>
      <label className="block"><span className="caps mb-2 block text-[12px] font-semibold">Name</span>
        <span className="-mt-1 mb-2 block text-[12px] text-muted-foreground">Lowercase letters, digits and dashes: an agent grants its tools as mcp:{name.trim() || "<name>"}/&lt;tool&gt;.</span>
        <input name="mcp-name" value={name} readOnly={!!saved} onChange={(e) => setName(e.target.value)} spellCheck={false} className={input} /></label>
      <label className="block"><span className="caps mb-2 block text-[12px] font-semibold">Address</span>
        <input name="mcp-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} className={input} /></label>
      <fieldset>
        <legend className="caps mb-2 text-[12px] font-semibold">Credential</legend>
        <div className="flex flex-wrap gap-4">
          {AUTH.map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-[13px]">
              <input type="radio" name="mcp-auth" value={id} checked={type === id} disabled={(cantStore && id !== "none") || (!writable && id !== "none")} onChange={() => { setType(id); edited(); }} className="accent-[hsl(var(--primary))]" />{label}
            </label>
          ))}
        </div>
      </fieldset>
      {type === "bearer" && <label className="block"><span className="caps mb-2 block text-[12px] font-semibold">Token</span>{keepNote("A new token replaces it; leave this empty to keep it.")}<input name="mcp-token" {...secret} /></label>}
      {type === "headers" && (
        <div className="space-y-2">
          {keepNote(`Its headers: ${saved?.auth.headers?.join(", ")}. New ones replace them all; leave the values empty to keep them.`)}
          {Array.from({ length: headerRows }, (_, i) => (
            <div key={i} className="flex gap-2">
              <input name={`mcp-header-name-${i}`} aria-label={`Header ${i + 1} name`} placeholder="X-Api-Key" defaultValue={saved?.auth.headers?.[i]} spellCheck={false} className={input} />
              <input name={`mcp-header-value-${i}`} aria-label={`Header ${i + 1} value`} {...secret} />
            </div>
          ))}
          {headerRows < MAX_HEADERS && <Button type="button" size="sm" variant="ghost" onClick={() => setHeaderRows((n) => n + 1)}>Add header</Button>}
        </div>
      )}
      {type === "oauth" && (
        <div className="space-y-3">
          <p className="text-[12px] text-muted-foreground">This server signs in for you and keeps the tokens; an agent never sees one. Sign in opens the server's own page to approve it, and its tools are saved once you do.</p>
          {saved?.oauth?.client_id && <p className="text-[12px] text-muted-foreground">Signing in again uses the client it signed in with ({saved.oauth.client_id}); a client ID here replaces it.</p>}
          <label className="block"><span className="caps mb-2 block text-[12px] font-semibold">Scopes (optional)</span><input name="mcp-scopes" placeholder="read write" defaultValue={saved?.oauth?.scopes.join(" ")} spellCheck={false} className={input} /></label>
          <div className="flex gap-2">
            <label className="block flex-1"><span className="caps mb-2 block text-[12px] font-semibold">Client ID (optional)</span><input name="mcp-client-id" spellCheck={false} className={input} /></label>
            {writable && <label className="block flex-1"><span className="caps mb-2 block text-[12px] font-semibold">Client secret (optional)</span><input name="mcp-client-secret" {...secret} /></label>}
          </div>
        </div>
      )}
      {problem && (
        <div className="space-y-2">
          <Said problem={problem} />
          {/* With OAuth chosen the form's own Sign in is there: one button, not two. */}
          {problem.signIn && type !== "oauth" && writable && <Button type="button" size="sm" variant="primary" disabled={busy || !name.trim()} onClick={() => void startSignIn()}>Sign in</Button>}
        </div>
      )}
      {preview && (
        <section aria-label="Preview" className="border bg-background p-3">
          <p className="font-mono text-[12px] text-muted-foreground">MCP {preview.protocol}{preview.server_info?.name ? ` · ${preview.server_info.name}${preview.server_info.version ? ` ${preview.server_info.version}` : ""}` : ""} · {preview.tools.length} tool{preview.tools.length === 1 ? "" : "s"}</p>
          {preview.instructions && <p className="mt-2 whitespace-pre-wrap text-[12px]">{preview.instructions}</p>}
          <ul aria-label="Tools it lists" className="mt-2 divide-y border">
            {preview.tools.map((t) => (
              <li key={t.name} className="px-3 py-2"><span className="font-mono text-[13px]">{t.name}</span>{t.title && <span className="ml-2 text-[12px]">{t.title}</span>}
                {t.description && <span className="mt-0.5 block text-[12px] text-muted-foreground">{t.description}</span>}</li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        {type === "oauth" && !writable ? null
          : type === "oauth" && needsSignIn
          ? <Button type="submit" size="sm" variant="solid" disabled={busy || !url.trim() || cantStore}>Sign in again with these settings</Button>
          : type === "oauth"
          ? <Button type="button" size="sm" variant="solid" disabled={busy || !name.trim() || !url.trim() || cantStore} onClick={() => void startSignIn()}>{saved ? "Sign in again" : "Sign in"}</Button>
          : <Button type="button" size="sm" disabled={busy || !url.trim()} onClick={runPreview}>Preview</Button>}
        {(type !== "oauth" || (saved && !needsSignIn)) && <Button type="submit" size="sm" variant="solid" disabled={!canSave}>{busy ? "Working" : "Save"}</Button>}
        <Button type="button" size="sm" onClick={() => { form.current?.reset(); onCancel(); }}>Cancel</Button>
      </div>
    </form>
  );
}
