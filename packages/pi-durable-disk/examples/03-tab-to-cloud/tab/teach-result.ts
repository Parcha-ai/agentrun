// What teach_skills answered, for the reader: one row per thread and what came home. Read from the result's typed details ({teach, threads: ThreadResult[], home?}, cluster/teach-skills.ts), never from the
// model-facing text (which repeats each thread's summary and ends with a hint for the model). Pure: details that are not a teach result give no card, and the page shows the result's own text.

export type ResultRow = { passed: boolean; text: string };
export type ResultCard = { rows: ResultRow[]; home: string | null };

type Bag = Record<string, unknown>;
const bag = (v: unknown): Bag | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Bag) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v: number): string => String(Math.round(v * 100) / 100);
const target = (t: string): string => t.replace(">=", "≥").replace("<=", "≤");

export function teachResultCard(details: unknown): ResultCard | null {
  const d = bag(details);
  if (d === null || !Array.isArray(d.threads)) return null;
  const rows: { gpu: number; row: ResultRow }[] = [];
  for (const raw of d.threads) {
    const t = bag(raw);
    const skill = t ? str(t.skill) : null;
    const status = t ? str(t.status) : null;
    if (t === null || skill === null || status === null) continue;
    const passed = status === "passed";
    const m = bag(t.metric);
    const name = m ? str(m.name) : null;
    const value = m ? num(m.value) : null;
    const unit = m ? str(m.unit) : null;
    const goal = m ? str(m.target) : null;
    const checkpoint = num(t.checkpoint);
    const seconds = num(t.seconds);
    const reason = str(t.reason);
    const parts = [
      skill,
      ...(passed
        ? [name !== null && value !== null ? `${name} ${round(value)}${unit ? ` ${unit}` : ""}${goal ? ` ${target(goal)}` : ""}` : null, checkpoint !== null ? `checkpoint ${checkpoint}` : null, seconds !== null ? `${Math.round(seconds)} s` : null]
        : [status === "never-passed" ? "never passed" : status.replace(/-/g, " "), seconds !== null ? `${Math.round(seconds)} s` : null, reason]),
    ].filter((p): p is string => p !== null);
    rows.push({ gpu: num(t.gpu) ?? 1e9, row: { passed, text: parts.join(" · ") } });
  }
  if (rows.length === 0) return null;
  const home = bag(d.home);
  const skills = home && Array.isArray(home.skills) ? home.skills.filter((s): s is string => typeof s === "string") : null;
  const failed = home ? str(home.error) : null;
  return {
    rows: rows.sort((a, b) => a.gpu - b.gpu).map((r) => r.row),
    home: failed !== null ? `Bringing the skills home failed: ${failed}` : skills !== null ? `Home: ${skills.length > 0 ? skills.join(", ") : "none"}` : null,
  };
}
