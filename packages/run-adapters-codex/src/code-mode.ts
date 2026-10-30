// Which models Codex runs in code mode, read from the pinned binary's own model catalog. Written for AgentRun.
//
// A code-mode model calls its tools through a JavaScript `exec` of Codex's, under nested call ids that the session's
// records do not tie to the outer call, so this adapter does not run one yet: a session whose model is in the catalog's
// `code_mode_only` set is refused when it is checked, not left to stall.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The slugs the catalog (`codex debug models`) lists with `tool_mode: "code_mode_only"`. */
export function codeModeModels(catalog: string): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(catalog);
  } catch {
    throw new Error("agentrun-harness-codex: the Codex model catalog is not JSON");
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new Error("agentrun-harness-codex: the Codex model catalog has no models list");
  return new Set(models.flatMap((m: { slug?: unknown; tool_mode?: unknown }) => (m?.tool_mode === "code_mode_only" && typeof m.slug === "string" ? [m.slug] : [])));
}

/** The code-mode models of the binary at `path`: its catalog, read once with an empty home and nothing else of this
 *  process's environment. */
export function readCodeModeModels(path: string): ReadonlySet<string> {
  const home = mkdtempSync(join(tmpdir(), "agentrun-codex-catalog-"));
  try {
    const out = execFileSync(path, ["debug", "models"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CODEX_HOME: home }, encoding: "utf8", timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
    return codeModeModels(out);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
