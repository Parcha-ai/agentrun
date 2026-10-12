// The robot cluster on the session's VM, as the cloud app's extra (03-tab-to-cloud/cloud-app.ts loads it from DEMO_APP_EXTRA): `teach_skills` on
// the session (its default tool next to the shared ones), `train_skill` for the forked threads, each thread's tools on its own GPU box through the
// link (the server holds the Modal key; the VM only asks), and each skill's files mirrored home to this run's disk as the trainer writes them.
//   acquire(thread)  asks the server for a box (idempotent per thread, queued when the pool is smaller than the thread count), puts pi-run on it
//                    and copies the session's robot.json there (the body this teach step is for, so a body change is the same call again);
//   env(target)      a conversation with a box in its robot.box doc runs its tools there (D0's RemoteEnv over the link's box); any other, here;
//   artifacts        the box's /workspace/skills/<skill>/ to <work>/skills/<skill>/ (D0's ArtifactSync), the trainer's own state left on the box.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactSync, installPiRun, remoteEnvs, type RemoteBox } from "@parcha/pi-durable-disk";
import type { AppExtra, AppExtraContext } from "../../03-tab-to-cloud/app-extra.ts";
import { RobotBox, teachSkills, type ThreadBoxes } from "../cluster/teach-skills.ts";

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
      const robot = await readFile(join(work, ROBOT_FILE)).catch(() => undefined);
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
