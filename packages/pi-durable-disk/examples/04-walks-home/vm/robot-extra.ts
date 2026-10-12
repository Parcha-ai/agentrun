// The robot cluster on the session's VM, as the cloud app's extra (03-tab-to-cloud/cloud-app.ts loads it from DEMO_APP_EXTRA): `teach_skills` on
// the session (its default tool next to the shared ones), `train_skill` for the forked threads, each thread's tools on its own GPU box through the
// link (the server holds the Modal key; the VM only asks), and each skill's files mirrored home to this run's disk as the trainer writes them.
//   acquire(thread)  asks the server for a box (idempotent per thread, queued when the pool is smaller than the thread count), puts pi-run on it
//                    and copies the session's robot.json there (the body this teach step is for, so a body change is the same call again);
//   env(target)      a conversation with a box in its robot.box doc runs its tools there (D0's RemoteEnv over the link's box); any other, here;
//   artifacts        the box's /workspace/skills/<skill>/ to <work>/skills/<skill>/ (D0's ArtifactSync), the trainer's own state left on the box.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactSync, installPiRun, remoteEnvs, type RemoteBox } from "@parcha/pi-durable-disk";
import type { AppExtra, AppExtraContext } from "../../03-tab-to-cloud/app-extra.ts";
import { RobotBox, teachSkills, type ThreadBoxes, type ThreadResult } from "../cluster/teach-skills.ts";

/** D2's assemble-skills (node alone): the skills the threads trained into the page's format, home/skills.json last. In the box's bundle it sits at robot/policy/. */
export const ASSEMBLE_SCRIPT = fileURLToPath(new URL("../policy/assemble-skills.ts", import.meta.url));

/**
 * Bring the skills home on the session's host: `node assemble-skills.ts <work>/skills --home <work>/home`, the default skill walk when it trained, and
 * without the get-up network when no get-up thread ran (the page then runs the skills without fall recovery). Resolves with the skills that are home;
 * rejects with what the program said when it refused (exit 2) or found none done (exit 3). Rerunnable: the program writes each file by rename.
 */
export async function runAssembleSkills(work: string, options: { script?: string; node?: string; skillsDir?: string } = {}): Promise<readonly string[]> {
  const script = options.script ?? ASSEMBLE_SCRIPT;
  if (!existsSync(script)) throw new Error("assemble-skills is not in this build of the robot extra");
  const dir = options.skillsDir ?? join(work, "skills");
  const args = [script, dir, "--home", join(work, "home")];
  if (existsSync(join(dir, "walk", "skill.json"))) args.push("--default", "walk");
  if (!existsSync(join(dir, "get-up", "skill.json"))) args.push("--without-getup");
  const out = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn(options.node ?? process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, text }));
  });
  const lines = out.text.trim().split("\n").filter(Boolean);
  if (out.code !== 0) throw new Error(`assemble-skills exited ${out.code}: ${lines.slice(-3).join(" | ").slice(0, 400)}`);
  // The round's summary travels home with the skills, so the server's home check (which reads what the browser holds) can say what this round trained.
  const summary = join(dir, "round.json"), copy = join(work, "home", "round.json");
  if (existsSync(summary)) copyFileSync(summary, copy);
  else rmSync(copy, { force: true });
  for (const line of lines.reverse()) {
    try {
      const event = JSON.parse(line) as { event?: string; skills?: unknown };
      if (event.event === "skills.home" && Array.isArray(event.skills)) return event.skills.map(String);
    } catch {
      // not the program's last line
    }
  }
  throw new Error("assemble-skills printed no skills.home line");
}

/**
 * The skills that belong to the body this round taught: the body (its mjcf sha256) of the skills that passed in this round (the commonest one), and every
 * saved skill trained for it, staged as links in a fresh directory next to work/skills. A skill left over from an earlier body (a get-up policy, a skill not
 * retrained this round) is not in it, so it can neither be installed for the wrong body nor choose the body that assembly uses.
 */
export async function stageCurrentBody(work: string, threads: readonly Pick<ThreadResult, "skill" | "status">[]): Promise<{ dir: string; body: string; skills: string[]; left: string[] }> {
  const root = join(work, "skills");
  const shaOf = async (name: string): Promise<string | undefined> => {
    try {
      const j = JSON.parse(await readFile(join(root, name, "skill.json"), "utf8")) as { mjcf_sha256?: unknown; status?: unknown };
      return j.status === "done" && typeof j.mjcf_sha256 === "string" ? j.mjcf_sha256 : undefined;
    } catch {
      return undefined;
    }
  };
  const votes = new Map<string, number>();
  for (const t of threads) {
    if (t.status !== "passed") continue;
    const sha = await shaOf(t.skill);
    if (sha) votes.set(sha, (votes.get(sha) ?? 0) + 1);
  }
  const body = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!body) throw new Error("no skill passed in this round, so there is no body to bring skills home for");
  const dir = join(work, "skills-stage");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const skills: string[] = [];
  const left: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(name)) continue;
    if ((await shaOf(name)) === body) {
      await symlink(join(root, name), join(dir, name));
      skills.push(name);
    } else left.push(name);
  }
  return { dir, body, skills, left };
}

