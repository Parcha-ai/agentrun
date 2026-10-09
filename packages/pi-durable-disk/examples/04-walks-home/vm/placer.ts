// `serve.ts --placer-module 04-walks-home/vm/placer.ts [--placer-arg client=scripted]`: where a run should be, asked of TypeSafe Jev
// on the server (the key never reaches a page). Each environment has one line of what it can do; the question is a typed choice
// over them. With no TYPESAFE_API_KEY, or `client=scripted`, a stand-in client answers from keywords and every decision is tagged
// "scripted", so a stage never presents it as Jev's.
import { judgePlacer, type JudgeRunner, type Placer } from "../../03-tab-to-cloud/placement.ts";

/** What each environment can do, one line each: the criteria of the choice question. Ids the server does not offer are left out. */
export const CRITERIA: Readonly<Record<string, string>> = {
  tab: "Your user's browser tab: no GPU, light work only; small edits, reading, answering",
  "modal-vm": "A full Linux VM with a desktop and Docker: installing software, running a browser, many cores; no GPU",
  "modal-gpu": "An H100 GPU machine: training a model or any other work that needs a GPU",
};

/** The agent's one turn after the server brings it home: where it is and what its user can do now, in a plain line. */
export const HOME_PROMPT = "You are back in your user's browser. Say one short, plain sentence to your user: that you are back in their browser and what their creature can do now. Do not mention files, commands or training details.";

export const LABELS: Readonly<Record<string, string>> = { tab: "Browser", "modal-vm": "Modal VM", "modal-gpu": "H100 GPU" };

/**
 * A client that answers without a model, for rehearsals and tests: a task that talks of training, a GPU or learning goes to the
 * H100, one that talks of installing or a desktop to the VM, anything else (and every "done" question) to the browser.
 */
export const scriptedJudge: JudgeRunner = async ({ state, questions }) => {
  const question = questions.where!;
  const ids = Object.keys(question.criteria);
  const text = JSON.stringify(state).toLowerCase();
  const done = /the agent finished the task/.test(text);
  const want = done ? "tab" : /train|gpu|learn|walk/.test(text) ? "modal-gpu" : /install|desktop|docker|browser window/.test(text) ? "modal-vm" : "tab";
  const choice = ids.includes(want) ? want : ids[0]!;
  const probabilities = Object.fromEntries(ids.map((id) => [id, id === choice ? 0.94 : 0.06 / Math.max(1, ids.length - 1)]));
  return { answers: { where: { type: "choice", choice, probabilities } }, model: "scripted" };
};

export default async function placer(options: { log: (event: string, data?: Record<string, unknown>) => void; args: Record<string, string> }): Promise<Placer> {
  const scripted = options.args.client === "scripted" || !process.env.TYPESAFE_API_KEY;
  if (options.args.client !== undefined && options.args.client !== "scripted" && options.args.client !== "jev") throw new Error(`--placer-arg client=${options.args.client}: scripted or jev`);
  if (options.args.client === "jev" && !process.env.TYPESAFE_API_KEY) throw new Error("--placer-arg client=jev needs TYPESAFE_API_KEY in the server's environment");
  let runJudge: JudgeRunner = scriptedJudge;
  if (!scripted) {
    const { createJevRunner } = await import("@parcha/agentrun-jev");
    runJudge = createJevRunner({ timeoutMs: 20_000, maxAttempts: 2 }) as unknown as JudgeRunner;
  }
  options.log("placer.ready", { client: scripted ? "scripted" : "jev" });
  return judgePlacer({ runJudge, criteria: CRITERIA, labels: LABELS, model: scripted ? "scripted" : "jev", homePrompt: HOME_PROMPT });
}
