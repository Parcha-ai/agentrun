import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/agentForm";
import { type Client, ClientError, problemOf } from "@/lib/client";
import { when } from "@/lib/format";
import type { SignIn } from "@/lib/v2";

/** A browser vendor by name; one this console doesn't know is shown as the server names it. */
const VENDOR: Record<string, string> = { browserbase: "Browserbase", kernel: "Kernel" };
const vendor = (provider: string) => VENDOR[provider] ?? provider;
const runLink = (id: string) => <a href={`#/runs/${encodeURIComponent(id)}`} className="font-mono underline underline-offset-2">{id.slice(-8)}</a>;
/** "Browserbase", "Browserbase and Kernel", "A, B and C". */
const names = (list: readonly string[]) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);

/** The agent's saved browser sign-ins (GET /v2/agents/{id}'s `sign_ins`): a row per vendor, by its name, its state and
 *  when it was last verified, and nothing else of it (the server sends no pointer; nothing beyond those fields is read
 *  here either). Forget is per KEY, as the server forgets (serve's sign-ins.ts forget(): every vendor's sign-in under the
 *  key, refused with 409 sign_in_held while a run holds any of them; it keeps them all under `default`): on the row when
 *  one vendor is under the key, once for the group when several are, its confirm naming each. A run holding any of a
 *  key's sign-ins is named on its row, and the key's Forget waits for it to end; one that takes it meanwhile is said from
 *  the 409. Each vendor's result is named: a delete it didn't confirm, with its message. With none saved, a line only for an
 *  agent whose browser is a vendor's (its `tools` entry resolves to one). */
export function SignIns({ agent, v2, onAgent }: { agent: Agent; v2: Pick<Client, "forgetSignIn" | "getAgent">; onAgent: (agent: Agent) => void }) {
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ text: string; run?: string; tone: "warn" | "error" } | null>(null);
  // The server always serves the list (GET /v2/agents/{id}); an agent read without one has none saved.
  const list = agent.sign_ins ?? [];
  const resolved = agent.tools?.find((t) => t.name === "browser")?.resolved;
  if (!list.length && resolved !== "browserbase" && resolved !== "kernel") return null;
  const groups = [...new Set(list.map((s) => s.key))].map((key) => ({ key, items: list.filter((s) => s.key === key) }));

  const forget = async (key: string) => {
    setBusy(true); setSaid(null);
    try {
      const r = await v2.forgetSignIn(agent.agent_id, key);
      const kept = r.removed.filter((x) => x.at_vendor === "not_deleted");
      if (kept.length) setSaid({ tone: "warn", text: kept.map((x) => `Forgotten here, but ${vendor(x.provider)} didn't confirm the delete. ${x.message ?? ""}`.trim()).join(" ") });
      setAsking(null);
      onAgent((await v2.getAgent(agent.agent_id)).agent);
    } catch (e) {
      const held = e instanceof ClientError && e.code === "sign_in_held" ? (e.details?.held_by as string | undefined) : undefined;
      setSaid(e instanceof ClientError && e.code === "sign_in_held"
        ? { tone: "warn", text: "A run is using this sign-in; you can forget it when that run ends.", ...(held ? { run: held } : {}) }
        : { tone: "error", text: `Not forgotten: ${problemOf(e)}` });
      setAsking(null);
    } finally { setBusy(false); }
  };

  const forgetButton = ({ key, items }: { key: string; items: SignIn[] }) => {
    const label = items.length === 1 ? `Forget the ${vendor(items[0].provider)} sign-in` : `Forget the saved sign-ins for ${names(items.map((s) => vendor(s.provider)))}`;
    const held = items.some((s) => s.state === "held");
    return <Button size="sm" variant="ghost" disabled={busy || held} aria-label={label} title={held ? "A run is using it: forget it once that run ends." : undefined}
      onClick={() => { setSaid(null); setAsking(key); }}>Forget</Button>;
  };

  return (
    <section aria-label="Sign-ins" className="mt-4 max-w-3xl">
      <p className="caps mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground"><KeyRound className="size-3.5" aria-hidden /> Sign-ins</p>
      {!list.length ? <p className="font-mono text-[12px] text-muted-foreground">No saved sign-ins. The browser keeps one once a run signs in to a site.</p> : (
        <ul className="border">
          {groups.map((g) => (
            <li key={g.key} className="border-b last:border-b-0">
              {g.items.map((s) => (
                <div key={`${s.key}\u0000${s.provider}`} data-sign-in className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-[13px] font-semibold">{vendor(s.provider)}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{s.verified_at ? `last verified ${when(s.verified_at)}` : "not verified yet"}</span>
                    {s.state === "held" && s.held_by && <span className="font-mono text-[11px] text-muted-foreground">in use by run {runLink(s.held_by)}</span>}
                    {g.items.length === 1 && <><span className="flex-1" />{forgetButton(g)}</>}
                  </div>
                  {s.state === "unreadable" && <p className="mt-1 text-[12px] text-warning-text">This server's seal key can't open it, so runs start signed out until it's forgotten.</p>}
                </div>
              ))}
              {g.items.length > 1 && <div className="flex justify-end border-t px-3 py-1.5">{forgetButton(g)}</div>}
              {asking === g.key && (
                <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 border bg-card px-3 py-2" role="alertdialog" aria-label="Forget the sign-ins?">
                  <p className="min-w-0 flex-1 text-[13px]">
                    {g.items.length === 1 ? `Forget the ${vendor(g.items[0].provider)} sign-in?` : `Forget the saved sign-ins for ${names(g.items.map((s) => vendor(s.provider)))}?`} The agent's next run with the browser starts signed out.
                  </p>
                  <Button size="sm" variant="solid" disabled={busy} autoFocus onClick={() => void forget(g.key)}>Yes, forget</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking(null)}>Keep</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {said && <p className={`mt-2 text-[12px] ${said.tone === "error" ? "text-destructive-text" : "text-warning-text"}`} role="status">{said.text}{said.run && <> Run: {runLink(said.run)}</>}</p>}
    </section>
  );
}
