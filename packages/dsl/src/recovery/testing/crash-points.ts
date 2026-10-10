// The child side of a crash sweep: a process that crosses named points of a run, and either counts the crossings (the
// census) or kills itself at one of them. A point is crossed just before the step it names:
//   admit    before an effect is admitted: nothing of it is durable
//   dispatch after the admission is durable, before the call goes out
//   settle   after the call returned, before its result is committed
//   commit   before the node that ran is committed
//   session  before an agent step's conversation is created
//   request  while a model request is in flight
//   submit   while the step's submission is being taken
import { appendFileSync } from "node:fs";

export const CRASH_POINTS = ["admit", "dispatch", "settle", "commit", "session", "request", "submit"] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

/** The environment variable that carries the plan to the child, as JSON. */
export const CRASH_PLAN_ENV = "AGENTRUN_CRASH_PLAN";
export type CrashPlan = { mode: "census"; file: string } | { mode: "kill"; point: CrashPoint; nth: number };

const SLOT = Symbol.for("agentrun.crash.crossing");

function planOf(env: NodeJS.ProcessEnv): CrashPlan | undefined {
  const text = env[CRASH_PLAN_ENV];
  return text ? JSON.parse(text) as CrashPlan : undefined;
}

const crossed = new Map<CrashPoint, number>();

/** Cross `point`. Without a plan it does nothing; in a census it records the crossing; in a kill plan the nth crossing
 *  of the planned point ends this process with SIGKILL, and never returns. */
export async function crossing(point: CrashPoint): Promise<void> {
  const plan = planOf(process.env);
  if (!plan) return;
  if (plan.mode === "census") { appendFileSync(plan.file, `${point}\n`); return; }
  if (plan.point !== point) return;
  const nth = (crossed.get(point) ?? 0) + 1;
  crossed.set(point, nth);
  if (nth !== plan.nth) return;
  process.kill(process.pid, "SIGKILL");
  await new Promise<never>(() => {});
}

/** Make `crossing` reachable as `globalThis[Symbol.for("agentrun.crash.crossing")]`, for a child whose code does not
 *  import this module. */
export function installCrossing(): void {
  (globalThis as Record<symbol, unknown>)[SLOT] = crossing;
}
