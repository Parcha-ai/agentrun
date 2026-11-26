// A run's share-export reads over the store (run-export.ts ExportReads): the run's view, its served Timeline rows (and
// the same rows with their calls' arguments, read for each call's context alone), a workflow's graph, its files through
// its Workspace, its agent's name, and its one cut, read last. One home: the export route (server.ts) and the share count
// (`agentrun-serve scrub`, scrub-command.ts) read a run the same way, so the count is the export's own.

import type { Context } from "@earendil-works/chord/context";
import { getAgent } from "./agents-store.js";
import type { ExportReads } from "./run-export.js";
import { runCutValues } from "./run-cut.js";
import { listRunFiles, runGraphView, type RunReadsDeps } from "./run-reads-over-store.js";
import { servedTimelineRows, type ServedTimelineDeps } from "./run-timeline-served.js";
import { viewOverStore, type ViewDeps, withheldOverStore } from "./store-view.js";
import type { Store } from "./store/index.js";

export interface ExportStoreDeps {
  readonly view: ViewDeps;
  readonly timeline: ServedTimelineDeps;
  readonly runReads: RunReadsDeps;
  readonly cut: Parameters<typeof runCutValues>[0];
}

/** Run `runId`'s export reads over `store`; `context` carries the journal reads (a request's, or the background's). */
export function exportReadsOverStore(store: Store, runId: string, deps: ExportStoreDeps, context: Context): ExportReads {
  return {
    view: () => viewOverStore(store, runId, deps.view),
    withheld: () => withheldOverStore(store, runId, deps.view),
    // The rows as GET /runs/{id}/timeline serves them, under the run's one cut; a workflow's graph as its route.
    rows: () => servedTimelineRows(deps.timeline, store, runId, context, false),
    // The same rows with their calls' arguments, read for each call's context alone (share-context.ts): never carried.
    calls: () => servedTimelineRows(deps.timeline, store, runId, context, true),
    graph: () => runGraphView(store, runId, deps.runReads),
    files: async () => {
      const listed = await listRunFiles(store, runId, deps.runReads);
      const workspace = listed.files.length ? await deps.runReads.runWorkspace(store, runId) : null;
      const files = workspace ? listed.files.map((file) => ({ path: file.path, size: file.size_bytes, ...(file.unreadable ? { unreadable: true } : {}), read: (limit: number) => workspace.read(file.path, { offset: 0, length: limit }) })) : [];
      return { files, truncated: listed.truncated };
    },
    agentName: async (agentId) => (await getAgent(store, agentId))?.agent.name,
    // Read last, after everything above was served under it: the cut only grows.
    cut: () => runCutValues(deps.cut, store, runId),
  };
}
