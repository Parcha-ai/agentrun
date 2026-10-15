import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Session } from "@earendil-works/pi-durable";
import { type BrowserProfile, ProfilesDoc, put } from "./kinds.js";
import { AgentHomeError } from "./store.js";

/** pi-browser's `ProfileStore`, declared here by shape: `resolve` returns the saved sign-in for `key`, calling `make`
 *  only when there is none, and no two callers both make one. */
export type ProfileStore = { resolve(key: string, make: (signal: AbortSignal) => Promise<string>): Promise<string> };

/** The run store as the host holds it: its Harness, or any Session on that file. */
export type ProfileTarget = Pick<Session, "commit" | "snapshot">;

const locks = new WeakMap<object, Map<string, Promise<void>>>();

/** Run `work` after every earlier call for the same key on the same target. */
async function inTurn<T>(target: object, key: string, work: () => Promise<T>): Promise<T> {
  let keys = locks.get(target);
  if (!keys) locks.set(target, (keys = new Map()));
  const before = keys.get(key) ?? Promise.resolve();
  const result = before.then(work);
  const settled = result.then(() => undefined, () => undefined);
  keys.set(key, settled);
  try { return await result; } finally { if (keys.get(key) === settled) keys.delete(key); }
}

/** A `ProfileStore` over the run store's `browser.profiles`. A ready profile's ref is returned as it is; otherwise
 *  `make` runs once, outside any commit, and its ref commits as `ready` before it is returned. `provider` names who
 *  made a profile that had none (default `browserbase`); `signal` is passed to `make`. */
export function durableProfileStore(target: ProfileTarget, options: { provider?: string; signal?: AbortSignal } = {}): ProfileStore {
  const provider = options.provider ?? "browserbase";
  return {
    resolve(key, make) {
      if (typeof key !== "string" || key === "") return Promise.reject(new AgentHomeError("invalid", "the profile key is not a non-empty string"));
      return inTurn(target, key, async () => {
        const known = (await target.snapshot(ProfilesDoc, key, BACKGROUND_CONTEXT)) as Readonly<BrowserProfile> | undefined;
        if (known?.state === "ready" && typeof known.ref === "string" && known.ref !== "") return known.ref;
        const ref = await make(options.signal ?? new AbortController().signal);
        if (typeof ref !== "string" || ref === "") throw new AgentHomeError("invalid", `making the profile ${key} returned no ref`);
        const profile: BrowserProfile = { ...(known ?? {}), provider: known?.provider || provider, ref, state: "ready" };
        await target.commit(async (tx) => { put(await tx.doc(ProfilesDoc, key, null), profile); }, BACKGROUND_CONTEXT);
        return ref;
      });
    },
  };
}
