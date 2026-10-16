// Compile-time check, run by `npm run typecheck` after the workspace build: durableProfileStore is pi-browser's
// ProfileStore, and the package's declaration of that type stays exactly pi-browser's.
import type { Session } from "@earendil-works/pi-durable";
import { durableProfileStore, type ProfileStore } from "../src/index.js";

/** pi-browser's declaration (`providers/profiles.ts`), for as long as this repository's pi-browser does not export it. */
type Declared = { resolve(key: string, make: (signal: AbortSignal) => Promise<string>): Promise<string> };
/** pi-browser's own type once it exports `fileProfileStore` from `./providers/browserbase`; until then, `Declared`. */
type PiBrowserProfileStore = typeof import("@parcha/pi-browser/providers/browserbase") extends { fileProfileStore: (...args: never[]) => infer Store } ? Store : Declared;

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export const sameType: Same<ProfileStore, PiBrowserProfileStore> = true;
export const assignable: PiBrowserProfileStore = durableProfileStore({} as Pick<Session, "commit" | "snapshot">);
