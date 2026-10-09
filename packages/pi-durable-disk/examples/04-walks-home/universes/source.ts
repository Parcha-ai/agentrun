// A run to fork, for running the multiverse on its own: created on the disk, opened once on this host with the demo
// agent's options (the same store and conversation shape a tab's run has), a story entry admitted, and released, so its
// run.json is `paused` with a seal. In the full demo the source is the run the tab or a VM was running, released by its
// host before the fan-out.
import { cp } from "node:fs/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRunDir, mintMountToken, openDurableRun, readRunStatus, removeMountToken, type ArchilHost, type RunRecord, type RunRef } from "@parcha/pi-durable-disk";
import { agentModels, agentRegistry, rootAgent, SETTINGS } from "../../03-tab-to-cloud/agent.ts";
import type { Control } from "./multiverse.ts";

export interface SourceOptions {
  readonly control: Control;
  readonly ref: RunRef;
  readonly mountRoot: string;
  readonly host?: ArchilHost;
  /** What the run's conversation says before the fork, one user-role line. */
  readonly story: string;
  /** A local directory copied into the run's work/ before it is sealed (the creature the universes train). */
  readonly files?: string;
  readonly onResource?: (kind: string, id: string, note?: string) => void;
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

/** Create `ref`, open it once here, admit `story`, release it. Resolves with its sealed run.json. */
export async function makeSourceRun(o: SourceOptions): Promise<RunRecord> {
  const t0 = Date.now();
  await createRunDir(o.control, o.ref.id, { uid: process.getuid!(), gid: process.getgid!(), mode: 0o755 });
  o.onResource?.("run", o.ref.id, "source");
  const token = await mintMountToken(o.control, { nickname: `pda-d1-source-${o.ref.id}`.slice(0, 200), ttl: "1h" });
  o.onResource?.("token", token.identifier, "source");
  try {
    const modelId = "none";
    const run = await openDurableRun(o.ref, {
      mountToken: token.token,
      mountRoot: o.mountRoot,
      ...(o.host ? { host: o.host } : {}),
      harness: { registry: agentRegistry(async () => {}), models: agentModels({ baseUrl: "http://127.0.0.1:9/v1", modelId }), settings: SETTINGS },
      // This process is the orchestrator: a fence of the source must not exit it.
      onFenced: (error) => o.log?.("source.fenced", { message: error.message }),
    });
    try {
      if (o.files) {
        await cp(o.files, run.claim.work, { recursive: true });
        await run.claim.barrier();
      }
      const root = await run.harness.root(ctx, { agent: rootAgent(modelId) });
      await root.submit({ type: "write", requestId: `story:${o.ref.id}`, entry: { kind: "story", model: [{ role: "user", content: o.story, timestamp: Date.now() }], data: {} } }, ctx);
    } finally {
      await run.release();
    }
  } finally {
    await removeMountToken(o.control, token.identifier).then(() => o.onResource?.("token-removed", token.identifier), () => {});
  }
  const record = await readRunStatus(o.control, o.ref.id);
  if (!record || record.sealedSeq === null) throw new Error(`source ${o.ref.id} was not sealed (${record?.status})`);
  o.log?.("source", { run: o.ref.id, status: record.status, sealedSeq: record.sealedSeq, ms: Date.now() - t0 });
  return record;
}
