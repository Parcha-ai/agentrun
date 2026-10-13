// The server's flags for what the host tells the page about its agent (serve.ts): `--instructions-file F` with `--instructions-mode replace|append`, and `--without-extensions a,b`. They become the
// attach frame's `app` (agent.ts AppPolicy), which the page applies where it creates the root conversation. Nothing here knows what the instructions say or which extensions exist: the names
// are checked against the registry where the root is created (agent.ts), which says what is installed.
import { readFileSync } from "node:fs";
import type { AppPolicy } from "./agent.ts";

/** The policy the flags describe, or undefined when none is given. A bad combination throws an Error whose message says what to fix. */
export function appPolicyFromArgs(args: { file?: string; mode?: string; without?: string }): AppPolicy | undefined {
  const { file, mode, without } = args;
  if (file === undefined && mode !== undefined) throw new Error("--instructions-mode needs --instructions-file");
  if (file !== undefined && mode === undefined) throw new Error("--instructions-file needs --instructions-mode replace|append (there is no default)");
  let instructions: AppPolicy["instructions"];
  if (file !== undefined) {
    if (mode !== "replace" && mode !== "append") throw new Error(`--instructions-mode ${mode}: replace or append`);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`--instructions-file ${file}: cannot read it (${(error as Error).message})`);
    }
    if (text.trim() === "") throw new Error(`--instructions-file ${file}: the file is empty`);
    instructions = { mode, text };
  }
  let withoutExtensions: string[] | undefined;
  if (without !== undefined) {
    withoutExtensions = without.split(",").map((n) => n.trim()).filter(Boolean);
    if (withoutExtensions.length === 0) throw new Error(`--without-extensions ${JSON.stringify(without)}: it is a comma-separated list of extension names`);
  }
  if (!instructions && !withoutExtensions) return undefined;
  return { ...(instructions ? { instructions } : {}), ...(withoutExtensions ? { withoutExtensions } : {}) };
}
