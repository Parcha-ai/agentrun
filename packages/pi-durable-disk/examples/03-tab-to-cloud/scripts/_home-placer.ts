// A placer for the home-turn check: a message that names "the second process" runs there, and the agent comes home when that turn ends. The server's own home turn follows (homePrompt).
import { PLACEMENT_QUESTIONS, type Placer, type PlacementDecision } from "../placement.ts";

export default function homePlacer(): Placer {
  let n = 0;
  return {
    homePrompt: "Say one short sentence: you are home.",
    describe: (env) => `the check's ${env}`,
    async decide(query) {
      const choice = query.phase === "start" ? (/second process/i.test(query.message) ? "remote-local" : "tab") : "tab";
      const decision: PlacementDecision = {
        id: `d-${++n}`,
        phase: query.phase,
        question: PLACEMENT_QUESTIONS[query.phase],
        options: query.environments.map((id) => ({ id, label: id, probability: id === choice ? 0.9 : 0.1 / Math.max(1, query.environments.length - 1) })),
        choice,
        latency_ms: 5,
        model: "scripted",
      };
      return decision;
    },
  };
}
