import { SettingsSection, settingsBodyClass, settingsIntroClass, settingsPageClass } from "@/components/Settings";
import { pasteFromClipboard } from "@/lib/paste";
import { Plug } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { ListFilter } from "@/components/ListFilter";
import { matchesFilter } from "@/lib/filter";
import { SecretRow } from "@/components/SecretRow";
import { ToolTable } from "@/components/ToolSettings";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Banner } from "@/components/ui/banner";
import { Input } from "@/components/ui/field";
import { SearchPicker, type SearchPickerOption } from "@/components/ui/search-picker";
import { Switch } from "@/components/ui/switch";
import { type Client, ClientError } from "@/lib/client";
import { when } from "@/lib/format";
import { type SecretsWhyNot, WHY_NOT_WORDS } from "@/lib/secrets";
import { ownSettings, type ToolChoice } from "@/lib/toolSettings";
import type { ComposioTriggers, Permission, ToolSettings } from "@/lib/v2";
import { type ComposioAccount, type ComposioAccountState, type ComposioToolkit, type ComposioTools, GITHUB_MCP_URL, MCP_URL_PRESETS, type McpAdd, type McpAuth, type McpPreset, type McpPreview, mcpProblem, type McpRefresh, type McpServer, type McpSource, PREVIEW_SCOPE_NOTE, signInFailure, SOURCE_LABEL, urlPresetOf } from "@/lib/mcp";

type Problem = ReturnType<typeof mcpProblem>;
type SignIn = { server: string; ok: boolean; error?: string };
const MAX_HEADERS = 8;

/** A Composio server's account, as its row says it: the chip's words and tone, and what to do. */
const ACCOUNT: Record<ComposioAccountState, [string, "success" | "warning" | "plain", string]> = {
  connected: ["connected", "success", ""],
  pending: ["not connected", "warning", "Its connect link isn't finished: connect it on Composio, then Refresh."],
  expired: ["connection expired", "warning", "Connect it again on Composio, then Refresh."],
  none: ["no account connected", "warning", "Connect one on Composio, then Refresh."],
  unknown: ["account unknown", "plain", "Composio didn't answer at the last Refresh."],
};

/** A saved Composio server's account, as its last Refresh read it: connected as which account (each one's label, never
 *  its id), or not and what to do. */
function AccountLine({ account }: { account: ComposioAccount }) {
  const [words, tone, next] = ACCOUNT[account.state] ?? ACCOUNT.unknown;
  const detail = account.state === "connected" ? (account.labels?.length ? `as ${account.labels.join(", ")}` : "Composio gives the account no name") : next;
  return (
    <p data-composio-account={account.state} className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-small">
      <Chip tone={tone}>{words}</Chip>
      <span className="break-all font-mono text-muted-foreground">{detail}</span>
      <span className="font-mono text-muted-foreground">· checked {when(account.checked_at)}</span>
    </p>
  );
}

/** A saved server's credential, as its row says it. */
const CREDENTIAL: Record<string, [string, "success" | "warning" | "plain"]> = {
  sealed: ["sealed", "success"], expired: ["sign-in expired", "warning"], unreadable: ["can't be opened: enter it again", "warning"],
};

/** Settings → MCP servers: the remote MCP servers this server keeps, each with its tools and its credential's state, and
 *  a form to add one: its address and credential, a preview of the tools it lists, then Save. A credential goes to the
 *  server and nowhere else: its inputs are uncontrolled (React would mirror a value into the DOM), never filled from a
 *  read, and cleared once sent to be kept: every credential is kept sealed under the server's seal key. `signIn`, the
 *  outcome an OAuth sign-in's way back names (`#/settings/mcp?server=&sign_in=`); `open` takes the browser to a sign-in. */
/** `writable`: this session may type a credential (session.secrets_writable); `whyNot`, why not when it may not. */
type Add = McpAdd;
/** `choices`: capabilities' tools with a provider choice, so a save of the server's tool settings sends no default
 *  provider back as if picked. */
