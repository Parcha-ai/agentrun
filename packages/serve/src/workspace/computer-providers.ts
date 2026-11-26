// The provider makers computerForClaim is handed at the claim (its `providers`): each provider the computer package
// declares, built by its providerFor from the options its saved keys fill (computer-keys.ts providerOptions, by its
// descriptor's key names), and nothing else. A provider whose descriptor declares a ledger (its sessions carry no labels
// of their own) is given the store's computer ledger, as the option its descriptor names; one that declares secrets
// (a key it makes for itself) is given the server's sealed store of them (providerSecretsOf, by computerDepsFrom). No
// key reaches a provider any other way, and nothing here reads the environment or names a vendor: a provider whose descriptor names the host
// variables it reads (hostEnv) is given the caller's values of those names alone.
import { type ComputerProvider, PROVIDERS, type ProviderEntry, providerFor, type ProviderSecrets } from "@parcha/agentrun-computer";
import type { ProviderFactories } from "../computer-keys.js";
import { getSealedKey, keepSealedKey } from "../server-keys.js";
import type { SealedKeys } from "../store/index.js";
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

type SecretsStore = { readonly sealedKeys: Pick<SealedKeys, "get" | "putIfAbsent" | "replaceIf"> };

/** Each store's ProviderSecrets, by seal key and provider id: one object for them all in this process, so a provider
 *  sharing its first use's work by its store (Agent37's key, made once) shares it with every other on the same one. */
const secretsByStore = new WeakMap<object, WeakMap<Buffer, Map<string, ProviderSecrets>>>();

/** The server's store of the secrets provider `id` makes for itself (its descriptor's `secrets`: Agent37's SSH key),
 *  each sealed under `sealKey` in store.sealedKeys at its own row, computer.<id>.<name>, so it outlives a restart of the
 *  same store and is in no row in the clear. A value that does not open under this seal key reads as none; putIfAbsent
 *  keeps one writer's value of those racing (keepSealedKey). The same object for the same store, seal key and id. */
export function providerSecretsOf(store: SecretsStore, sealKey: Buffer, id: string): ProviderSecrets {
  let bySeal = secretsByStore.get(store);
  if (bySeal === undefined) secretsByStore.set(store, (bySeal = new WeakMap()));
  let byId = bySeal.get(sealKey);
  if (byId === undefined) bySeal.set(sealKey, (byId = new Map()));
  const known = byId.get(id);
  if (known !== undefined) return known;
  const row = (name: string): string => `computer.${id}.${name}`;
  const made: ProviderSecrets = {
    get: (name) => getSealedKey(store, sealKey, row(name)),
    putIfAbsent: (name, value) => keepSealedKey(store, sealKey, row(name), value),
  };
  byId.set(id, made);
  return made;
}

/** `env`'s values of `names` (a descriptor's hostEnv), and no other variable of it. */
export function hostEnvOf(env: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => (env[name] === undefined ? [] : [[name, String(env[name])]])));
}

/** Every provider in `entries` (the computer package's PROVIDERS, each from its descriptor), made through `load`
 *  (providerFor) from its options, plus the server's ledger as the option its descriptor names, when it declares one, and
 *  `env`'s values of the host variables it declares (hostEnv) as its `env`. Without `env`, no `env` option is added, and
 *  the package gives such a provider none. */
export function computerProviderMakers({ load = providerFor as unknown as ProviderLoad, entries = PROVIDERS, env }: { readonly load?: ProviderLoad; readonly entries?: readonly Pick<ProviderEntry, "id" | "ledger" | "hostEnv">[]; readonly env?: NodeJS.ProcessEnv } = {}): ProviderMakers {
  return Object.fromEntries(
    entries.map(({ id, ledger, hostEnv }) => [
      id,
      (options: Readonly<Record<string, unknown>>, extras: ProviderExtras) =>
        load(id, { ...options, ...(ledger === undefined ? {} : { [ledger.option]: extras.ledger }), ...(hostEnv && env ? { env: hostEnvOf(env, hostEnv) } : {}) }, extras.boxAllow === undefined ? {} : { boxAllow: extras.boxAllow }),
    ]),
  ) as ProviderMakers;
}
