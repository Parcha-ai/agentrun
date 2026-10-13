// `serve.ts --placer-module 04-walks-home/vm/placer.ts`: where a run should be, asked of TypeSafe Jev on the server (the key never
// reaches a page). Each environment has one line of what it can do; the question is a typed choice over them. Jev is the only judge: there is
// no keyword stand-in, and a server without TYPESAFE_API_KEY does not start (tests inject a fake runner into `buildPlacer`).
import { judgePlacer, type JudgeRunner, type Placer } from "../../03-tab-to-cloud/placement.ts";
import { Policy } from "../tab/src/policy.ts";
import { FLAG_SKILLS, readScene } from "../../03-tab-to-cloud/flag-goal.ts";

/** What each environment can do, one line each: the criteria of the choice question. Ids the server does not offer are left out. */
export const CRITERIA: Readonly<Record<string, string>> = {
  tab: "Your user's browser tab: no GPU, light work only; small edits, reading, answering",
  "modal-vm": "A full Linux VM with a desktop and Docker: installing software, running a browser, many cores; no GPU",
  "modal-gpu": "An H100 GPU machine: training a model or any other work that needs a GPU",
};

/**
 * The robot episode's two environments, one line each. The VM is where the session teaches the robot: its threads train all eight movement skills
 * at once on a cluster of GPU machines the VM lends them (the cluster boxes are not environments of the switcher). Everything else, and every "done" question, is the browser's.
 */
export const CRITERIA_ROBOT: Readonly<Record<string, string>> = {
  tab: "Your user's browser tab: everything that is not teaching, and where the agent goes back to once teaching has finished. Changing how the robot looks or what it is made of (name, colour, face, legs, a different body), talking about it, listing what it can do, telling the robot to do something now (walk to the flag, spin, wave, stop), whether or not it has been taught that skill: the robot tries it in the browser and the page shows how it does, and a skill it has not learned shows it failing at it (one named in skills_already_taught is already learned), answering questions. A line that asks to come back to, go to or stay in the browser belongs here, whatever else it asks. Light work only",
  "modal-vm": "A cloud computer with eight GPU machines, for the time the robot is being taught. Any request that asks for the robot to be taught, to train, to retrain, to relearn or to learn belongs here (walking, spinning, sprinting, ...), whether or not that skill was taught before. That includes learning again after its body changed: 'learn your new body', 'relearn your skills', 'learn to walk again' are teaching, however many skills are already learned. Teaching and learning are what the GPU machines are for. Asking the robot to do a skill, taught or not, is not teaching: it is trying it, in the browser. A line that asks to go to, move to or run on the Modal VM or the cloud belongs here, whatever else it asks: the user chose where it runs. Once the teaching has finished there is nothing left for the agent to do here",
};

/** The agent's one turn after the server brings it home: where it is and what its user can do now, in a plain line. */
export const HOME_PROMPT = "You are back in your user's browser. Say one short, plain sentence to your user: that you are back in their browser, and how it went for their creature, saying no more than the server's check below says: if it says the trained brain is in place you may say the creature learned to walk and to get back up; if it says NO, say plainly that the final step did not work and why in simple words. Do not mention files, commands or training details.";

export const LABELS: Readonly<Record<string, string>> = { tab: "Browser", "modal-vm": "Modal VM", "modal-gpu": "H100 GPU" };

/** The skills the last round trained (the keys of `skills` in work/skills/round.json, the assembler's summary); none when the summary is absent or unreadable. */
async function roundSkills(read: (path: string) => Promise<Uint8Array | undefined>): Promise<string[]> {
  const bytes = await read("home/round.json").catch(() => undefined);
  if (!bytes?.length) return [];
  try {
    const round = JSON.parse(new TextDecoder().decode(bytes)) as { version?: unknown; skills?: unknown };
    if (round.version !== 1 || round.skills === null || typeof round.skills !== "object" || Array.isArray(round.skills)) return [];
    return Object.keys(round.skills).filter((n) => /^[a-z0-9][a-z0-9_-]{0,40}$/.test(n));
  } catch {
    return [];
  }
}

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
  const odd = names.filter((n) => !/^[a-z0-9][a-z0-9_-]{0,40}$/.test(n));
  if (odd.length > 0) return { ok: false, reason: `the skills index has a name that is not a plain skill name: ${odd.map((n) => JSON.stringify(n.slice(0, 40))).join(", ")}` };
  const distinct = [...new Set(names)];
  if (distinct.length !== names.length) return { ok: false, reason: `the skills index names a skill more than once: ${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}` };
  const missing: string[] = [];
  const broken: string[] = [];
  for (const name of distinct) {
    const file = await read(`home/skills/${name}.json`);
    if (!file?.length) {
      missing.push(name);
      continue;
    }
    try {
      const value = JSON.parse(new TextDecoder().decode(file)) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) broken.push(name);
    } catch {
      broken.push(name);
    }
  }
  if (missing.length > 0) return { ok: false, reason: `skills listed but not written: ${missing.join(", ")}` };
  if (broken.length > 0) return { ok: false, reason: `skill files that are not valid JSON objects: ${broken.map((n) => `home/skills/${n}.json`).join(", ")}` };
  // What the round trained, from the assembler's own summary (work/skills/round.json): a request for one skill ("teach it to walk") trains one, and one is what must come home. Without a summary, the count the teach step was for.
  const trained = await roundSkills(read);
  if (trained.length > 0) {
    const absent = trained.filter((n) => !distinct.includes(n));
    if (absent.length > 0) return { ok: false, reason: `${trained.length - absent.length} of the ${trained.length} skills trained this round came home (not home: ${absent.join(", ")})` };
  } else if (expected > 0 && distinct.length < expected) return { ok: false, reason: `${distinct.length} of the ${expected} skills came home` };
  return { ok: true, reason: `${distinct.length} ${distinct.length === 1 ? "skill is" : "skills are"} home and installed: ${distinct.join(", ")}.${await flagTry(read, distinct)}` };
}

