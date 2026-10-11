// Live, opt-in: the brain router (brain-router.ts) against TypeSafe Jev on fixed messages (brain-router-cases.json), each asked in both option
// orders, as a tab that is online with its trained 1B. Every labelled message must go where its label says; the borderline ones are
// reported. Prints accuracy at a few gates, latency and token use. Needs TYPESAFE_API_KEY (bin/with-typesafe sets it); Jev bills input
// tokens only, about 350 a decision.
//   node scripts/brain-router-check.ts [--usd-per-million-input 0.042]
import { readFileSync } from "node:fs";
import { createJevRunner } from "@parcha/agentrun-jev";
import { brainRouter, DEFAULT_MIN_LOCAL_CONFIDENCE, gatedBrain, type BrainDecision, type JudgeRunner } from "../brain-router.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const usdPerMillion = Number(arg("--usd-per-million-input", "0.042"));
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is needed (run through bin/with-typesafe)");
const cases = JSON.parse(readFileSync(new URL("./brain-router-cases.json", import.meta.url), "utf8")) as Record<"labelled" | "borderline", { expect: "local" | "cloud"; message: string }[]>;

const runner = createJevRunner({ timeoutMs: 10_000, maxAttempts: 1 }) as unknown as JudgeRunner;
let inputTokens = 0;
const runJudge: JudgeRunner = async (params) => {
  const r = (await runner(params)) as Awaited<ReturnType<JudgeRunner>> & { usage?: { input_tokens: number } | null };
  inputTokens += r.usage?.input_tokens ?? 0;
  return r;
};
const online = { online: true, localModel: { id: "the trained 1B" } };
const want = (e: "local" | "cloud") => (e === "local" ? "tab-local" : "cloud");
// Re-scored at other gates with the router's own rule (Jev's choice, then the gate); a decision Jev did not make stays the cloud.
const brainAt = (d: BrainDecision, gate: number) => (d.decidedBy === "jev" && d.choice ? gatedBrain(d.choice, d.probabilities!.local, gate) : "cloud");

let ok = true;
for (const set of ["labelled", "borderline"] as const) {
  const rows: { expect: "local" | "cloud"; message: string; first: string; d: BrainDecision }[] = [];
  for (const c of cases[set]) {
    for (const first of ["local", "cloud"]) {
      // The 10 s timeout here measures Jev's real latency; the router's default is 1 s.
      const router = brainRouter({ runJudge, timeoutMs: 10_000, random: () => (first === "local" ? 0.1 : 0.9) });
      rows.push({ ...c, first, d: await router.decide(c.message, online) });
    }
  }
  const gates = [0.5, DEFAULT_MIN_LOCAL_CONFIDENCE, 0.9].map((g) => `gate ${g}: ${rows.filter((r) => brainAt(r.d, g) === want(r.expect)).length}/${rows.length}`);
  const ms = rows.map((r) => r.d.ms).sort((a, b) => a - b);
  console.log(`${set}: ${gates.join(", ")}; ms p50 ${ms[Math.floor(ms.length / 2)]} max ${ms.at(-1)}; Jev answered ${rows.filter((r) => r.d.decidedBy === "jev").length}/${rows.length}`);
  for (const r of rows) {
    if (r.d.brain === want(r.expect)) continue;
    console.log(`  ${set === "labelled" ? "WRONG" : "differs"} [${r.expect}, ${r.first} first] p_local ${r.d.probabilities?.local.toFixed(2) ?? "-"} ${r.d.reason}: ${r.message}`);
    if (set === "labelled") ok = false;
  }
}
console.log(`input tokens ${inputTokens}, about $${((inputTokens * usdPerMillion) / 1e6).toFixed(4)} at $${usdPerMillion}/M (output is free)`);
process.exit(ok ? 0 : 1);
