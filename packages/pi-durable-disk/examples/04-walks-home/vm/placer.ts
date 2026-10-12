// `serve.ts --placer-module 04-walks-home/vm/placer.ts [--placer-arg client=scripted]`: where a run should be, asked of TypeSafe Jev
// on the server (the key never reaches a page). Each environment has one line of what it can do; the question is a typed choice
// over them. With no TYPESAFE_API_KEY, or `client=scripted`, a stand-in client answers from keywords and every decision is tagged
// "scripted", so a stage never presents it as Jev's.
import { judgePlacer, type JudgeRunner, type Placer } from "../../03-tab-to-cloud/placement.ts";
import { Policy } from "../tab/src/policy.ts";

/** What each environment can do, one line each: the criteria of the choice question. Ids the server does not offer are left out. */
export const CRITERIA: Readonly<Record<string, string>> = {
  tab: "Your user's browser tab: no GPU, light work only; small edits, reading, answering",
  "modal-vm": "A full Linux VM with a desktop and Docker: installing software, running a browser, many cores; no GPU",
  "modal-gpu": "An H100 GPU machine: training a model or any other work that needs a GPU",
};

/** The agent's one turn after the server brings it home: where it is and what its user can do now, in a plain line. */
export const HOME_PROMPT = "You are back in your user's browser. Say one short, plain sentence to your user: that you are back in their browser, and how it went for their creature, saying no more than the server's check below says: if it says the trained brain is in place you may say the creature learned to walk and to get back up; if it says NO, say plainly that the final step did not work and why in simple words. Do not mention files, commands or training details.";

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
  // The environments are told apart by what their criterion says they can do (a stand-in host may carry another id).
  const byCriterion = (re: RegExp) => ids.find((id) => re.test(question.criteria[id] ?? ""));
  const want = done ? byCriterion(/browser tab/i) : /train|gpu|learn|walk|obsess|clamp|model|feature/.test(text) ? byCriterion(/H100/) : /install|desktop|docker|browser window/.test(text) ? byCriterion(/Linux VM/) : byCriterion(/browser tab/i);
  const choice = want ?? ids[0]!;
  const probabilities = Object.fromEntries(ids.map((id) => [id, id === choice ? 0.94 : 0.06 / Math.max(1, ids.length - 1)]));
  return { answers: { where: { type: "choice", choice, probabilities } }, model: "scripted" };
};

/**
 * The robot episode's stand-in client: a request to teach or relearn skills goes to the Modal VM (the session runs there while its threads
 * train on the cluster), anything else, and every "done" question, stays in the browser. The cluster boxes are not environments of the
 * switcher: the session on the VM lends them to its threads.
 */
export const scriptedRobotJudge: JudgeRunner = async ({ state, questions }) => {
  const question = questions.where!;
  const ids = Object.keys(question.criteria);
  const text = JSON.stringify(state).toLowerCase();
  const done = /the agent finished the task/.test(text);
  const byCriterion = (re: RegExp) => ids.find((id) => re.test(question.criteria[id] ?? ""));
  const cluster = /teach|learn|relearn|train|skill|new body/.test(text);
  const want = !done && cluster ? byCriterion(/Linux VM/) : byCriterion(/browser tab/i);
  const choice = want ?? ids[0]!;
  const probabilities = Object.fromEntries(ids.map((id) => [id, id === choice ? 0.94 : 0.06 / Math.max(1, ids.length - 1)]));
  return { answers: { where: { type: "choice", choice, probabilities } }, model: "scripted" };
};

/**
 * Robot episode: are the skills home? Checked in code on the run's disk: `home/skills.json` (the assembled index, written last) names the
 * skills and each one has its `home/skills/<name>.json`. `expected` is how many the teach step was for (0: any, at least one).
 */
