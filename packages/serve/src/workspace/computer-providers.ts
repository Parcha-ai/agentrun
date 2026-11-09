// The provider makers computerForClaim is handed at the claim (its `providers`): each registry id built by the computer
// package's providerFor from the options its saved keys fill (computer-keys.ts providerOptions, by the registry's key
// names), and nothing else. The phone provider, which keeps no labels of its own, is given the store's computer ledger.
// No key reaches a provider any other way, and nothing here reads the environment.
import { type ComputerProvider, providerFor, providerIds } from "@parcha/agentrun-computer";
import type { ProviderFactories } from "../computer-keys.js";
import type { ProviderMakers } from "./computer-for-claim.js";

/** How a provider is built from its id and options: the computer package's providerFor, or a test's stand-in. */
export type ProviderLoad = (id: string, options: Record<string, unknown>) => Promise<ComputerProvider>;

/** Settings → Computers' factories (createComputerRoutes' `factories`, its account test) from the same makers, so serve
 *  builds a provider in one place: each made with its options and `ledgerOf` its id's ledger. */
export function computerProviderFactories(makers: ProviderMakers, ledgerOf: (id: string) => unknown): ProviderFactories {
  return Object.fromEntries(Object.entries(makers).map(([id, make]) => [id, (options: Record<string, string>) => make!(options, { ledger: ledgerOf(id) as never })])) as ProviderFactories;
}

/** Every provider the computer package holds, each made through `load` (providerFor) from its options. */
export function computerProviderMakers({ load = providerFor as unknown as ProviderLoad }: { readonly load?: ProviderLoad } = {}): ProviderMakers {
  return Object.fromEntries(
    providerIds.map((id) => [
      id,
      (options: Record<string, string>, extras: { readonly ledger: unknown }) => load(id, { ...options, ...(id === "phone-harness" ? { ledger: extras.ledger } : {}) }),
    ]),
  ) as ProviderMakers;
}
