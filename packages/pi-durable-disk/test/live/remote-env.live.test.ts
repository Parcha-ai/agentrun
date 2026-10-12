// RemoteEnv on real Modal sandboxes. Off unless asked:
//   PDA_LIVE=1 MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... node --test --test-concurrency=1 test/live/remote-env.live.test.ts
// 1. pi's env conformance suite over a RemoteEnv on a CPU sandbox (debian:bookworm-slim).
// 2. With PDA_LIVE_TRAINER_IMAGE and PDA_LIVE_TRAINER_BODY: one thread's tools on an H100 running a skill trainer
//    (`pi-run <skill> -- train-skill <skill> --body /workspace/robot.json --out /workspace/skills/<skill>`), its folder synced by
//    ArtifactSync as checkpoints land, then the same command again (it must return 0 at once). Every box is terminated.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ArtifactSync, modalGpuBoxes, RemoteEnv, type ModalGpuSdk, type RemoteBox } from "../../src/remote-env.ts";
import { registerEnvCases } from "../_env-conformance.ts";

const LIVE = process.env.PDA_LIVE === "1" && Boolean(process.env.MODAL_TOKEN_ID) && Boolean(process.env.MODAL_TOKEN_SECRET);
const APP = process.env.PDA_MODAL_APP ?? "pda-live-remote-env";
type Sdk = ModalGpuSdk & { sandboxes: ModalGpuSdk["sandboxes"] };
const sdk = LIVE ? (new ((await import("modal" as string)) as { ModalClient: new () => Sdk }).ModalClient()) : undefined;
const live: (RemoteBox & { terminate(): Promise<void> })[] = [];
after(async () => { for (const b of live) await b.terminate().catch(() => {}); });

describe("RemoteEnv on a real Modal sandbox", { skip: !LIVE }, () => {
  const box = (async () => {
    const app = await sdk!.apps.fromName(APP, { createIfMissing: true });
    const b = await sdk!.sandboxes.create(app, sdk!.images.fromRegistry("debian:bookworm-slim"), { timeoutMs: 30 * 60_000, cpu: 1 });
    live.push(b);
    return b;
  })();
  if (LIVE) registerEnvCases("modal", async (use) => {
    const b = await box;
    const env = new RemoteEnv({ box: b, root: "/tmp", watchIntervalMs: 500 });
    const dir = await env.createTempDir("conf-", context);
    assert.ok(dir.ok);
    await use(new RemoteEnv({ box: b, root: dir.value, watchIntervalMs: 500 }));
  });
});

const IMAGE = process.env.PDA_LIVE_TRAINER_IMAGE, BODY = process.env.PDA_LIVE_TRAINER_BODY, SKILL = process.env.PDA_LIVE_TRAINER_SKILL ?? "walk";
it("a thread's tools on an H100: the skill trainer through RemoteEnv, its checkpoints synced home", { skip: !LIVE || !IMAGE || !BODY, timeout: 20 * 60_000 }, async () => {
  const boxes = modalGpuBoxes(sdk!, { appName: APP, image: IMAGE!, gpu: "H100", timeoutMs: 15 * 60_000, create: { cpu: 8, memoryMiB: 65536, regions: ["us-east"] } });
  const box = await boxes.ensure(`remote-env-live:${SKILL}:${Date.now()}`);
  live.push(box as RemoteBox & { terminate(): Promise<void> });
  const local = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pda-remote-live-"));
  try {
    const env = new RemoteEnv({ box });
    assert.ok((await env.writeFile("robot.json", readFileSync(BODY!), context)).ok);
    const sync = new ArtifactSync({ box, remote: `/workspace/skills/${SKILL}`, local, intervalMs: 2_000 });
    sync.start();
    const cmd = `pi-run ${SKILL} -- train-skill ${SKILL} --body /workspace/robot.json --out /workspace/skills/${SKILL}`;
    let out = "";
    const run = await env.exec(cmd, { timeout: 600, onOutput: (t) => { out += t; } }, context);
    assert.ok(run.ok && run.value.exitCode === 0, `train-skill: ${run.ok ? run.value.exitCode : run.error.message}\n${out.slice(-2000)}`);
    const totals = await sync.flush(context);
    await sync.stop();
    assert.ok(totals.files > 0);
    assert.equal(JSON.parse(readFileSync(join(local, "skill.json"), "utf8")).status, "done");
    assert.ok(existsSync(join(local, "policy.json")));
    const again = await env.exec(cmd, { timeout: 300 }, context);
    assert.ok(again.ok && again.value.exitCode === 0, "a rerun on the same folder returns 0 at once");
    await boxes.terminate(box.sandboxId);
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
});
