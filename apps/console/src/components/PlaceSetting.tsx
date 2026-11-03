import { type ReactNode, useState } from "react";
import { type ToolOffer } from "@/lib/agentForm";
import { type Place, type Places, placeOf } from "@/lib/place";
import { cn } from "@/lib/utils";

/** Where the agent's runs execute, in the editor's Settings step: on the server (the runner: no box, no shell) or in a
 *  sandbox box, picked from the boxes this server lists, each one it lacks greyed with the server's own reason. Picking
 *  the runner takes away a sandbox-only tool (bash) the form ticked, which the server refuses on the runner (a 422 at the
 *  tool), and says so under the picker. `saved`: the agent's place as saved; `warning`: what the save's answer said about
 *  it (a box this server lacks). */
export function PlaceSetting({ value, saved, places, tools, picked, onChange, error, warning }: {
  value: Place | undefined; saved: unknown; places: Places; tools: ToolOffer[]; picked: string[];
  onChange: (patch: { place: Place; tools?: string[] }) => void; error?: string; warning?: string;
}) {
  const place = value ?? placeOf(saved);
  const mode = place?.mode ?? places.default;
  // A box this server can run; an agent saved in one it lacks keeps it. With none at all, Sandbox can't be picked: the
  // server stays the place, and each box says why it isn't set up.
  const runnable = places.boxes.find((b) => b.available)?.id;
  const box = place?.mode === "sandbox" ? place.box : runnable;
  const noBox = !runnable && mode !== "sandbox";
  const sandboxOnly = new Set(tools.filter((t) => t.sandbox_only).map((t) => t.name));
  // The sandbox-only tools the last move to the runner took away, said under the picker until Sandbox is picked again.
  const [dropped, setDropped] = useState<string[]>([]);
  const toRunner = () => {
    const off = picked.filter((t) => sandboxOnly.has(t));
    setDropped(off);
    onChange({ place: { mode: "runner" }, ...(off.length ? { tools: picked.filter((t) => !sandboxOnly.has(t)) } : {}) });
  };
  const toSandbox = (id: string | undefined) => { setDropped([]); if (id) onChange({ place: { mode: "sandbox", box: id } }); };
  const named = (names: string[]) => names.map((n) => n.charAt(0).toUpperCase() + n.slice(1)).join(" and ");
  const option = (id: "runner" | "sandbox", label: string, note: ReactNode, onPick: () => void, disabled = false) => (
    <label className={cn("flex items-start gap-3 border px-4 py-3", mode === id ? "border-foreground" : "border-border", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <input type="radio" name="place" value={id} checked={mode === id} disabled={disabled} onChange={onPick} className="mt-1 accent-[hsl(var(--primary))]" />
      <span><span className="block text-[14px] font-semibold">{label}</span><span className="mt-0.5 block text-[12px] text-muted-foreground">{note}</span></span>
    </label>
  );
  return (
    <div>
      <div className="mb-2 caps text-[12px] font-semibold">Where it runs</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Where it runs">
        {option("runner", "On the server", "No box and no shell: its files stay in the run's folder on the server.", toRunner)}
        {option("sandbox", "In a sandbox", "Its file and shell tools run in a box; its keys stay on the server.", () => toSandbox(box), noBox)}
      </div>
      {noBox && (
        <div className="mt-3 border px-4 py-3 text-[12px] text-muted-foreground" role="status">
          <p>No box is set up on this server, so this agent runs on the server.</p>
          <ul className="mt-1">{places.boxes.map((b) => <li key={b.id}><span className="font-mono">{b.id}</span>{b.reason ? `: ${b.reason}` : ""}</li>)}</ul>
        </div>
      )}
      {mode === "sandbox" && (
        <ul className="mt-3 border" aria-label="Box">
          {places.boxes.map((b) => (
            <li key={b.id} className="border-b last:border-b-0">
              <label className={cn("flex items-start gap-3 px-4 py-2.5", b.available ? "cursor-pointer" : "cursor-not-allowed text-muted-foreground")}>
                <input type="radio" name="box" value={b.id} checked={box === b.id} disabled={!b.available && box !== b.id} onChange={() => toSandbox(b.id)} className="mt-1 accent-[hsl(var(--primary))]" />
                <span className="min-w-0"><span className="block font-mono text-[13px]">{b.id}</span>{!b.available && b.reason && <span className="mt-0.5 block text-[12px]">{b.reason}</span>}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {mode === "runner" && dropped.length > 0 && (
        <p className="mt-2 text-[12px] text-muted-foreground" role="status">{named(dropped)} {dropped.length === 1 ? "runs" : "run"} only in a sandbox, so {dropped.length === 1 ? "it's" : "they're"} turned off for this agent.</p>
      )}
      {error && <p className="mt-2 font-mono text-[12px] text-destructive-text" role="alert">{error}</p>}
      {warning && <p className="mt-2 font-mono text-[12px] text-warning-text">{warning}</p>}
    </div>
  );
}
