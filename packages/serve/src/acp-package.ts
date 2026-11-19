// The ACP harnesses' package (@parcha/agentrun-harness-acp: Goose's adapter, its pin and its facts), loaded here alone, by
// name, when serve first asks for it. Serve depends on it, so it is beside serve wherever serve is installed; a serve
// installed without it (an older release, from before it was published) runs, and its harness table has no goose row.
// A leaf: the harness table's own imports (adapter-facts.ts) read it in any import order.
import { createRequire } from "node:module";
import type { AdapterFacts, AgentAdapter } from "@parcha/agentrun-kernel";

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
  /** Cursor's release pinned for `platform` (default this host's), its launcher's and tree's digests; undefined where none is. */
  cursorRelease(platform?: string): { readonly cmd: string; readonly binarySha256: string; readonly treeSha256: string } | undefined;
  /** The form a model id an ACP agent lists takes (Cursor's `gpt-5.4-nano[reasoning=medium]` among them). */
  readonly MODEL_ID: RegExp;
  acpPlatform(): string | undefined;
  gooseAdapter(options: Record<string, unknown>): AgentAdapter;
  /** Any ACP agent's adapter, from its recipe (a harness module's, harness-table.ts acpEntry). */
  acpAdapter(options: Record<string, unknown>): AgentAdapter;
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
