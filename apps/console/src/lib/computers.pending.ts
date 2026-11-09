// TEMPORARY. The server's computers list (GET /v2/computers; capabilities.computers, the same list), copied from the
// handlers on places/computers (packages/serve/src/computers.ts: KindView, ProviderView, KeyView). The routes are
// registered and documented in the server switch; when it lands, this file goes and v2.ts aliases the generated types
// (api.generated.ts) under the same names. Import these only through v2.ts. This file never reaches main.

/** A provider's key, as Settings shows it: by name, required or not, saved or not; never a value. */
export type PendingKeyView = { name: string; required: boolean; saved: boolean };
/** A provider that serves a kind: whether a run could have it now, and why not in the server's words. */
export type PendingProviderView = { id: string; name: string; keys: PendingKeyView[]; ready: boolean; why?: string };
/** A kind of computer: whether this server offers it (why not, in its words), the capability groups and the
 *  model-visible tools it brings, and each provider that serves it. */
export type PendingKindView = {
  kind: "none" | "sandbox" | "desktop" | "phone" | "browser";
  offered: boolean;
  why?: string;
  groups: string[];
  tools: string[];
  providers: PendingProviderView[];
};
/** GET /v2/computers's answer, and capabilities.computers. */
export type PendingComputers = { kinds: PendingKindView[] };
