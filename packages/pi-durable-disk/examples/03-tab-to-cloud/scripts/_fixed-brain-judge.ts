// The brain router's judge for the browser checks that must not spend: answers from a table of exact messages (FIXED_BRAIN_JUDGE, JSON: message -> "local" | "cloud"), never from reading the words.
// A message the table does not hold fails the check loudly.
import type { JudgeRunner } from "../brain-router.ts";

const table = JSON.parse(process.env.FIXED_BRAIN_JUDGE ?? "{}") as Record<string, "local" | "cloud">;

const judge: JudgeRunner = async (params) => {
  const message = String((params.state as { message?: string }).message ?? "");
  const choice = table[message];
  if (choice !== "local" && choice !== "cloud") throw new Error(`no fixed brain answer for ${JSON.stringify(message)}`);
  return { answers: { who: { type: "choice", choice, probabilities: { local: choice === "local" ? 0.95 : 0.05, cloud: choice === "cloud" ? 0.95 : 0.05 } } }, model: "fixed" };
};
export default judge;
