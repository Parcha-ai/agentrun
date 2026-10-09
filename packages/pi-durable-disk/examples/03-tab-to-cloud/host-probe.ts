// A Node host's description of itself, for the "you are now running in X" notice: what the machine has (CPUs, memory,
// GPUs from nvidia-smi), which commands the agent will find, and whether the internet is reachable. The label and the
// class come from the host driver (DEMO_ENV_LABEL, DEMO_ENV_CLASS), the rest from this machine.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { cpus, release, totalmem, type } from "node:os";
import type { EnvironmentFacts } from "./environment.ts";

const TOOLS = ["bash", "node", "npm", "python3", "pip3", "git", "curl", "gcc", "make", "nvidia-smi"];

function gpus(): string | null {
  const r = spawnSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const lines = r.stdout.trim().split("\n").map((l) => l.trim());
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${n}x ${name.replace(/,\s*/, ", ")}`).join("; ");
}

/** The container's limits when it has them (cgroup v2), else the machine's: a sandbox sees its host's CPUs otherwise. */
function limits(): { cpus: number; memoryGb: number } {
  let cpuCount = cpus().length;
  let memory = totalmem();
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quota && quota !== "max" && Number(period) > 0) cpuCount = Math.min(cpuCount, Math.ceil(Number(quota) / Number(period)));
  } catch {
    // no cgroup v2 limit
  }
  try {
    const max = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (max !== "max") memory = Math.min(memory, Number(max));
  } catch {
    // no cgroup v2 limit
  }
  return { cpus: cpuCount, memoryGb: Math.round(memory / 2 ** 30) };
}

export async function probeHost(env: NodeJS.ProcessEnv = process.env): Promise<EnvironmentFacts> {
  const found = TOOLS.filter((tool) => spawnSync("bash", ["-c", `command -v ${tool}`], { stdio: "ignore", timeout: 5_000 }).status === 0);
  const network = await lookup("example.com").then(
    () => true,
    () => false,
  );
  return {
    label: env.DEMO_ENV_LABEL ?? "a cloud host",
    ...(env.DEMO_ENV_CLASS ? { hostClass: env.DEMO_ENV_CLASS } : {}),
    ...limits(),
    gpu: gpus(),
    tools: found,
    network,
    os: `${type()} ${release().split("-")[0]}`,
    ...(env.DEMO_ENV_NOTE ? { note: env.DEMO_ENV_NOTE } : {}),
  };
}