/** Where the session's robot is on its disk (D3's state file) and where the trainers read it on a box. */
export const ROBOT_FILE = "creature/robot.json";
export const BOX_ROBOT_FILE = "/workspace/robot.json";

/** Write `bytes` to `path` on a box (a binary-safe `cat`, parents made). */
async function putFile(box: RemoteBox, path: string, bytes: Uint8Array): Promise<void> {
  const p = await box.exec(["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1.tmp" && mv -f -- "$1.tmp" "$1"', "sh", path], { mode: "binary", timeoutMs: 60_000 });
  await p.stdin.writeBytes(bytes);
  await p.stdin.close();
  const drain = async (s: unknown) => {
    for await (const _ of s as AsyncIterable<Uint8Array>) void _;
  };
  const [, , code] = await Promise.all([drain(p.stdout), drain(p.stderr), p.wait()]);
  if (code !== 0) throw new Error(`writing ${path} on the box failed (${code})`);
}

/** The threads' boxes as the cluster package asks for them, bound to the link. */
export function robotBoxes(link: NonNullable<AppExtraContext["link"]>, work: string, log: AppExtraContext["log"]): ThreadBoxes {
  const boxOf = (id: string): RemoteBox => link.gpu.linkBox(id);
  return {
    async acquire({ threadId, skill }) {
      const id = await link.gpu.acquire(threadId);
      const box = boxOf(id);
      await installPiRun(box);
      // The body this teach step is for. A session without one yet (it has not made a robot) teaches nothing: the trainers refuse an absent body.
      const robot = await readFile(join(work, ROBOT_FILE)).catch((error: Error) => {
        log("robot.no-body", { path: join(work, ROBOT_FILE), error: error.message });
        return undefined;
      });
      if (robot) await putFile(box, BOX_ROBOT_FILE, robot);
      log("robot.box-ready", { thread: threadId, skill, box: id, body: robot ? robot.length : 0 });
      return id;
    },
    async release({ threadId }) {
      await link.gpu.release(threadId).catch((error: Error) => log("robot.release-failed", { thread: threadId, error: error.message }));
    },
  };
}

export default function robotExtra({ link, work, log }: AppExtraContext): AppExtra {
  if (!link) throw new Error("the robot's threads reach their GPU boxes through the server's link: no link here");
  const boxOf = (id: string): RemoteBox => link.gpu.linkBox(id);
  const boxes = robotBoxes(link, work, log);
  const { teach, thread } = teachSkills({
    boxes,
    // Inside the teach task, after every thread has flushed: the tool's own result then says how many skills are home.
    // Only the skills of the body this round taught (an old body's get-up must not choose the body, nor old skills be installed for the new one).
    assemble: async (threads) => {
      const staged = await stageCurrentBody(work, threads);
      try {
        if (staged.left.length > 0) log("robot.skills-left-out", { skills: staged.left, reason: "trained for another body" });
        return { home: await runAssembleSkills(work, { skillsDir: staged.dir }) };
      } finally {
        await rm(staged.dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    artifacts: ({ boxId, skill }) => {
      const sync = new ArtifactSync({ box: boxOf(boxId), remote: `/workspace/skills/${skill}`, local: join(work, "skills", skill), exclude: ["work"], onError: (error) => log("robot.artifacts-failed", { skill, error: error.message }) });
      return { start: () => sync.start(), flush: async (context) => void (await sync.flush(context)), stop: () => sync.stop() };
    },
  });
  return {
    install(registry) {
      registry.install(teach);
      registry.install(thread);
    },
    // `teach` is the session's own; `thread` is only for the forks (train_skill), which select it themselves.
    settings: { extensions: [teach] },
    wrapEnv: (env) =>
      Object.assign(
        remoteEnvs(
          async (target, context) => {
            const box = await target.read.snapshot(RobotBox, target.conversationId, context);
            return box?.boxId ? boxOf(box.boxId) : undefined;
          },
          { fallback: env },
        ),
        { cleanup: env.cleanup },
      ),
  };
}