/** With a flag on the floor (the page's creature/scene.json) nothing plays by itself: the robot waits at the start for the ask, so the thing to try is the run to the flag. */
async function flagTry(read: (path: string) => Promise<Uint8Array | undefined>, home: readonly string[]): Promise<string> {
  const files = { readTextFile: async (path: string) => { const b = await read(path); return b ? { ok: true as const, value: new TextDecoder().decode(b) } : { ok: false as const, error: { code: "not_found", message: path } }; } };
  const skill = FLAG_SKILLS.find((s) => home.includes(s));
  if (!skill || !(await readScene(files, undefined as never))) return "";
  return ` There is a flag on the floor and the robot waits at the start for the ask, so the line to try is: "Back in your browser. Try: ${skill} to the flag."`;
}

/** The agent's one home line for the robot episode: bounded by the server's check below it. */
export const HOME_PROMPT_ROBOT = "You are back in your user's browser, and you already told them how the teaching went before the move: do not repeat it. Say one short line that adds only what is new: that you are back in their browser, and one thing they can try now. When the server's check below gives the line to try, say that line; otherwise name one skill from the list in the check: \"Back in your browser. Try: make it <that skill>.\" If the check says NO, say instead, plainly and in simple words, that the last step did not work and which skills are missing. Do not mention files, commands or training details.";

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

/** What the robot placement question is asked with: the skills the robot has already been taught (home/skills.json), so "make it spin" after spin was taught is the browser's, and "teach it to spin" is the VM's. */
export async function robotContext(read: (path: string) => Promise<Uint8Array | undefined>): Promise<Record<string, unknown>> {
  const bytes = await read("home/skills.json").catch(() => undefined);
  if (!bytes?.length) return { skills_already_taught: [] };
  try {
    const listed = (JSON.parse(new TextDecoder().decode(bytes)) as { skills?: unknown } | null)?.skills;
    const names = Array.isArray(listed) ? listed.map((s) => (typeof s === "string" ? s : String((s as { name?: unknown })?.name ?? ""))) : listed && typeof listed === "object" ? Object.keys(listed) : [];
    return { skills_already_taught: names.filter((n) => /^[a-z0-9][a-z0-9_-]{0,40}$/.test(n)) };
  } catch {
    return { skills_already_taught: [] };
  }
}

/** The placer over a judge runner: the server's Jev client in the demo, a fake in tests. Decisions are tagged with `model`. */
export function buildPlacer(options: { log: (event: string, data?: Record<string, unknown>) => void; args: Record<string, string> }, runJudge: JudgeRunner, model: "jev" | "scripted" = "jev"): Placer {
  // `gpu=ID` lets a stand-in host (a second process on this machine, in a dry run) take the H100's place under its own id.
  const episode = options.args.episode ?? "walks";
  if (episode !== "walks" && episode !== "model" && episode !== "obsession" && episode !== "robot") throw new Error(`--placer-arg episode=${episode}: walks, model, obsession or robot`);
  if (episode === "robot") {
    const expected = Number(options.args.skills ?? 0);
    if (!(expected >= 0) || !Number.isInteger(expected)) throw new Error(`--placer-arg skills=${options.args.skills}: a whole number`);
    return judgePlacer({ runJudge, criteria: CRITERIA_ROBOT, labels: LABELS, model, context: robotContext, homePrompt: HOME_PROMPT_ROBOT, homeCheck: (read) => checkHomeSkills(read, expected) });
  }
  const criteria: Record<string, string> = { ...CRITERIA, ...(options.args.gpu ? { [options.args.gpu]: CRITERIA["modal-gpu"]! } : {}) };
  const modelEpisode = episode === "model" || episode === "obsession";
  return judgePlacer({ runJudge, criteria, labels: { ...LABELS, ...(options.args.gpu ? { [options.args.gpu]: LABELS["modal-gpu"]! } : {}) }, model, homePrompt: modelEpisode ? HOME_PROMPT_MODEL : HOME_PROMPT, ...(episode === "obsession" ? { requestFile: REQUEST_FILE } : {}), homeCheck: modelEpisode ? (read) => checkHomeModel(read, { waitMs: Number(options.args["home-wait-ms"] ?? 120_000) }) : checkHomePolicy });
}

/** The server's placer: TypeSafe Jev decides every placement. No key, no server: there is no fallback judge. */
export default async function placer(options: { log: (event: string, data?: Record<string, unknown>) => void; args: Record<string, string> }): Promise<Placer> {
  if (options.args.client !== undefined && options.args.client !== "jev") throw new Error(`--placer-arg client=${options.args.client}: only jev decides where a run goes`);
  if (!process.env.TYPESAFE_API_KEY) throw new Error("the placer asks TypeSafe Jev and TYPESAFE_API_KEY is not in the server's environment: start the server under the credential wrapper (with-typesafe); there is no fallback judge");
  const { createJevRunner } = await import("@parcha/agentrun-jev");
  options.log("placer.ready", { client: "jev" });
  return buildPlacer(options, createJevRunner({ timeoutMs: 20_000, maxAttempts: 2 }) as unknown as JudgeRunner, "jev");
}
