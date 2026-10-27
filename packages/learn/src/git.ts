import type { Problem } from "./check.js";
import type { ToolPolicy } from "./tools.js";
export type CheckBranchInput = { readonly cwd: string; readonly base: string; readonly head?: string; readonly branch?: string; readonly tools?: Partial<ToolPolicy>; readonly refuseValues?: readonly string[] };
export type BranchCheck = { readonly run?: string; readonly branch?: string; readonly forkPoint?: string; readonly problems: Problem[] };
export async function checkBranch(_input: CheckBranchInput): Promise<BranchCheck> {
  return { problems: [] };
}
