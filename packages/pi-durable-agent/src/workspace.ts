/** Where a run's workspace may sit under its directory: `work`, or `harness/work` for a run whose harness's own tools run
 *  in a box lent `<run>/harness` (the box binds nothing of the run's directory outside it). Nothing else is ever taken
 *  as one: it becomes a path. */
export const WORKSPACES = ["work", "harness/work"] as const;
export type Workspace = (typeof WORKSPACES)[number];

export const isWorkspace = (value: unknown): value is Workspace => (WORKSPACES as readonly unknown[]).includes(value);
