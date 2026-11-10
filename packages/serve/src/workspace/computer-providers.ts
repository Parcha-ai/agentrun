// The provider makers computerForClaim is handed at the claim (its `providers`): each provider the computer package
// declares, built by its providerFor from the options its saved keys fill (computer-keys.ts providerOptions, by its
// descriptor's key names), and nothing else. A provider whose descriptor declares a ledger (its sessions carry no labels
// of their own) is given the store's computer ledger, as the option its descriptor names. No key reaches a provider any
// other way, and nothing here reads the environment or names a vendor.
import { type ComputerProvider, PROVIDERS, type ProviderEntry, providerFor } from "@parcha/agentrun-computer";
import type { ProviderFactories } from "../computer-keys.js";
import type { ProviderExtras, ProviderMakers } from "./computer-for-claim.js";

/** How a provider is built from its id and options: the computer package's providerFor, or a test's stand-in. `claim`:
 *  what the claim that makes it lets its run's computer reach (the launch's box_allow), absent outside a claim; never a
 *  provider option. */
export type ProviderLoad = (id: string, options: Record<string, unknown>, claim?: { readonly boxAllow?: readonly string[] | "none" }) => Promise<ComputerProvider>;

/** Settings → Computers' factories (createComputerRoutes' `factories`, its account test) from the same makers, so serve
 *  builds a provider in one place: each made with its options and `ledgerOf` its id's ledger. */
export function computerProviderFactories(makers: ProviderMakers, ledgerOf: (id: string) => unknown): ProviderFactories {
  return Object.fromEntries(Object.entries(makers).map(([id, make]) => [id, (options: Record<string, string>) => make!(options, { ledger: ledgerOf(id) as never })])) as ProviderFactories;
}

/** Every provider in `entries` (the computer package's PROVIDERS, each from its descriptor), made through `load`
 *  (providerFor) from its options, plus the server's ledger as the option its descriptor names, when it declares one. */
export function computerProviderMakers({ load = providerFor as unknown as ProviderLoad, entries = PROVIDERS }: { readonly load?: ProviderLoad; readonly entries?: readonly Pick<ProviderEntry, "id" | "ledger">[] } = {}): ProviderMakers {
  return Object.fromEntries(
    entries.map(({ id, ledger }) => [
      id,
      (options: Record<string, string>, extras: ProviderExtras) =>
        load(id, { ...options, ...(ledger === undefined ? {} : { [ledger.option]: extras.ledger }) }, extras.boxAllow === undefined ? {} : { boxAllow: extras.boxAllow }),
    ]),
  ) as ProviderMakers;
}
