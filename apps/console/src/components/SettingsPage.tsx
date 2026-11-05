import { KeysPage } from "./KeysPage";
import type { AgentRunSession } from "../AgentRunProvider";
import type { Capabilities, Client } from "@/lib/client";

export type SettingsPageProps = {
  client: Client;
  capabilities: Capabilities | null;
  session: AgentRunSession;
  serverLabel?: string;
  onCapabilitiesChange: () => void;
};

/** Connection and configuration reported by this server. Only explicitly supported key routes offer write controls. */
export function SettingsPage({ client, capabilities, session, serverLabel, onCapabilitiesChange }: SettingsPageProps) {
  const features = capabilities?.features;
  const cap = capabilities as (Capabilities & {
    contract?: string;
    server?: { name: string; version: string; platform?: string };
    models?: { source?: string; default?: string; fast?: string; strong?: string };
  }) | null;
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
        <header><p className="caps text-[11px] text-muted-foreground">Settings</p><h1 className="mt-1 text-2xl font-semibold">Server connection</h1></header>
        <section className="space-y-4 rounded-xl border bg-card p-5" aria-label="Server connection">
          <dl className="grid gap-4 text-[14px] sm:grid-cols-2">
            <Setting name="Server" value={serverLabel ?? "Same-origin AgentRun Server"} />
            <Setting name="Session" value={`${session.label ?? session.id} · ${session.authenticated ? "signed in" : "signed out"}`} />
            <Setting name="Authentication" value={session.kind === "enterprise" ? "Provided by the host application" : "Local owner session"} />
            <Setting name="Contract" value={cap?.contract ?? "Not reported"} />
            <Setting name="Version" value={cap?.server ? `${cap.server.name} ${cap.server.version}` : "Not reported"} />
            <Setting name="Platform" value={cap?.server?.platform ?? "Not reported"} />
          </dl>
          <p className="text-[13px] text-muted-foreground">Credentials stay with the server or your sign-in session. This page shows configuration, never credential values.</p>
        </section>
        <section className="space-y-4 rounded-xl border bg-card p-5" aria-label="Server capabilities">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Capabilities</h2><button type="button" onClick={onCapabilitiesChange} className="caps border px-3 py-2 text-[12px] hover:bg-accent">Refresh capabilities</button></div>
          {capabilities ? <>
            <ul className="space-y-2 text-[14px]">{capabilities.harnesses.map((h) => <li key={h.id}><code>{h.id}</code>: {h.available ? "available" : h.reason ?? "unavailable"}</li>)}</ul>
            <dl className="grid gap-4 text-[14px] sm:grid-cols-2">
              <Setting name="Model source" value={cap?.models?.source ?? "Not reported"} />
              <Setting name="Default model" value={cap?.models?.default ?? "Selected by the server"} />
            </dl>
            <p className="font-mono text-[12px]">{Object.entries(features?.messages ?? {}).map(([name, enabled]) => `${name === "steer" ? "Steer" : name.replaceAll("_", " ")}: ${enabled ? "available" : "unavailable"}`).join(" · ")}</p>
          </> : <p role="status" className="text-[14px] text-muted-foreground">Capabilities are unavailable. Refresh to check the connection.</p>}
        </section>
      </div>
      {features?.tool_keys?.routes && <KeysPage v2={client} atRest={features.tool_keys.at_rest} onChange={onCapabilitiesChange} />}
    </div>
  );
}

function Setting({ name, value }: { name: string; value: string }) {
  return <div className="min-w-0"><dt className="caps mb-1 text-[11px] text-muted-foreground">{name}</dt><dd className="break-words">{value}</dd></div>;
}
