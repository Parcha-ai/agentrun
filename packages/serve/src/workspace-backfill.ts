// `agentrun-serve workspace-backfill FILE [--data DIR] [--apply]`: an operator's one-off, for agents made before their
// backend sent the AgentRun-Workspace header (workspace-scope.ts). FILE is JSON, `{"<agent id>": "<workspace>", ...}`.
// Each agent with no workspace is put in the one named; one already in it is left; one in another is refused, never
// moved. Without --apply it writes nothing and prints what it would do. A run with no workspace of its own reads as its
// agent's, so the agent's runs follow it. The store is the one the server opens (store/open.ts), opened as a runner opens
// it: no owner lock, so a running server keeps serving. Exit 0 when every agent is set or already there, 1 when any is
// refused or missing (with --apply, the others are set), 2 for bad arguments or a file that is not that JSON.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openStore, type Store, storeTarget } from "./store/index.js";
import { STORE_FILE } from "./store/sqlite/store.js";
import { WORKSPACE } from "./workspace-scope.js";

/** What the backfill does with one agent: `set` (put in the workspace, or would be without --apply), `already` (in it),
 *  `refused` (in another, which is kept), `missing` (no agent of that id). */
export type BackfillOutcome = "set" | "already" | "refused" | "missing";

/** Each agent's outcome, `apply` writing the `set` ones (each only where the agent still has no workspace, so an agent a
 *  scoped request stamped meanwhile is refused, not moved). */
export async function backfillWorkspaces(store: Pick<Store, "agents">, wanted: Readonly<Record<string, string>>, apply: boolean): Promise<{ id: string; workspace: string; outcome: BackfillOutcome; held: string | null }[]> {
  const outcomes: { id: string; workspace: string; outcome: BackfillOutcome; held: string | null }[] = [];
  for (const [id, workspace] of Object.entries(wanted)) {
    const before = await store.agents.workspace(id);
    const held = before === null && apply ? await store.agents.adoptWorkspace(id, workspace) : before;
    const outcome: BackfillOutcome = held === undefined ? "missing" : held === null ? "set" : held !== workspace ? "refused" : before === null ? "set" : "already";
    outcomes.push({ id, workspace, outcome, held: held ?? null });
  }
  return outcomes;
}

/** The file's map, or why it is not one: a JSON object of agent ids to workspace names. */
export function backfillMapOf(text: string): Record<string, string> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `it is not JSON: ${(error as Error).message}`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "it is not a JSON object of agent ids to workspaces";
  for (const [id, workspace] of Object.entries(parsed)) {
    if (typeof workspace !== "string" || !WORKSPACE.test(workspace)) return `${id}'s workspace is not 1 to 128 letters, digits, ':', '.', '_' or '-'`;
  }
  return parsed as Record<string, string>;
}

/** `agentrun-serve workspace-backfill`: the exit code (the file's head). */
export async function workspaceBackfillMain(argv: readonly string[], dataDefault: string, usage: string, io: { out: (line: string) => void; err: (line: string) => void } = { out: console.log, err: console.error }): Promise<number> {
  let values: { data?: string | undefined; apply?: boolean | undefined };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: { data: { type: "string" }, apply: { type: "boolean" } } }));
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${usage}`);
    return 2;
  }
  if (positionals.length !== 1) {
    io.err(`workspace-backfill takes one file\n\n${usage}`);
    return 2;
  }
  const text = await readFile(positionals[0]!, "utf8").catch((error: Error) => error);
  if (text instanceof Error) {
    io.err(`agentrun-serve workspace-backfill: ${positionals[0]} could not be read: ${text.message}`);
    return 2;
  }
  const wanted = backfillMapOf(text);
  if (typeof wanted === "string") {
    io.err(`agentrun-serve workspace-backfill: ${positionals[0]} is refused: ${wanted}.`);
    return 2;
  }
  const dir = values.data ?? dataDefault;
  if (storeTarget(dir).kind === "sqlite" && !existsSync(join(dir, STORE_FILE))) {
    io.err(`agentrun-serve workspace-backfill: there is no store in ${dir}.`);
    return 1;
  }
  const store = await openStore({ dataDir: dir, role: "runner" });
  try {
    const apply = values.apply === true;
    const outcomes = await backfillWorkspaces(store, wanted, apply);
    for (const { id, workspace, outcome, held } of outcomes) {
      const said = outcome === "set" ? (apply ? `set to ${workspace}` : `would be set to ${workspace}`) : outcome === "already" ? `already in ${workspace}` : outcome === "refused" ? `refused: it is in ${held}, kept` : "refused: no agent of that id";
      io.out(`${id}\t${said}`);
    }
    if (!apply) io.out("nothing was written: run again with --apply to set them");
    return outcomes.some((one) => one.outcome === "refused" || one.outcome === "missing") ? 1 : 0;
  } catch (error) {
    io.err(`agentrun-serve workspace-backfill: ${(error as Error).message}`);
    return 1;
  } finally {
    await store.close();
  }
}
