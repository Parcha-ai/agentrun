import type { ToolPolicy } from "./tools.js";
export type Rule = string;
export type Problem = { readonly rule: Rule; readonly path?: string; readonly detail: string };
export type Change = { readonly path: string; readonly status: "added" | "modified" | "deleted"; readonly mode?: string; readonly size?: number; readonly bytes?: Uint8Array };
export type CheckInput = { readonly branch: string; readonly changes: readonly Change[]; readonly forkPoint?: string; readonly headFiles?: Iterable<string>; readonly tools?: Partial<ToolPolicy>; readonly refuseValues?: readonly string[] };
export function checkRun(_input: CheckInput): Problem[] {
  return [];
}
