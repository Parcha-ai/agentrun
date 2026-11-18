// The ACP harnesses' package (@parcha/agentrun-harness-acp: Goose's adapter, its pin and its facts), loaded here alone, by
// name, when serve first asks for it. The package is held from npm for now (its manifest is private), so a serve
// installed from npm runs without it, and its harness table has no goose row; in this repository it is always beside
// serve. A leaf: the harness table's own imports (adapter-facts.ts) read it in any import order.
import { createRequire } from "node:module";
import type { AdapterFacts, AgentAdapter } from "@parcha/agentrun-kernel";

export const ACP_PACKAGE = "@parcha/agentrun-harness-acp";

/** One platform's Goose release, as the pin holds it (the package's AcpArchivePin). */
export type AcpRelease = { readonly url: string; readonly format: string; readonly sha256: string; readonly cmd: string; readonly binarySha256?: string };

/** What serve reads of the package. */
export type AcpPackage = {
  readonly gooseFacts: AdapterFacts;
  readonly GOOSE_PIN: { readonly id: string; readonly version: string; readonly archives: Readonly<Partial<Record<string, AcpRelease>>> };
  readonly GOOSE_INSTALL: string;
  readonly GOOSE_NOT_INSTALLED: string;
  acpPlatform(): string | undefined;
  gooseAdapter(options: Record<string, unknown>): AgentAdapter;
  /** Any ACP agent's adapter, from its recipe (a harness module's, harness-table.ts acpEntry). */
  acpAdapter(options: Record<string, unknown>): AgentAdapter;
  verifyPinnedBinary(path: string, sha256: string): void;
  verifyPinnedBinaryAsync(path: string, sha256: string): Promise<void>;
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
