// The ACP harnesses' package (@parcha/agentrun-harness-acp: Goose's adapter, its pin and its facts), loaded here alone, by
// name, when serve first asks for it. Serve depends on it, so it is beside serve wherever serve is installed; a serve
// installed without it (an older release, from before it was published) runs, and its harness table has no goose row.
// A leaf: the harness table's own imports (adapter-facts.ts) read it in any import order.
import { createRequire } from "node:module";
import type { AdapterFacts, AgentAdapter } from "@parcha/agentrun-kernel";
import type { AcpRecipe } from "@parcha/agentrun-harness-acp";

export const ACP_PACKAGE = "@parcha/agentrun-harness-acp";

/** One platform's release of an ACP agent, as the pin holds it (the package's AcpArchivePin). */
export type AcpRelease = { readonly url: string; readonly format: string; readonly sha256: string; readonly cmd: string; readonly binarySha256?: string; readonly treeSha256?: string };
/** A pinned release of an ACP agent (the package's AcpBinaryPin). */
export type AcpPin = { readonly id: string; readonly version: string; readonly archives: Readonly<Partial<Record<string, AcpRelease>>> };

/** What serve reads of the package. */
export type AcpPackage = {
  readonly gooseFacts: AdapterFacts;
  readonly GOOSE_PIN: AcpPin;
  readonly GOOSE_INSTALL: string;
  readonly GOOSE_NOT_INSTALLED: string;
  readonly cursorFacts: AdapterFacts;
  readonly CURSOR_PIN: AcpPin;
  readonly CURSOR_INSTALL: string;
  readonly CURSOR_CODES: { readonly headlessDisabled: string; readonly notInstalled: string };
  readonly CURSOR_LIMITS: { readonly maxTurns: number; readonly maxToolCalls: number };
  cursorCard(limits: { readonly maxTurns: number; readonly maxToolCalls: number }): string;
  cursorAdapter(options: Record<string, unknown>): AgentAdapter;
  /** Cursor's recipe for a run: its launcher, the run's limits, and its model (none: Cursor's own default). */
  cursorRecipe(options: { command: string; limits: { readonly maxTurns: number; readonly maxToolCalls: number }; model?: string }): AcpRecipe;
  /** The folder Cursor was installed into, from its launcher's path and the pin's `cmd`; undefined when it is not there. */
  cursorRootOf(binary: string, cmd: string): string | undefined;
  /** The form a model id an ACP agent lists takes (Cursor's `gpt-5.4-nano[reasoning=medium]` among them). */
  readonly MODEL_ID: RegExp;
  /** The forms a recipe's allowFile may take (`goose-permission`). */
  readonly ALLOW_FILE_FORMS: readonly string[];
  /** What is wrong with a recipe's announces field, and with a title tie without it, each in words. */
  announcesProblems(announces: unknown, permissionTie: unknown): string[];
  acpPlatform(): string | undefined;
  /** `pin`'s release for `platform` (default this host's) with its binary's digest, and its tree's when `tree`; undefined
   *  where none is pinned so. */
  pinnedRelease(pin: AcpPin, platform?: string, tree?: boolean): (AcpRelease & { readonly binarySha256: string }) | undefined;
  gooseAdapter(options: Record<string, unknown>): AgentAdapter;
  /** Any ACP agent's adapter, from its recipe (a harness module's, harness-table.ts acpEntry). */
  acpAdapter(options: Record<string, unknown>): AgentAdapter;
  /** The model proxy on Anthropic's Messages, Goose's policy (a recipe's under harness-check). */
  gooseProxy(options: Record<string, unknown>): (session: unknown) => Promise<{ env: Record<string, string>; close(): Promise<void> }>;
  verifyPinnedBinary(path: string, sha256: string): void;
  verifyPinnedBinaryAsync(path: string, sha256: string): Promise<void>;
  treeDigest(root: string): Promise<string>;
  verifyPinnedTree(root: string, sha256: string): Promise<void>;
};

const requireHere = createRequire(import.meta.url);
let loaded: AcpPackage | null | undefined;

/** The package, or undefined where it is not installed beside serve. Only its absence is: a package that is there and
 *  fails to load throws. */
export function acpPackage(): AcpPackage | undefined {
  if (loaded === undefined) {
    let found = true;
    try {
      requireHere.resolve(ACP_PACKAGE);
    } catch {
      found = false;
    }
    loaded = found ? (requireHere(ACP_PACKAGE) as AcpPackage) : null;
  }
  return loaded ?? undefined;
}
