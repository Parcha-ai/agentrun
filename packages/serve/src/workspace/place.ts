// An agent's v2 `place`, the v2 view of its computer setting: { mode: "runner" } is kind none, { mode: "sandbox", box }
// is kind sandbox on provider box. The claim resolves the setting (resolve-computer.ts resolveComputer), never the place.

/** The v2 place, as an agent's definition holds it. */
export type Place = { readonly mode: "runner" } | { readonly mode: "sandbox"; readonly box: string };
