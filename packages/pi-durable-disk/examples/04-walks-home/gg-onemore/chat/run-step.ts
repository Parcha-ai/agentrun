// One step of the launcher (a wrapper around box.py, clean-run, the sandbox list): its output, or an error that says in one
// line which command failed and why, with the step's whole output on `output` for the launcher's log.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export type StepError = Error & { output: string };

export function runStep(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status === 0) return String(r.stdout);
  const stderr = String(r.stderr ?? "");
  const stdout = String(r.stdout ?? "");
  const lines = `${stderr}\n${stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
  // an uncaught error prints its "Error: ..." line first and ends with "}" and "Node.js v..": the error line says why
  const why = lines.find((l) => /^(\w+)?Error\b|^error\b/i.test(l)) ?? lines.at(-1) ?? (r.error ? String(r.error.message) : "no output");
  const exit = r.status ?? r.signal ?? "without starting";
  const error = new Error(`${[cmd, ...args].join(" ").slice(0, 160)} exited ${exit}: ${why.slice(0, 400)}`) as StepError;
  error.output = [stderr && `stderr:\n${stderr}`, stdout && `stdout:\n${stdout}`].filter(Boolean).join("\n") || String(r.error?.message ?? "");
  throw error;
}
