// Compile-time check, run by `npm run typecheck` after the workspace build: durableProfileStore is pi-browser's
// ProfileStore, and the package's declaration of that type stays exactly pi-browser's.
import type { Session } from "@earendil-works/pi-durable";
import type { ProfileStore as PiBrowserProfileStore } from "@parcha/pi-browser/providers/browserbase";
import { durableProfileStore, type ProfileStore } from "../src/index.js";

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export const sameType: Same<ProfileStore, PiBrowserProfileStore> = true;
export const assignable: PiBrowserProfileStore = durableProfileStore({} as Pick<Session, "commit" | "snapshot">);
