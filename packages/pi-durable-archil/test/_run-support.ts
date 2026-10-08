// Shared by the run suites and their fixtures: a claim over a local directory, a scripted model, a long-running command.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import type { AgentChange, ConversationId } from "@earendil-works/pi-durable";
import type { Claim, RunRef } from "../src/claim.ts";
import { ArchilCodingTools } from "../src/env.ts";
import { FencedError } from "../src/errors.ts";
import type { DurableRun } from "../src/run.ts";
import { openClaimDir, type ClaimDir } from "../src/status.ts";

export const ctx = BACKGROUND_CONTEXT;

export function scratchRoot(prefix: string): { root: string; remove(): void } {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `pda-${prefix}-`));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

export const localRef = (id: string): RunRef => ({ disk: "dsk-local", region: "local", id });

/** The claim directory of a run root on a local directory: held open like a mount's, without the mount table check. */
export const localClaimDir = (root: string): Promise<ClaimDir> => openClaimDir(root, { fstype: null });

export interface FakeClaim extends Claim {
  readonly log: string[];
}

/**
 * A claim over a local directory that records what the run asks of it. `barrier` and `release` may be replaced to
 * inject a fence or to look at the world at the moment the run unmounts.
 */
export function fakeClaim(
  root: string,
  ref: RunRef,
  options: { log?: string[]; reused?: boolean; barrier?: () => Promise<void>; release?: () => Promise<void> } = {},
): FakeClaim {
  const log = options.log ?? [];
  let fence: { cause: unknown } | undefined;
  return {
    log,
    ref,
    disk: ref.disk,
    root,
    work: join(root, "work"),
    store: join(root, "store"),
    reused: options.reused ?? false,
    forced: false,
    timings: { mountMs: 0, verifyMs: 0 },
    get fenced() {
      return fence !== undefined;
    },
    markFenced(cause?: unknown) {
      log.push("markFenced");
      fence ??= { cause };
    },
    async barrier() {
      log.push("barrier");
      if (fence) throw new FencedError("fenced", { cause: fence.cause });
      await options.barrier?.();
      return { ms: 0 };
    },
    async release() {
      log.push("release");
      await options.release?.();
      return { via: "archil" as const };
    },
  };
}

let callIds = 0;

/**
 * The scripted model, the same in every process: "bash: <command>" gets a call of pi's `bash` tool with that command,
 * "turn <n>" a call of an app's `mark_tool` with `{n}`, anything else (a tool result included) the answer "ok".
 */
export const scriptedReply: FauxResponseFactory = (context) => {
  // pi places its system section after the first user message, so look past it.
  const last = context.messages.findLast((m) => (m.role as string) !== "system");
  const text = last?.role === "user" ? (typeof last.content === "string" ? last.content : last.content.map((c) => ("text" in c ? c.text : "")).join("")) : "";
  const bash = /^bash: ([\s\S]*)$/.exec(text);
  if (bash) return fauxAssistantMessage(fauxToolCall("bash", { command: bash[1]! }, { id: `bash-${process.pid}-${++callIds}` }), { stopReason: "toolUse" });
  const turn = /^turn (\d+)$/.exec(text);
  if (turn) return fauxAssistantMessage(fauxToolCall("mark_tool", { n: Number(turn[1]) }, { id: `call-${turn[1]}` }), { stopReason: "toolUse" });
  return fauxAssistantMessage("ok");
};

/** Harness options over pi-ai's faux provider (no network, no spend), scripted by `scriptedReply`, with pi's coding tools. */
export function scriptedHarness() {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 5_000 }, () => scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const registry = createRegistry();
  registry.install(ArchilCodingTools);
  return { faux, models, registry, agent: { model: { provider: model.provider, modelId: model.id } } };
}

/**
 * Start `sleep 600` the way an agent does: a model call of pi's `bash` tool, in a conversation of its own so the run's
 * other conversations stay free. Returns the command's pid once the shell wrote it.
 */
export async function startCommand(run: Pick<DurableRun, "harness" | "claim">, agent: AgentChange, name?: string): Promise<number> {
  return (await startCommandIn(run, agent, name)).pid;
}

/** `startCommand`, also returning the conversation whose `bash` call runs the command. */
export async function startCommandIn(
  run: Pick<DurableRun, "harness" | "claim">,
  agent: AgentChange,
  name = `sleeper-${process.pid}-${Date.now()}`,
): Promise<{ pid: number; conversationId: ConversationId }> {
  const pidFile = join(run.claim.work, `${name}.pid`);
  const conversation = await run.harness.createConversation({ ownership: { kind: "ownerless" }, agent }, ctx);
  await conversation.submit({ type: "input", content: `bash: echo $$ > '${pidFile}'; exec sleep 600` }, ctx);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (pid > 0) return { pid, conversationId: conversation.id };
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the bash tool's command never wrote ${pidFile}`);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

/** Polls until `pid` is gone (a killed child of this process is reaped asynchronously). */
export async function waitGone(pid: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !alive(pid);
}

export function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}
