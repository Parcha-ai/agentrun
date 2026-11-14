import { useEffect, useState } from "react";
import { type Client, ClientError, problemOf } from "./client";

/** Native telemetry reports sessions, not a stable application-agent definition or task completion. */
export type ObservedUsage = { input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; total_tokens: number | null; cache_hit_rate: number | null; status?: "reported" | "unavailable" };
export type ObservedSession = {
  id: string; connector_id: string; source_id: string; external_session_id: string;
  harness: string; activity: string; reported_activity: string; connection_state: string; selection_active: boolean;
  occurred_at: string; received_at: string; created_at: string; updated_at: string; sequence: number;
  display_name: string; models: string[]; usage: ObservedUsage; observation_only: true;
};
export type Observations = {
  connectors: { id?: string; connector_id?: string; storage_full?: boolean; [key: string]: unknown }[]; sessions: ObservedSession[];
  usage: Omit<ObservedUsage, "status"> & { models: ({ model: string } & ObservedUsage)[]; daily: { date: string; total_tokens: number | null }[]; status: "partial" | "unavailable"; overflow?: boolean };
};
export const observationHash = (id: string) => `#/observations/${encodeURIComponent(id)}`;
export const observedHarness = (value: string) => value === "claude" ? "Claude Code" : value === "codex" ? "Codex" : value;
export function observedState(session: ObservedSession): string {
  if (session.connection_state === "revoked") return "Revoked";
  if (session.connection_state === "disconnected") return "Disconnected";
  if (!session.selection_active) return "Not selected";
  if (session.connection_state !== "online") return "Disconnected";
  return ({ working: "Running", running: "Running", waiting: "Needs input", waiting_input: "Needs input", idle: "Idle", stopped: "Stopped", finished: "Session ended", failed: "Failed", unknown: "Unknown" } as Record<string, string>)[session.activity] ?? session.activity;
}
export const observedTone = (session: ObservedSession): "success" | "warning" | "muted" => {
  const state = observedState(session);
  return state === "Running" ? "success" : ["Needs input", "Disconnected", "Failed"].includes(state) ? "warning" : "muted";
};
export const observedNumber = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString("en-US");

/** Optional on older servers. Real read errors remain visible, and late/overlapping reads cannot replace a newer scope. */
export function useObservations(v2: Client, { active = true, days = 30, sessionId }: { active?: boolean; days?: 7 | 30; sessionId?: string } = {}) {
  const [data, setData] = useState<Observations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  // A new scope must not display the old scope's sessions. Retrying the same read,
  // however, keeps the last answer visible while the connection is unavailable.
  useEffect(() => { setData(null); setError(null); }, [v2, active, days, sessionId]);
  useEffect(() => {
    let live = true;
    if (!active || typeof v2.observations !== "function") { setLoading(false); return; }
    let pending: AbortController | null = null;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (!live || pending) return;
      clearTimeout(poll);
      const control = (pending = new AbortController());
      const current = () => live && pending === control;
      setLoading(true);
      const finish = () => {
        clearTimeout(limit);
        if (!current()) return;
        pending = null; deadline = undefined; setLoading(false);
        // Schedule after settlement, including timeout: retries never overlap and the owner can retry between reads.
        clearTimeout(poll); poll = setTimeout(refresh, 15_000);
      };
      const limit = (deadline = setTimeout(() => {
        if (!current()) return;
        setError("The observation read timed out. Try refreshing again.");
        control.abort();
        // Release the view even if a custom transport never settles its aborted promise. Late answers stay obsolete.
        finish();
      }, 30_000));
      try {
        const answer = await v2.observations({ days, sessionId }, control.signal);
        if (current()) { setData(answer); setError(null); }
      } catch (cause) {
        if (current()) setError(cause instanceof ClientError && cause.status === 404 ? null : problemOf(cause));
      } finally { finish(); }
    };
    const refresh = () => {
      if (!live || pending) return;
      if (document.hidden) { clearTimeout(poll); poll = setTimeout(refresh, 15_000); }
      else void read();
    };
    void read();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      live = false; clearTimeout(poll); clearTimeout(deadline); pending?.abort(); pending = null;
      window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh);
    };
  }, [v2, active, days, sessionId, retry]);
  return { data, error, loading, refresh: () => setRetry((n) => n + 1) };
}
export type ObservationRead = ReturnType<typeof useObservations>;
