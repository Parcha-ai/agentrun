// The browser plane's piece of the planted-secret harness (SECRETS-PLAN.md, rule 5): one sign-in planted straight into the
// store, under the server's seal key, with a pointer no answer, row, file or log line may ever hold in the clear. tl-tools'
// harness imports both exports when it lands: it plants through every secret write route, and the browser plane has none
// (SIGN_IN_WRITE_ROUTES, src/sign-ins-secrets.ts says why), so its value is planted here instead.
import { randomBytes } from "node:crypto";
import { saveSignIn } from "../dist/sign-ins-store.js";

export { SIGN_IN_WRITE_ROUTES } from "../dist/sign-ins-secrets.js";

/** Plants one saved sign-in for `agentId` (which must exist in `store`), sealed under `sealKey` as a run's save would keep
 *  it: a distinctive vendor pointer (`bb-ctx-PLANTED-<hex>` for Browserbase, `agentrun-PLANTED-<hex>` for Kernel). Returns
 *  the pointer to look for, and the row as saved. */
export async function plantedSignIn(store, sealKey, { agentId = "agent-1", provider = "browserbase" } = {}) {
  const pointer = `${provider === "kernel" ? "agentrun" : "bb-ctx"}-PLANTED-${randomBytes(12).toString("hex")}`;
  const saved = await saveSignIn(store, sealKey, { agentId, provider, pointer });
  return { pointer, agentId, provider, saved };
}