export function McpServersPage({ v2, signIn, add, writable, whyNot = "sign_in", open = (url) => location.assign(url), choices = [] }: { v2: Client; signIn?: SignIn; add?: Add; writable: boolean; whyNot?: SecretsWhyNot; open?: (url: string) => void; choices?: readonly ToolChoice[] }) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  // This server's tool settings (GET /v2/settings/tools): each saved server's Allow reads and its tools' permissions. Not
  // read (a token without the right, an older server): the tools list without them.
  const [settings, setSettings] = useState<ToolSettings | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsProblem, setSettingsProblem] = useState<{ server: string; problem: Problem } | null>(null);
  const [loadError, setLoadError] = useState<Problem | null>(null);
  // A template's Apply sent the person here to set up a server it needs: a Composio one opens the Composio form with its
  // toolkit and actions filled (the key is a credential, so only where this session may type one), any other the add form.
  const composioAdd = add?.preset === "composio" ? add : undefined;
  // The open form: a new server, or a saved one; `problem`, a saved row's refusal it opens with (its sign-in needs a
  // Client ID), so the form keeps that guidance. `add`: the add form opens with its name filled.
  const [form, setForm] = useState<{ saved?: McpServer; problem?: Problem; add?: Add } | null>(add && !composioAdd ? { add } : null);
  // The Composio form, open (true), open filled from a template's need (its `add`), or closed.
  const [composio, setComposio] = useState<boolean | Add>(composioAdd && writable ? composioAdd : false);
  // What a delete says after its row is gone: a Composio server that could not be removed there is the owner's to remove.
  // What a Composio server's delete did there (`removed`: all of it went), shown once the row is gone.
  const [removedNote, setRemovedNote] = useState<{ removed: boolean; note: string } | null>(null);
  // The forms follow the `add` param on every location change: Back to a setup URL opens one again, with its fields reset.
  const addKey = add ? JSON.stringify(add) : "";
  const seenAdd = useRef(addKey);
  useEffect(() => {
    if (addKey === seenAdd.current) return;
    seenAdd.current = addKey;
    const next: Add | undefined = addKey ? JSON.parse(addKey) : undefined;
    setForm(next && next.preset !== "composio" ? { add: next } : null);
    setComposio(next?.preset === "composio" && writable ? next : false);
  }, [addKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const asked = useRef(0);
  const page = useRef<HTMLDivElement>(null);
  const load = () => {
    const n = ++asked.current;
    v2.listMcpServers().then((r) => { if (n === asked.current) { setServers(r.servers); setLoadError(null); } }, (e) => { if (n === asked.current) setLoadError(mcpProblem(e)); });
  };
  useEffect(load, [v2]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { v2.toolSettings().then(setSettings, () => setSettings(null)); }, [v2]);
  // A change of one server's settings, saved as the Tools page saves: the map read as it is now, the change made to it,
  // and every other key and field written back as it was (a PUT replaces the whole map). The servers are read again
  // after it: each tool's permission in force is the server's word. One at a time: a second save started while one is out
  // could write back the map as it was before the first, and undo it. Held outside React's state, so two changes in the
  // same tick are one save; every control that saves is disabled while one is out.
  const saving = useRef(false);
  const saveSettings = async (server: string, edit: (current: ToolSettings) => ToolSettings) => {
    if (saving.current) return;
    saving.current = true;
    setSettingsBusy(true); setSettingsProblem(null);
    try {
      const now = await v2.toolSettings();
      setSettings(await v2.saveToolSettings(edit(ownSettings(now, choices))));
      load();
    } catch (e) { setSettingsProblem({ server, problem: mcpProblem(e) }); }
    saving.current = false;
    setSettingsBusy(false);
  };
  // A template's setup link fills a name no saved server has: its own, else the first free `<name>-<n>`, so saving never
  // replaces a server of that name (an older one that matches no need, say). Chosen once the list is read, and kept for
  // that link: the server it saves is never counted against it.
  const named = useRef<{ key: string; name: string } | null>(null);
  // A link to change a saved server (a refused secret write's `change`) keeps its name: its save replaces that server.
  if (add && servers && named.current?.key !== addKey) named.current = { key: addKey, name: add.change ? add.name : freeName(add.name, servers) };
  // The need's toolkit stays the link's own (a url need's is its name) when the name moves to a free one.
  const filled = (a: Add): Add => (named.current?.key === JSON.stringify(a) && named.current.name !== a.name ? { ...a, toolkit: a.toolkit ?? a.name, name: named.current.name } : a);
  // A form a link filled waits for the list (or its failure), so the name it shows is the one it saves.
  const listed = servers !== null || loadError !== null;
  // A link to change a saved server (`?change=<name>`, a refused secret write's): that server's Change form, filled with
  // the link's address and kind of credential. A name no longer saved opens the add form with it.
  const changing = form?.add?.change ? servers?.find((s) => s.name === form.add!.name) : undefined;
  const formSaved = form?.saved ?? changing;
  // The outcome is said once: a reload of the page does not say it again.
  useEffect(() => { if (signIn && location.hash.includes("sign_in=")) history.replaceState(null, "", "#/settings/mcp"); }, [signIn]);
  const startSignIn = async (name: string, body: Parameters<Client["startMcpSignIn"]>[1]) => open((await v2.startMcpSignIn(name, body)).authorization_url);
  return (
    <div ref={page} className="h-full overflow-auto">
      <div className={settingsPageClass}>
        <div className={settingsIntroClass}>
          <p className="caps text-label text-muted-foreground">Settings</p>
          <h1 className="mt-1 text-2xl font-semibold">MCP servers</h1>
          <p className="mt-2 text-lead text-muted-foreground">A remote MCP server's tools, for any agent you grant them to in its Tools step. A saved credential is never shown again.</p>
        </div>
        <div className={settingsBodyClass}>
          {signIn && (
            <p className={`border p-4 text-body ${signIn.ok ? "border-success/50 text-success-text" : "border-warning/50 text-warning-text"}`} role="status">
              {signIn.ok ? `Signed in to ${signIn.server}. Its tools are saved.` : `Signing in to ${signIn.server} failed: ${signInFailure(signIn.error)}.`}
            </p>
          )}
          {!writable && <p className="border bg-card p-4 text-body" role="status">{WHY_NOT_WORDS[whyNot]}</p>}
          {removedNote && <p className={`border p-4 text-body ${removedNote.removed ? "border-success/50 text-success-text" : "border-warning/50 text-warning-text"}`} role="status">{removedNote.note}</p>}
          {loadError && (
            <Banner tone="error" actions={<Button type="button" size="xs" onClick={load}>Try again</Button>}>
              <p className="font-mono">The MCP servers could not be read. {loadError.text}</p>
            </Banner>
          )}
          <SettingsSection title="Servers" aside={!form && !composio && (
            <>
              <Button size="sm" disabled={!writable} onClick={() => setComposio(true)}>Add from Composio</Button>
              <Button size="sm" variant="primary" onClick={() => setForm({})}>Add server</Button>
            </>
          )}>
        {/* A save that lands after its form was closed (Cancel, or another Change) closes no form opened since. */}
        {form && (!form.add || listed) && <ServerForm key={`${formSaved?.name ?? "new"}|${form.add ? JSON.stringify(form.add) : ""}`} v2={v2} saved={formSaved} add={form.add && (changing ? form.add : filled(form.add))} given={form.problem} writable={writable} taken={servers} signIn={startSignIn} onCancel={() => setForm(null)} onSaved={((mine) => (said?: { removed: boolean; note: string }) => { if (said) setRemovedNote(said); setForm((open) => (open === mine ? null : open)); load(); })(form)} />}
        {composio && (typeof composio !== "object" || listed) && <ComposioForm key={typeof composio === "object" ? addKey : "new"} v2={v2} add={typeof composio === "object" ? filled(composio) : undefined} onClose={() => setComposio(false)} onSaved={load} />}
        {servers && (servers.length
          ? <ul className="border">{servers.map((s) => <ServerRow key={s.name} v2={v2} server={s} settings={settings} settingsBusy={settingsBusy} settingsProblem={settingsProblem?.server === s.name ? settingsProblem.problem : null} onSettings={(edit) => void saveSettings(s.name, edit)} writable={writable && !form} signIn={startSignIn} onChange={(problem) => setForm({ saved: s, ...(problem ? { problem } : {}) })}
            onPaste={() => void pasteFromClipboard(() => setForm({ saved: s }), () => page.current?.querySelector<HTMLInputElement>('input[name="mcp-token"], input[name="mcp-header-value-0"]') ?? null)} onChanged={load} onDeleted={(said) => { setRemovedNote(said ?? null); load(); }} />)}</ul>
          : <p className="border px-3 py-4 font-mono text-body text-muted-foreground">No MCP server is saved here yet.</p>)}
          </SettingsSection>
          <PrivateHosts v2={v2} />
        </div>
      </div>
    </div>
  );
}

const Said = ({ problem }: { problem: Problem }) => (
  <div role="alert"><p className="font-mono text-body text-destructive-text">{problem.text}</p>{problem.detail && <p className="mt-1 text-small text-muted-foreground">{problem.detail}</p>}</div>
);

/** Each tool's key in the tool settings (`mcp:<server>/<tool>`), and the server's wildcard. */
const keyOf = (server: string, tool: string) => `mcp:${server}/${tool}`;
const ALL_PERMISSIONS: Permission[] = ["allow", "ask", "deny"];

function ServerRow({ v2, server: s, settings, settingsBusy, settingsProblem, onSettings, writable, signIn, onChange, onPaste, onChanged, onDeleted }: {
  v2: Client; server: McpServer; writable: boolean; signIn: (name: string, body: { url: string }) => Promise<void>; onChange: (problem?: Problem) => void; onPaste: () => void; onChanged: () => void; onDeleted: (said?: { removed: boolean; note: string }) => void;
  settings: ToolSettings | null; settingsBusy: boolean; settingsProblem: Problem | null; onSettings: (edit: (current: ToolSettings) => ToolSettings) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState<McpRefresh | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const run = async (work: () => Promise<void>) => { setBusy(true); setProblem(null); try { await work(); } catch (e) { setProblem(mcpProblem(e)); } setBusy(false); };
  // A github_app server's credential is its GitHub App, which signs a token for each run: it keeps none of its own unless
  // optional headers were saved, so having none is its normal state, not a missing credential.
  const app = s.auth.type === "github_app";
  const [said, tone] = s.credential ? CREDENTIAL[s.credential] ?? [s.credential, "plain"] : app ? ["GitHub App", "success" as const] : ["no credential", "plain" as const];
  const oauth = s.auth.type === "oauth";
  const changes = note && [["Added", note.added], ["Removed", note.removed], ["Changed", note.changed]].filter(([, names]) => names.length).map(([what, names]) => `${what} ${(names as string[]).join(", ")}`);
  return (
    <li data-server={s.name} className="border-b p-4 last:border-b-0">
      <div className="flex flex-wrap items-start gap-3">
        <Plug className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2"><span className="font-mono text-prose font-semibold">{s.name}</span><Chip tone={tone}>{said}</Chip>{!!s.not_metered?.length && <Chip tone="plain">not metered</Chip>}
            {/* What a template's MCP need is matched on: where its tools come from and the toolkit they are. */}
            {s.source && <><Chip tone="muted">{SOURCE_LABEL[s.source]}</Chip><span data-toolkit className="font-mono text-small text-muted-foreground">{s.toolkit ? `toolkit ${s.toolkit}` : "no toolkit"}</span></>}</p>
          {s.composio_account && <AccountLine account={s.composio_account} />}
          <p className="mt-1.5 break-all font-mono text-small text-muted-foreground">{s.url}</p>
          {s.auth.type === "github_app" && <p className="mt-1 font-mono text-small text-muted-foreground">Signed with this server's GitHub App: a token narrowed to the run's repository is made for each run{s.auth.headers?.length ? ` · headers ${s.auth.headers.join(", ")}` : ""}</p>}
          {oauth && s.oauth &&<p className="mt-1 font-mono text-small text-muted-foreground">Signed in with OAuth{s.oauth.scopes.length ? ` · ${s.oauth.scopes.join(" ")}` : ""}{s.oauth.client === "pre-registered" && s.oauth.client_id ? ` · client ${s.oauth.client_id}` : ""}{s.credential === "expired" ? " · sign-in expired: sign in again" : s.oauth.expires_at ? ` · token until ${when(s.oauth.expires_at)}` : ""}</p>}
          {settings && <AllowReads server={s} settings={settings} busy={settingsBusy} onSettings={onSettings} />}
          {settingsProblem && <div className="mt-2"><Said problem={settingsProblem} /></div>}
          <details className="mt-2">
            <summary className="cursor-pointer font-mono text-small">{s.tools.length} tool{s.tools.length === 1 ? "" : "s"}</summary>
            <div className="mt-2"><ServerTools server={s} settings={settings} busy={settingsBusy} onSettings={onSettings} /></div>
          </details>
          {/* Its one secret ("mcp:<server>": its bearer token, its headers' values, or its sign-in), as every secret's row.
              Replace opens the server's form; a sign-in's has none: its Sign in is the write. */}
          {s.secret && !(app && !s.secret.set) && <ul className="mt-2"><SecretRow field={s.secret} label={AUTH_LABEL[s.auth.type]} writable={writable} onPaste={oauth ? undefined : onPaste} /></ul>}
          {s.source === "composio" && <AppTriggers v2={v2} server={s.name} writable={writable} />}
          {changes && <p className="mt-2 font-mono text-small" role="status">{changes.length ? changes.join(" · ") : "No change: it lists the same tools."}</p>}
        </div>
        {!confirm && (
          <div className="flex flex-wrap gap-2">
            {oauth && s.credential !== "sealed" && writable && <Button size="sm" variant="primary" disabled={busy} onClick={() => void run(() => signIn(s.name, { url: s.url, ...(s.oauth?.scopes.length ? { scopes: s.oauth.scopes } : {}) }))}>Sign in again</Button>}
            {/* The list is read again however the refresh went: a refusal (a sign-in expired or revoked) changes the credential's state too. */}
            <Button size="sm" disabled={busy} onClick={() => void run(async () => { try { setNote(await v2.refreshMcpServer(s.name)); } finally { onChanged(); } })}>Refresh</Button>
            <Button size="sm" disabled={busy} onClick={() => onChange()}>Change</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setConfirm(true)}>Delete</Button>
          </div>
        )}
      </div>
      {confirm && (
        <div role="alertdialog" aria-label={`Delete ${s.name}`} className="mt-4 flex flex-wrap items-center gap-3 border bg-card p-3">
          <p className="min-w-0 flex-1 text-body">Delete {s.name}? Its credential goes with it, and an agent that grants its tools can't call them.</p>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(async () => { onDeleted((await v2.deleteMcpServer(s.name))?.composio); })}>Delete</Button>
          <Button size="sm" onClick={() => setConfirm(false)}>Keep</Button>
        </div>
      )}
      {problem && <div className="mt-3"><Said problem={problem} />{problem.needsClient && writable && <Button className="mt-2" size="sm" variant="primary" onClick={() => onChange(problem)}>Enter a Client ID</Button>}</div>}
    </li>
  );
}

/** Whether Composio has a trigger's instance on, in a row's words. */
const ON_COMPOSIO: Record<ComposioTriggers["triggers"][number]["on_composio"], string> = { on: "on at Composio", off: "off at Composio", missing: "Composio no longer has it", unknown: "Composio didn't say" };

/** A saved Composio server's triggers (GET .../composio/triggers): each one that uses it, linked, with its event and
 *  whether its instance is on at Composio; where the project's webhook subscription sends its events; and Rotate secret
 *  (asked first), which shows no secret: Composio makes it and this server keeps it. A server too old to answer (404)
 *  shows none of it. */
function AppTriggers({ v2, server, writable }: { v2: Client; server: string; writable: boolean }) {
  const [read, setRead] = useState<ComposioTriggers | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [hidden, setHidden] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rotated, setRotated] = useState(false);
  useEffect(() => {
    let live = true;
    v2.composioTriggers(server).then((r) => { if (live) setRead(r); }, (e) => {
      if (!live) return;
      if (e instanceof ClientError && e.status === 404) setHidden(true);
      else setProblem(mcpProblem(e));
    });
    return () => { live = false; };
  }, [v2, server]);
  if (hidden) return null;
  const rotate = async () => {
    setAsking(false); setBusy(true); setProblem(null); setRotated(false);
    try { await v2.rotateComposioSecret(server); setRotated(true); } catch (e) { setProblem(mcpProblem(e)); }
    setBusy(false);
  };
  const sub = read?.subscription;
  return (
    <section data-composio-triggers aria-label={`${server}'s triggers`} className="mt-3 border p-3">
      <p className="caps text-label text-muted-foreground">Triggers</p>
      {!read ? (!problem && <p className="mt-1 font-mono text-small text-muted-foreground">Reading its triggers</p>) : (
        <>
          {read.triggers.length ? (
            <ul className="mt-2 space-y-1">
              {read.triggers.map((t) => (
                <li key={t.id} data-trigger={t.id} className="flex flex-wrap items-center gap-x-2 text-body">
                  <a href={`#/triggers/${encodeURIComponent(t.id)}`} className="font-semibold hover:underline">{t.name}</a>
                  <span className="font-mono text-small text-muted-foreground">{t.event}</span>
                  <span className={`font-mono text-small ${t.on_composio === "missing" ? "text-warning-text" : "text-muted-foreground"}`}>· {ON_COMPOSIO[t.on_composio]}{t.enabled ? "" : " · paused here"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-body text-muted-foreground">No trigger uses it yet. <a href="#/triggers/new-composio" className="underline underline-offset-2">New app trigger</a></p>
          )}
          {read.composio_error && <p className="mt-2 text-small text-warning-text">Composio didn't answer: {read.composio_error}</p>}
          {sub && (sub.ours
            ? <p className="mt-2 text-small text-muted-foreground">The project's webhook subscription sends its events here.</p>
            : <p className="mt-2 break-all text-small text-muted-foreground">The project's webhook subscription sends its events to <span className="font-mono">{sub.webhook_url}</span>, not here: a new trigger asks before it moves it.</p>)}
          {sub?.ours && writable && !asking && <Button className="mt-2" size="sm" disabled={busy} onClick={() => setAsking(true)}>Rotate secret</Button>}
          {asking && (
            <div role="alertdialog" aria-label="Rotate the subscription's secret?" className="mt-2 flex flex-wrap items-center gap-3 border bg-card p-3">
              <p className="min-w-0 flex-1 text-body">Rotate the subscription's secret? Composio makes a new one and this server keeps it; a delivery signed with the old one is refused from then on.</p>
              <Button size="sm" variant="primary" onClick={() => void rotate()}>Yes, rotate</Button>
              <Button size="sm" onClick={() => setAsking(false)}>Keep</Button>
            </div>
          )}
          {rotated && <p className="mt-2 text-small text-success-text" role="status">Rotated: Composio signs with the new secret from now on.</p>}
        </>
      )}
      {problem && <div className="mt-2"><Said problem={problem} /></div>}
    </section>
  );
}

/** A saved server's Allow reads: one switch, saved at once on its wildcard (`mcp:<server>/*`'s allow_reads), that lets each
 *  of its read-only tools run with no one asked. A deny, a tool's own setting and an agent's own ask still hold. */
function AllowReads({ server: s, settings, busy, onSettings }: { server: McpServer; settings: ToolSettings; busy: boolean; onSettings: (edit: (current: ToolSettings) => ToolSettings) => void }) {
  const wildcard = keyOf(s.name, "*");
  const on = settings[wildcard]?.allow_reads === true;
  const reads = s.tools.filter((t) => t.effect === "read").length;
  const id = `allow-reads-${s.name}`;
  const words = `${id}-words`;
  const flip = (next: boolean) => onSettings((current) => {
    const { [wildcard]: old, ...rest } = current;
    const { allow_reads: _gone, ...kept } = old ?? {};
    const now = next ? { ...kept, allow_reads: true as const } : kept;
    return Object.keys(now).length ? { ...rest, [wildcard]: now } : rest;
  });
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2">
        <Switch checked={on} onChange={flip} busy={busy} labelledBy={id} />
        <span id={id} className="caps text-small font-semibold">Allow reads</span>
      </div>
      <p id={words} className="mt-1 text-small text-muted-foreground">{reads} of {s.tools.length} tool{s.tools.length === 1 ? "" : "s"} read-only, as the server marks them: {on ? "they run without asking" : "on, they run without asking"}. Writes keep their permission.</p>
    </div>
  );
}

/** A saved server's tools, each with its effect's mark and what a call costs; and, where this server's tool settings
 *  read, its permission here (`mcp:<server>/<tool>`), saved at once. A row's fallback is what applies with no setting of
 *  its own: allow where the server's read says Allow reads would let it run with no setting of its own
 *  (`fallback_allow_reads`, the server's word: never worked out here), named "allow reads", even while its own setting
 *  asks, so a choice of allow removes that setting; else the server's wildcard, else the owner's default. A destructive tool's allow takes
 *  a second click. */
function ServerTools({ server: s, settings, busy, onSettings }: { server: McpServer; settings: ToolSettings | null; busy: boolean; onSettings: (edit: (current: ToolSettings) => ToolSettings) => void }) {
  const wildcard = settings?.[keyOf(s.name, "*")];
  const byKey = new Map(s.tools.map((t) => [keyOf(s.name, t.name), t]));
  const rows = s.tools.map((t) => ({
    name: keyOf(s.name, t.name),
    ...(settings ? { gate: { name: keyOf(s.name, t.name), permission: t.permission ?? "ask", default_permission: t.default_permission ?? "ask", permissions: t.permissions?.length ? t.permissions : ALL_PERMISSIONS } } : {}),
  }));
  const detail = (tool: string) => {
    const price = s.prices?.[tool];
    return price !== undefined ? `$${price} a call` : s.not_metered?.includes(tool) ? "not metered" : null;
  };
  return (
    <ToolTable label={`${s.name}'s tools`} rows={rows} settings={settings ?? {}} busy={busy} issues={{}}
      fallbackOf={() => ""} resolvesOf={() => null} onEdit={onSettings}
      labelOf={(name) => byKey.get(name)?.name ?? name}
      detailOf={(name) => detail(byKey.get(name)?.name ?? "")}
      effectOf={(name) => byKey.get(name)?.effect}
      confirmAllowOf={(name) => byKey.get(name)?.effect === "destructive"}
      refused={(_, permission) => permission === "deny"}
      fallbackWordOf={(name) => (byKey.get(name)?.fallback_allow_reads ? "allow reads" : undefined)}
      permissionFallbackOf={(g) => (byKey.get(g.name)?.fallback_allow_reads ? "allow" : wildcard?.permission ?? g.default_permission)} />
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
    <SettingsSection titleId="mcp-private-hosts" title="Private network hosts" note={<p>Off by default. A host listed here may run an MCP server's sign-in on your private network (10.x, 172.16–31.x, 192.168.x, 100.64–127.x, fc00::/7), over https only; never this machine, loopback or a link-local address such as cloud metadata.</p>}>
      {loadError && (
        <div role="alert">
          <p className="font-mono text-body text-destructive-text">The private network hosts could not be read. {loadError.text}</p>
          <Button size="sm" onClick={load} className="mt-3">Try again</Button>
        </div>
      )}
      {hosts && (hosts.length
        ? <ul aria-label="Allowed private network hosts" className="border">{hosts.map((host) => (
            <li key={host} data-host={host} className="flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0">
              <span className="break-all font-mono text-body">{host}</span>
              <Button size="sm" disabled={busy} onClick={() => void save(hosts.filter((h) => h !== host))}>Remove</Button>
            </li>
          ))}</ul>
        : <p className="border px-3 py-4 font-mono text-body text-muted-foreground">No host is allowed: a sign-in on a private network is refused.</p>)}
      {hosts && (
        <form onSubmit={(e) => void allow(e)} aria-label="Allow a private network host" className="flex gap-2">
          <Input name="mcp-private-host" aria-label="Host name or IP address" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="auth.corp.example" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          <Button type="submit" size="sm" variant="primary" disabled={busy || !draft.trim()}>Allow</Button>
        </form>
      )}
      {problem && <Said problem={problem} />}
    </SettingsSection>
  );
}

/** A saved MCP server's name: at most this many characters (the server's MCP_SERVER_NAME). */
const MAX_SERVER_NAME = 32;

/** `name` if no server of `servers` has it, else the first `<name>-<n>` none has (n from 2), `name` cut (and any dash it
 *  then ends on dropped) so the whole stays within MAX_SERVER_NAME. */
export function freeName(name: string, servers: readonly Pick<McpServer, "name">[]): string {
  const taken = new Set(servers.map((s) => s.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const free = `${name.slice(0, MAX_SERVER_NAME - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(free)) return free;
  }
}

/** Settings → MCP servers → Add from Composio: Composio is an MCP server like any other. The key and a toolkit load that
 *  toolkit's actions, the ones ticked are what the saved server grants, and the server saves it as an MCP server with the
 *  key sealed. A toolkit that needs your account answers a link to Composio's page to connect it. The key is an
 *  uncontrolled input, never filled from a read and cleared once sent. `add`: a template's need it opened for, its name
 *  and toolkit filled and, once its actions load, the ones the template uses ticked. A toolkit lists hundreds of
 *  actions (GitHub's), so a filter box over them keeps those whose name, slug or description has its words. */
function ComposioForm({ v2, add, onClose, onSaved }: { v2: Client; add?: Add; onClose: () => void; onSaved: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const [toolkit, setToolkit] = useState(add?.toolkit ?? "");
  const [name, setName] = useState(add?.name ?? "");
  const [listed, setListed] = useState<ComposioTools | null>(null);
  // The toolkits Composio offers, for the picker: loaded with the key typed (none until then). A template's toolkit is
  // picked before any list is loaded. `typed`: the toolkit is typed as its slug instead, when the list failed or leaves
  // it out; the actions route still checks it.
  const [kits, setKits] = useState<ComposioToolkit[] | null>(null);
  const [typed, setTyped] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  // What a save says after it is saved: where to connect the account, the actions not served, and what a save over a
  // server did at Composio with what its earlier save made.
  const [after, setAfter] = useState<{ connect?: string; notServed?: string[]; composio?: { removed: boolean; note: string } } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);
  // Cancel is off only while a save is out (its answer decides what the form shows next); a load never locks it.
  const [saving, setSaving] = useState(false);
  const key = () => ((form.current?.elements.namedItem("composio-key") as HTMLInputElement | null)?.value ?? "").trim();
  const act = async (work: () => Promise<void>) => { setBusy(true); setProblem(null); try { await work(); } catch (e) { setProblem(mcpProblem(e)); } setBusy(false); };
  // Each edit of the key or toolkit, and each load, is a new ask: the request under way is aborted, and an answer or a
  // refusal to an older ask is dropped, never shown under the key or toolkit now in the form.
  const asked = useRef(0);
  const running = useRef<AbortController | null>(null);
  const stale = () => { asked.current++; running.current?.abort(); running.current = null; };
  useEffect(() => stale, []);
  const asking = <T,>(send: (signal: AbortSignal) => Promise<T>, take: (answer: T) => void) => act(async () => {
    stale();
    const mine = asked.current;
    const control = (running.current = new AbortController());
    try {
      const answer = await send(control.signal);
      if (mine === asked.current) take(answer);
    } catch (e) { if (mine === asked.current) throw e; }
  });
  const changed = () => { stale(); setListed(null); };
  const load = () => { setListed(null); setPicked([]); setQuery(""); return asking((signal) => v2.composioTools(key(), toolkit.trim().toLowerCase(), signal), (answer) => {
    setListed(answer);
    // The template's actions ticked, those of them the toolkit lists, while the toolkit is still the one it needs.
    if (add?.tools && answer.toolkit === add.toolkit) setPicked(answer.tools.map((t) => t.slug).filter((slug) => add.tools!.includes(slug)));
  }); };
  // The toolkit list is the key's: each edit of the key drops it and the toolkit picked from it (a template's, or one
  // typed, stays).
  const keyChanged = () => { stale(); setKits(null); setToolkit((now) => (typed || (add?.toolkit && now === add.toolkit) ? now : "")); };
  // A list that fails leaves the slug to be typed.
  const loadKits = () => asking((signal) => v2.composioToolkits(key(), signal).catch((e: unknown) => { if (!signal.aborted) setTyped(true); throw e; }), (answer) => { setKits(answer.toolkits); setTyped(false); });
  const kitOptions: SearchPickerOption[] = (kits ?? []).map((k) => ({ value: k.slug, label: `${k.name} · ${k.slug}` }));
  // A toolkit already chosen (a template's) that the list doesn't have stays an option, so the field still shows it.
  if (toolkit && !kitOptions.some((o) => o.value === toolkit)) kitOptions.unshift({ value: toolkit, label: toolkit });
  const save = () => act(async () => {
    setSaving(true);
    const answer = await v2.saveComposioServer(name.trim(), key(), listed!.toolkit, picked).finally(() => setSaving(false));
    form.current?.reset();
    onSaved();
    if (answer.connect_url || answer.not_served?.length || answer.composio) setAfter({ connect: answer.connect_url, notServed: answer.not_served, composio: answer.composio }); else onClose();
  });
  const shown = listed ? listed.tools.filter((t) => matchesFilter(query, t.name, t.slug, t.description)) : [];
  const toggle = (slug: string) => setPicked((now) => (now.includes(slug) ? now.filter((x) => x !== slug) : [...now, slug]));
  if (after) {
    return (
      <section aria-label="Composio server saved" className="space-y-3 border bg-card p-4">
        <p className="text-body">Saved.{after.connect ? ` Its tools need your ${listed?.toolkit} account: connect it on Composio, then refresh the server.` : ""}</p>
        {after.connect && <p><a href={after.connect} target="_blank" rel="noopener noreferrer" className="font-mono text-body underline">Connect your {listed?.toolkit} account</a></p>}
        {after.notServed?.length ? <p className="font-mono text-body text-muted-foreground">Composio's server doesn't list {after.notServed.join(", ")}: a run can't call {after.notServed.length === 1 ? "it" : "them"}.</p> : null}
        {after.composio && <p className={`border p-4 text-body ${after.composio.removed ? "border-success/50 text-success-text" : "border-warning/50 text-warning-text"}`} role="status">{after.composio.note}</p>}
        <Button size="sm" onClick={onClose}>Done</Button>
      </section>
    );
  }
  return (
    <form ref={form} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (listed && picked.length && name.trim()) void save(); }} aria-label="Add from Composio" className="space-y-4 border bg-card p-4"
      onInput={(e) => { if ((e.target as HTMLInputElement).name === "composio-key") { changed(); keyChanged(); setHasKey(!!key()); } }}>
      <p className="text-small text-muted-foreground">Composio runs the toolkit's actions for you. This saves an MCP server that grants only the actions you tick, with your Composio key sealed like any credential.</p>
      {add?.tools && <p role="note" className="text-small text-muted-foreground">A template uses {add.tools.join(", ")}: enter your key and load the actions, and those are ticked.</p>}
      <label className="block"><span className="caps mb-2 block text-small font-semibold">Composio API key</span><Input name="composio-key" {...secret} /></label>
      <div className="block" {...(kits ? { "data-toolkits-loaded": "" } : {})}><span className="caps mb-2 block text-small font-semibold">Toolkit</span>
        {/* Composio's list, by name; or the slug typed, when the list failed or leaves the toolkit out. */}
        <div className="flex gap-2">
          {typed
            ? <Input name="composio-toolkit" aria-label="Toolkit slug" className="min-w-0 flex-1" value={toolkit} placeholder="github" spellCheck={false} autoCapitalize="off" autoCorrect="off"
                onChange={(e) => { setToolkit(e.target.value); changed(); }} />
            : <SearchPicker label="Toolkit" className="min-w-0 flex-1" value={toolkit} options={kitOptions} disabled={!kitOptions.length}
                placeholder={kits ? "Search or pick a toolkit" : "Load the toolkits with your key"} nothing={(q) => `No toolkit matches “${q}”`} onChange={(next) => { setToolkit(next); changed(); }} />}
          <Button type="button" size="md" disabled={busy || !hasKey} onClick={() => void loadKits()}>Load toolkits</Button>
        </div>
        {kits && !kits.length && <p className="mt-1 font-mono text-small text-muted-foreground">Composio lists no toolkit for this key.</p>}
        {kits && <Button type="button" size="xs" variant="ghost" className="mt-1" onClick={() => setTyped((now) => !now)}>{typed ? "Pick from the list" : "Not listed? Type its slug"}</Button>}
      </div>
      {problem && <Said problem={problem} />}
      {listed && (
        <fieldset className="space-y-2">
          <legend className="caps mb-2 text-small font-semibold">Actions to grant</legend>
          {listed.tools.length > 0 && <ListFilter value={query} onChange={setQuery} label="Filter actions" placeholder="Filter by name, slug or description" shown={shown.length} total={listed.tools.length} ticked={picked.length} />}
          {!listed.tools.length ? <p className="font-mono text-body text-muted-foreground">This toolkit lists no actions.</p>
            : !shown.length ? <p className="font-mono text-body text-muted-foreground">No action matches “{query.trim()}”.</p>
            : <ul className="divide-y border">{shown.map((t) => (
            <li key={t.slug} className="px-3 py-2"><label className="flex items-start gap-2 text-body">
              <input type="checkbox" value={t.slug} checked={picked.includes(t.slug)} onChange={() => toggle(t.slug)} className="mt-1 accent-primary" />
              <span><span className="font-mono">{t.name}</span><span className="ml-2 font-mono text-small text-muted-foreground">{t.slug}</span>{t.description && <span className="block text-small text-muted-foreground">{t.description}</span>}</span>
            </label></li>
          ))}</ul>}
          <label className="block"><span className="caps mb-2 block text-small font-semibold">Name</span>
            <span className="-mt-1 mb-2 block text-small text-muted-foreground">Lowercase letters, digits and dashes: an agent grants its tools as mcp:{name.trim() || "<name>"}/&lt;tool&gt;.</span>
            <Input name="composio-name" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} /></label>
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy || !toolkit.trim()} onClick={() => void load()}>Load actions</Button>
        {listed && <Button type="submit" size="sm" variant="solid" disabled={busy || !picked.length || !name.trim()}>{busy ? "Working" : "Save"}</Button>}
        <Button type="button" size="sm" disabled={saving} onClick={() => { stale(); form.current?.reset(); onClose(); }}>Cancel</Button>
      </div>
    </form>
  );
}

/** The credential inputs a preset clears: the token, header rows, OAuth scopes and client. */
const CREDENTIAL_FIELD = /^mcp-(token|scopes|client-id|client-secret|header-(name|value)-\d+)$/;
const secret = { type: "password", autoComplete: "new-password", spellCheck: false, autoCapitalize: "off", autoCorrect: "off", "data-1p-ignore": true, "data-lpignore": "true" } as const;
const AUTH: [McpAuth["type"], string][] = [["none", "None"], ["bearer", "Bearer token"], ["headers", "Headers"], ["oauth", "Sign in with OAuth"], ["github_app", "GitHub App"]];
/** A server's one secret ("mcp:<server>"), as its row says it: by the kind of credential it is. */
const AUTH_LABEL: Record<McpAuth["type"], string> = { none: "Credential", bearer: "Bearer token", headers: "Headers", oauth: "OAuth sign-in", github_app: "Headers" };

/** Add a server, or change a saved one (`saved`: its name stays, and a credential left empty is the sealed one kept).
 *  A new server is previewed before it can be saved; any change of its address or credential asks for another. A new
 *  server's form offers the URL presets (MCP_URL_PRESETS): one fills the name (the first free one of `taken`), address,
 *  credential and toolkit, and says its note; `add.preset` opens the form with one filled. */
function ServerForm({ v2, saved, add, given, writable, taken, signIn, onCancel, onSaved }: { v2: Client; saved?: McpServer; add?: Add; given?: Problem; writable: boolean; taken: readonly Pick<McpServer, "name">[] | null; signIn: (name: string, body: Parameters<Client["startMcpSignIn"]>[1]) => Promise<void>; onCancel: () => void; onSaved: (said?: { removed: boolean; note: string }) => void }) {
  const form = useRef<HTMLFormElement>(null);
  const linked = saved ? undefined : urlPresetOf(add?.preset);
  const [preset, setPreset] = useState<McpPreset | undefined>(linked);
  const [name, setName] = useState(saved?.name ?? add?.name ?? "");
  // A link's address and kind of credential (a refused secret write's) fill the form, a saved server's Change form too.
  const [url, setUrl] = useState(add?.url ?? saved?.url ?? (add?.auth === "github_app" ? GITHUB_MCP_URL : linked?.url ?? ""));
  const [type, setType] = useState<McpAuth["type"]>(add?.auth ?? saved?.auth.type ?? linked?.auth ?? "none");
  const [headerRows, setHeaderRows] = useState(Math.max(1, saved?.auth.headers?.length ?? 0));
  // Where its tools come from and the toolkit they are, which a template's MCP need is matched on. The source is what made
  // the server, shown and never sent: on the GitHub App's tokens github (its toolkit github), from the Composio preset
  // composio, else url. The toolkit is the owner's to set; a server a template's url need sent the person here for starts
  // with that toolkit.
  const shownSource: McpSource = type === "github_app" ? "github" : saved?.source === "composio" ? "composio" : "url";
  // A preset's tools are its toolkit's, whatever name the link gave the server.
  // A template's url need names its toolkit by the server's name; a refused write's link names one only when it sent one.
  // A link to change a saved server with the toolkit its refused save named fills that one over the saved one, as it does
  // the address and the kind of credential.
  const [toolkit, setToolkit] = useState((add?.change ? add.toolkit : undefined) ?? saved?.toolkit ?? (linked ? linked.name : add?.auth === "github_app" ? "" : add ? add.toolkit ?? (add.auth || add.url ? "" : add.name) : ""));
  const shownToolkit = shownSource === "github" ? "github" : toolkit.trim();
  // What a save sends of it: only a toolkit that differs from the saved server's (a new one: only one said); one on the
  // GitHub App's tokens sends none.
  const kind = (): { toolkit?: string | null } => {
    if (type === "github_app") return {};
    const named = shownToolkit || null;
    if (saved) return named !== saved.toolkit ? { toolkit: named } : {};
    return named ? { toolkit: named } : {};
  };
  // A new server's name already saved would replace that server (a save is a PUT to its name): refused, and so is any
  // new one while the saved servers are unread (`taken` null), whose names aren't known yet.
  const clash = !saved && !!taken?.some((s) => s.name === name.trim());
  const addable = !!saved || (!!taken && !clash);
  const [preview, setPreview] = useState<McpPreview | null>(null);
  // `given`: the refusal its row opened it with (a sign-in that needs a Client ID), kept until the next try.
  const [problem, setProblem] = useState<Problem | null>(given ?? null);
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
  // A link that filled the rest (a refused secret write's: its address, or a saved server to change) leaves the
  // credential alone to type: the cursor starts there.
  useEffect(() => {
    if (!add?.url && !add?.change) return;
    const field = type === "bearer" ? "mcp-token" : type === "headers" ? "mcp-header-name-0" : undefined;
    if (field) (form.current?.elements.namedItem(field) as HTMLInputElement | null)?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // The credential typed: none typed is none sent, which a save takes as "keep the sealed one".
  const auth = (): McpAuth => {
    if (type === "bearer") return value("mcp-token") ? { type, token: value("mcp-token") } : { type };
    if (type !== "headers" && type !== "github_app") return { type };
    const headers = Object.fromEntries(Array.from({ length: headerRows }, (_, i) => [value(`mcp-header-name-${i}`), value(`mcp-header-value-${i}`)]).filter(([k, v]) => k && v));
    return Object.keys(headers).length ? { type, headers } : { type };
  };
  const act = async (work: () => Promise<void>) => { setBusy(true); setProblem(null); try { await work(); } catch (e) { setProblem(mcpProblem(e)); } setBusy(false); };
  // A sign-in that needs a Client ID entered (its authorization server lets no app register itself): the form turns to
  // OAuth, so its Client ID and Secret fields show, and the Client ID takes the cursor. Never a dead end.
  const needsClient = !!problem?.needsClient;
  useEffect(() => { if (needsClient) setType("oauth"); }, [needsClient]);
  useEffect(() => {
    if (needsClient && type === "oauth") (form.current?.elements.namedItem("mcp-client-id") as HTMLInputElement | null)?.focus();
  }, [needsClient, type]);
  const startSignIn = () => addable && act(() => {
    const scopes = value("mcp-scopes").split(/\s+/).filter(Boolean);
    const client = value("mcp-client-id");
    // Its source and toolkit go with the sign-in: the server writes them for the server the sign-in saves.
    return signIn(name.trim(), { url: url.trim(), ...(scopes.length ? { scopes } : {}), ...(client ? { client_id: client, ...(value("mcp-client-secret") ? { client_secret: value("mcp-client-secret") } : {}) } : {}), ...kind() });
  });
  const runPreview = () => {
    const asked = edits.current;
    void act(async () => {
      try {
        const answer = await v2.previewMcpServer(url.trim(), auth(), saved?.name);
        if (asked === edits.current) setPreview(answer);
      } catch (e) { if (asked === edits.current) throw e; }
    });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!addable) return;
    if (type === "oauth" && (!saved || needsSignIn)) return void startSignIn();
    // No prices are sent: this form sets none, and the server keeps the saved ones for the tools still listed at the same
    // address when a PUT has none. A change that moved a Composio server off Composio says what it removed there.
    void act(async () => { const answer = await v2.saveMcpServer(name.trim(), url.trim(), auth(), kind()); form.current?.reset(); onSaved(answer.composio); });
  };
  const canSave = !busy && addable && !!name.trim() && !!url.trim() && (!!saved || !!preview);
  // A preset fills the form as typing would: a new preview is asked for, and anything filled stays the owner's to change.
  // A credential typed for another server (a token, headers, scopes, a client) is cleared: it never goes to the preset's
  // address. Presets wait for the saved servers (`taken`), so the name picked is a free one.
  const choose = (p: McpPreset) => {
    if (!taken) return;
    for (const el of Array.from(form.current?.elements ?? [])) if (el instanceof HTMLInputElement && CREDENTIAL_FIELD.test(el.name)) el.value = "";
    setHeaderRows(1);
    setPreset(p); setName(freeName(p.name, taken)); setUrl(p.url); setType(p.auth); setToolkit(p.name); setProblem(null); edited();
  };
  const keepNote = (what: string) => saved?.credential === "sealed" && saved.auth.type === type && <span className="-mt-1 mb-2 block text-small text-muted-foreground">Saved. {what}</span>;
  return (
    <form ref={form} autoComplete="off" onSubmit={submit} aria-label={saved ? `Change ${saved.name}` : "Add an MCP server"} className="space-y-4 border bg-card p-4"
      onInput={(e) => { if (!["mcp-name", "mcp-toolkit"].includes((e.target as HTMLInputElement).name)) edited(); checkSignIn(); }}>
      {!saved && (
        <div className="space-y-2">
          <span className="caps block text-small font-semibold">Presets</span>
          <div className="flex flex-wrap gap-2">
            {MCP_URL_PRESETS.map((p) => (
              <Button key={p.id} type="button" size="sm" variant={preset?.id === p.id ? "solid" : "outline"} aria-pressed={preset?.id === p.id} disabled={busy || !taken || (!writable && p.auth !== "none")} onClick={() => choose(p)}>{p.label}</Button>
            ))}
          </div>
          {!taken && <p className="text-small text-muted-foreground">The presets wait for the saved servers to be read, so the name one picks is free.</p>}
          {preset && <p role="note" data-mcp-preset={preset.id} className="text-small text-muted-foreground">{preset.note}</p>}
          {preset?.readOnly && (
            <div className="flex items-center gap-2">
              <Switch checked={url === preset.readOnly} label="Read-only" disabled={busy} onChange={(on) => { setUrl(on ? preset.readOnly! : preset.url); edited(); }} />
              <span className="text-small text-muted-foreground">Read-only: its address that lists only the read tools.</span>
            </div>
          )}
          <p className="caps pt-2 text-small font-semibold">Or any MCP URL</p>
        </div>
      )}
      <label className="block"><span className="caps mb-2 block text-small font-semibold">Name</span>
        <span className="-mt-1 mb-2 block text-small text-muted-foreground">Lowercase letters, digits and dashes: an agent grants its tools as mcp:{name.trim() || "<name>"}/&lt;tool&gt;.</span>
        <Input name="mcp-name" value={name} readOnly={!!saved} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        {clash && <span role="alert" className="mt-1 block text-small text-destructive-text">{name.trim()} is saved already: saving would replace it. Change it from its row, or choose another name.</span>}</label>
      <label className="block"><span className="caps mb-2 block text-small font-semibold">Address</span>
        <Input name="mcp-url" value={url} onChange={(e) => { setUrl(e.target.value); if (problem?.needsClient) setProblem(null); }} placeholder="https://mcp.example.com/mcp" spellCheck={false} /></label>
      <div className="block"><span className="caps mb-2 block text-small font-semibold">Source</span>
        <span className="-mt-1 mb-2 block text-small text-muted-foreground">What made it: GitHub App access is GitHub, the Composio preset is Composio, anything else is URL.</span>
        <span data-mcp-source={shownSource}className="font-mono text-body">{SOURCE_LABEL[shownSource]}</span></div>
      <label className="block"><span className="caps mb-2 block text-small font-semibold">Toolkit</span>
        <span className="-mt-1 mb-2 block text-small text-muted-foreground">The name a template gives these tools (mcp:{shownToolkit || "<toolkit>"}/&lt;tool&gt;): applying one uses this server for them.</span>
        <Input name="mcp-toolkit" value={shownSource === "github" ? "github" : toolkit} readOnly={shownSource === "github"} onChange={(e) => setToolkit(e.target.value)} placeholder="hubspot" spellCheck={false} /></label>
      <fieldset>
        <legend className="caps mb-2 text-small font-semibold">Credential</legend>
        <div className="flex flex-wrap gap-4">
          {AUTH.map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 text-body">
              <input type="radio" name="mcp-auth" value={id} checked={type === id} disabled={!writable && id !== "none"} onChange={() => { setType(id); if (id === "github_app" && !url.trim()) setUrl(GITHUB_MCP_URL); edited(); }} className="accent-primary" />{label}
            </label>
          ))}
        </div>
      </fieldset>
      {type === "bearer" && <label className="block"><span className="caps mb-2 block text-small font-semibold">Token</span>{keepNote("A new token replaces it; leave this empty to keep it.")}<Input name="mcp-token" {...secret} /></label>}
      {type === "github_app" && (
        <p className="text-small text-muted-foreground">Uses this server's GitHub App (Settings → GitHub): a token for the repository of each run is made when the run starts, and an agent never sees it. The address is GitHub's hosted MCP, the only one this credential goes to. Headers are optional.</p>
      )}
      {(type === "headers" || type === "github_app") && (
        <div className="space-y-2">
          {keepNote(`Its headers: ${saved?.auth.headers?.join(", ")}. New ones replace them all; leave the values empty to keep them.`)}
          {Array.from({ length: headerRows }, (_, i) => (
            <div key={i} className="flex gap-2">
              <Input name={`mcp-header-name-${i}`} aria-label={`Header ${i + 1} name`} placeholder="X-Api-Key" defaultValue={saved?.auth.headers?.[i]} spellCheck={false} />
              <Input name={`mcp-header-value-${i}`} aria-label={`Header ${i + 1} value`} {...secret} />
            </div>
          ))}
          {headerRows < MAX_HEADERS && <Button type="button" size="sm" variant="ghost" onClick={() => setHeaderRows((n) => n + 1)}>Add header</Button>}
        </div>
      )}
      {type === "oauth" && (
        <div className="space-y-3">
          <p className="text-small text-muted-foreground">This server signs in for you and keeps the tokens; an agent never sees one. Sign in opens the server's own page to approve it, and its tools are saved once you do.</p>
          {saved?.oauth?.client_id && <p className="text-small text-muted-foreground">Signing in again uses the client it signed in with ({saved.oauth.client_id}); a client ID here replaces it.</p>}
          <label className="block"><span className="caps mb-2 block text-small font-semibold">Scopes (optional)</span><Input name="mcp-scopes" placeholder="read write" defaultValue={saved?.oauth?.scopes.join(" ")} spellCheck={false} /></label>
          <div className="flex gap-2">
            <label className="block flex-1"><span className="caps mb-2 block text-small font-semibold">{needsClient ? "Client ID (this server needs one)" : "Client ID (optional)"}</span><Input name="mcp-client-id" spellCheck={false} /></label>
            {writable && <label className="block flex-1"><span className="caps mb-2 block text-small font-semibold">{needsClient ? "Client secret (if its app has one)" : "Client secret (optional)"}</span><Input name="mcp-client-secret" {...secret} /></label>}
          </div>
        </div>
      )}
      {problem && (
        <div className="space-y-2">
          <Said problem={problem} />
          {/* With OAuth chosen the form's own Sign in is there: one button, not two. */}
          {problem.signIn && type !== "oauth" && writable && <Button type="button" size="sm" variant="primary" disabled={busy || !addable || !name.trim()} onClick={() => void startSignIn()}>Sign in</Button>}
        </div>
      )}
      {preview && (
        <section aria-label="Preview" className="border bg-background p-3">
          <p className="font-mono text-small text-muted-foreground">MCP {preview.protocol}{preview.server_info?.name ? ` · ${preview.server_info.name}${preview.server_info.version ? ` ${preview.server_info.version}` : ""}` : ""} · {preview.tools.length} tool{preview.tools.length === 1 ? "" : "s"}</p>
          {preview.instructions && <p className="mt-2 whitespace-pre-wrap text-small">{preview.instructions}</p>}
          <p className="mt-2 text-small text-muted-foreground">{PREVIEW_SCOPE_NOTE}</p>
          <ul aria-label="Tools it lists" className="mt-2 divide-y border">
            {preview.tools.map((t) => (
              <li key={t.name} className="px-3 py-2"><span className="font-mono text-body">{t.name}</span>{t.title && <span className="ml-2 text-small">{t.title}</span>}
                {t.description && <span className="mt-0.5 block text-small text-muted-foreground">{t.description}</span>}</li>
            ))}
          </ul>
        </section>
      )}
      <div className="flex flex-wrap gap-2">
        {type === "oauth" && !writable ? null
          : type === "oauth" && needsSignIn
          ? <Button type="submit" size="sm" variant="primary" disabled={busy || !url.trim()}>Sign in again with these settings</Button>
          : type === "oauth"
          ? <Button type="button" size="sm" variant={saved ? "outline" : "primary"} disabled={busy || !addable || !name.trim() || !url.trim()} onClick={() => void startSignIn()}>{saved ? "Sign in again" : "Sign in"}</Button>
          : <Button type="button" size="sm" disabled={busy || !url.trim()} onClick={runPreview}>Preview</Button>}
        {(type !== "oauth" || (saved && !needsSignIn)) && <Button type="submit" size="sm" variant={problem?.signIn && type !== "oauth" && writable ? "outline" : "primary"} disabled={!canSave}>{busy ? "Working" : "Save"}</Button>}
        <Button type="button" size="sm" onClick={() => { form.current?.reset(); onCancel(); }}>Cancel</Button>
      </div>
    </form>
  );
}