export async function checkHomeSkills(read: (path: string) => Promise<Uint8Array | undefined>, expected = 0): Promise<{ ok: boolean; reason: string }> {
  const bytes = await read("home/skills.json");
  if (!bytes || bytes.length === 0) return { ok: false, reason: "no skills came home (home/skills.json was not written)" };
  let index: unknown;
  try {
    index = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, reason: "the skills index is not valid JSON" };
  }
  const listed = (index as { skills?: unknown } | null)?.skills ?? index;
  const names = Array.isArray(listed) ? listed.map((s) => (typeof s === "string" ? s : String((s as { name?: unknown; id?: unknown })?.name ?? (s as { id?: unknown })?.id ?? ""))).filter(Boolean) : listed && typeof listed === "object" ? Object.keys(listed) : [];
  if (names.length === 0) return { ok: false, reason: "the skills index lists no skill" };
  const missing: string[] = [];
  for (const name of names) if (!(await read(`home/skills/${name}.json`))?.length) missing.push(name);
  if (missing.length > 0) return { ok: false, reason: `skills listed but not written: ${missing.join(", ")}` };
  if (expected > 0 && names.length < expected) return { ok: false, reason: `${names.length} of the ${expected} skills came home` };
  return { ok: true, reason: `${names.length} skills are home and installed: ${names.join(", ")}.` };
}

/** The agent's one home line for the robot episode: bounded by the server's check below it. */
export const HOME_PROMPT_ROBOT = "You are back in your user's browser. Say one short, plain sentence to your user: that you are back in their browser, and how it went for their robot's skills, saying no more than the server's check below says: if it says the skills are home and installed you may say the robot has learned them and name how many; if it says NO, say plainly that the last step did not work and which skills are missing, in simple words. Do not mention files, commands or training details.";

/**
 * Is the work's result in place? The rules the tab's own loader decides on: its `Policy.load` (the very function the browser runs, imported
 * here, so the two cannot drift) over the policy file, for the body the user drew (creature/body.json: the sha it names and its joints). A file
 * that is not JSON, not mlp-v1, of an unknown spec version, without its observation block or layers, or shaped for another body is refused here
 * as the browser would refuse it. Checked in code on the run's disk, so the agent's closing words come from this and never from its own judgment.
 */
export async function checkHomePolicy(read: (path: string) => Promise<Uint8Array | undefined>): Promise<{ ok: boolean; reason: string }> {
  const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);
  const policyText = text(await read("home/policy.json"));
  if (policyText === undefined || policyText.length === 0) return { ok: false, reason: "the trained brain (home/policy.json) was not written" };
  let policy: Record<string, unknown>;
  try {
    policy = JSON.parse(policyText) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "the trained brain file is not valid JSON" };
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return { ok: false, reason: "the trained brain file is not a policy object" };
  if (policy.format !== "mlp-v1") return { ok: false, reason: `the trained brain has an unknown format ${JSON.stringify(policy.format)}` };
  if (typeof policy.spec_version !== "number") return { ok: false, reason: "the trained brain has no spec version" };
  if (typeof policy.mjcf_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(policy.mjcf_sha256)) return { ok: false, reason: "the trained brain does not name its body" };
  const bodyText = text(await read("creature/body.json"));
  let body: Record<string, unknown> | undefined;
  try {
    body = bodyText === undefined ? undefined : (JSON.parse(bodyText) as Record<string, unknown>);
  } catch {
    body = undefined;
  }
  if (!body || typeof body.mjcf_sha256 !== "string") return { ok: false, reason: "the drawn creature's body file is missing, so the brain cannot be matched to it" };
  if (body.mjcf_sha256 !== policy.mjcf_sha256) return { ok: false, reason: "the trained brain was made for a different body than the one drawn" };
  const joints = Array.isArray(body.jointNames) ? body.jointNames.length : 0;
  if (joints === 0) return { ok: false, reason: "the drawn creature's body file does not list its joints, so the brain cannot be checked against it" };
  try {
    await Policy.load(policyText, { mjcfSha256: body.mjcf_sha256, nj: joints });
  } catch (error) {
    return { ok: false, reason: `the browser would refuse the trained brain: ${(error as Error).message}` };
  }
  return { ok: true, reason: "the trained brain is in place: it is a valid file made for the creature that was drawn." };
}

/**
 * Episode 2 (the model comes home): is the trained model in the tab? Checked in code on the run's disk: the manifest the agent's work
 * wrote (home/model/manifest.json, written last: the whole file's sha256 and its chunks) and the receipt the tab writes after it loaded that file and
 * answered once, its first answer having passed the judge (creature/model-loaded.json: { sha256, answered: true }). The tab loads and answers only after the run is home, so the check waits for the receipt
 * (up to `waitMs`) before it says no.
 */
