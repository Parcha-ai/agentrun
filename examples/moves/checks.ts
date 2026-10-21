// The by-code checks of a run's own files, shared by the live runner and the offline test: what `threads.json` and the sandbox ledger must show.
import { existsSync, readFileSync } from "node:fs";
import { THREADS } from "./config.ts";

type Row = { gpu?: string | null; metric?: number | null };
type BoxLine = { ev: string; id?: string; at?: string; spec?: { gpu?: string } };

/** `threads.json` is `{ threads: [...] }`: THREADS rows, each with a metric and a GPU line that `gpu` matches. */
export function threadProblems(file: string, gpu: RegExp): string[] {
  if (!existsSync(file)) return ["threads.json was not brought home"];
  const { threads } = JSON.parse(readFileSync(file, "utf8")) as { threads?: Row[] };
  const ok = Array.isArray(threads) && threads.length === THREADS && threads.every((t) => gpu.test(String(t.gpu ?? "")) && typeof t.metric === "number");
  return ok ? [] : [`threads.json does not show ${THREADS} threads that each report a metric and a GPU line matching ${gpu}`];
}

/** The sandbox ledger: THREADS distinct sandboxes asked for `gpu`, each one ended by the session (a destroy that succeeded). The GPU seconds are from each create to its destroy. */
export function sandboxProblems(file: string, gpu: string): { problems: string[]; gpuSeconds: number | null } {
  if (!existsSync(file)) return { problems: ["the sandbox ledger was not brought home"], gpuSeconds: null };
  const events = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as BoxLine);
  const created = events.filter((e) => e.ev === "create");
  const destroyed = (id: string | undefined) => events.find((e) => e.ev === "destroy" && e.id === id);
  const problems: string[] = [];
  if (new Set(created.map((e) => e.id)).size !== THREADS || !created.every((e) => e.spec?.gpu === gpu)) problems.push(`the sandbox ledger does not show ${THREADS} distinct sandboxes asked for ${gpu}`);
  if (!created.every((e) => destroyed(e.id))) problems.push("a thread sandbox was not destroyed by the session");
  const seconds = created.reduce((sum, e) => { const gone = destroyed(e.id); return gone ? sum + Math.max(0, (Date.parse(String(gone.at)) - Date.parse(String(e.at))) / 1000) : sum; }, 0);
  return { problems, gpuSeconds: Math.round(seconds) };
}