export async function checkHomeModel(
  read: (path: string) => Promise<Uint8Array | undefined>,
  options: { waitMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ ok: boolean; reason: string }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const json = async (path: string): Promise<Record<string, unknown> | undefined> => {
    const bytes = await read(path);
    if (!bytes || bytes.length === 0) return undefined;
    try {
      const v = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const manifest = await json("home/model/manifest.json");
  if (!manifest) {
    // No model: say why in the programs' own plain words when they stopped on purpose (a refused topic, the real-person gate).
    const last = async (path: string) => {
      const bytes = await read(path);
      const lines = bytes ? new TextDecoder().decode(bytes).trim().split("\n") : [];
      try {
        return JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>;
      } catch {
        return undefined;
      }
    };
    const stop = (await last("train/progress.jsonl")) ?? (await last("find/progress.jsonl"));
    // A refusal is the program's typed policy call: the server says so in one fixed sentence, never in the judge's own words (they can echo personal details).
    if (stop?.event === "refused") return { ok: false, reason: "the topic was refused by the program's own policy check, so no model was made." };
    const why = stop?.event === "error" ? String(stop.message ?? "").slice(0, 300) : "";
    return { ok: false, reason: why ? `no model was made: ${why}` : "the trained model was not written (no model manifest)" };
  }
  if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.sha256)) return { ok: false, reason: "the model manifest does not name the file by its sha256" };
  const deadline = now() + (options.waitMs ?? 120_000);
  for (;;) {
    const loaded = await json("creature/model-loaded.json");
    if (loaded) {
      if (typeof loaded.error === "string") return { ok: false, reason: `the browser could not load the model: ${loaded.error}` };
      if (loaded.answered !== true && loaded.sha256 === manifest.sha256 && now() < deadline) {
        await sleep(options.pollMs ?? 1000); // loaded, its first answer still coming
        continue;
      }
      if (loaded.sha256 !== manifest.sha256) return { ok: false, reason: "the tab loaded a different model file than the one that was trained" };
      if (loaded.answered !== true) return { ok: false, reason: "the tab loaded the model but did not answer" };
      return { ok: true, reason: "the trained model is in the browser and has answered once." };
    }
    if (now() >= deadline) return { ok: false, reason: "the browser did not report loading the model" };
    await sleep(options.pollMs ?? 1000);
  }
}

/** The agent's one home line for the model episode: what it says is bounded by the server's check below it. */
export const HOME_PROMPT_MODEL = "You are back in your user's browser. Say one short, plain sentence to your user: that you are back in their browser, and how it went for the model you trained, saying no more than the server's check below says: if it says the trained model is in the browser and has answered you may say it is ready to talk; if it says NO, say plainly that the last step did not work and why in simple words; if it says the topic was refused, say in one plain sentence that the topic was refused and no model was made, and never repeat or guess at the reason. Do not mention files, commands or training details.";

/** Where the obsession episode's request lands on the run's disk: the user's own words, as bytes, for the programs' `--topic-file`. */
export const REQUEST_FILE = "obsession/request.txt";

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
  // `gpu=ID` lets a stand-in host (a second process on this machine, in a dry run) take the H100's place under its own id.
  const criteria: Record<string, string> = { ...CRITERIA, ...(options.args.gpu ? { [options.args.gpu]: CRITERIA["modal-gpu"]! } : {}) };
  const episode = options.args.episode ?? "walks";
  if (episode !== "walks" && episode !== "model" && episode !== "obsession" && episode !== "robot") throw new Error(`--placer-arg episode=${episode}: walks, model, obsession or robot`);
  if (episode === "robot") {
    const expected = Number(options.args.skills ?? 0);
    if (!(expected >= 0) || !Number.isInteger(expected)) throw new Error(`--placer-arg skills=${options.args.skills}: a whole number`);
    return judgePlacer({ runJudge: scripted ? scriptedRobotJudge : runJudge, criteria, labels: LABELS, model: scripted ? "scripted" : "jev", homePrompt: HOME_PROMPT_ROBOT, homeCheck: (read) => checkHomeSkills(read, expected) });
  }
  const model = episode === "model" || episode === "obsession";
  return judgePlacer({ runJudge, criteria, labels: { ...LABELS, ...(options.args.gpu ? { [options.args.gpu]: LABELS["modal-gpu"]! } : {}) }, model: scripted ? "scripted" : "jev", homePrompt: model ? HOME_PROMPT_MODEL : HOME_PROMPT, ...(episode === "obsession" ? { requestFile: REQUEST_FILE } : {}), homeCheck: model ? (read) => checkHomeModel(read, { waitMs: Number(options.args["home-wait-ms"] ?? 120_000) }) : checkHomePolicy });
}
