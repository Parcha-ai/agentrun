// The runner's side of a github_app MCP server (runner/mcp-github.ts): the server's GitHub App, read from the store at each
// claim and again before each mint, bound into the mint the claim step calls, with the run's repository. The App's id and
// private key are the rows the server sealed in trigger_settings (adapter "github", scope "server", AAD
// trigger_settings|github|server|<field>, as sealed-settings-store.ts writes them), opened here with the runner's seal key.
// No App (never connected, disconnected, or rows that do not open under this key): no access, and such a server's calls
// are refused in words (GITHUB_UNUSABLE.noAccess). An App disconnected or replaced while a run holds a token: its next
// mint is refused as disconnected, and the claim step drops and revokes the token it holds.
import { unseal } from "@parcha/pi-durable-agent";
import { GITHUB_API, GITHUB_FIELDS, GITHUB_SCOPE, githubCall, githubTargetOf, mintInstallationToken } from "../github.js";
import type { TriggerSettings } from "../store/index.js";
import { isObject } from "../validate.js";
import type { GithubAppAccess } from "./mcp-github.js";

/** The access, with the API base its mint goes to: GitHub's own, or a test runner's fake. */
export type GithubAppAccessAt = GithubAppAccess & { readonly api: string };

const ADAPTER = "github";
const aad = (field: string) => `trigger_settings|${ADAPTER}|${GITHUB_SCOPE}|${field}`;

/** The server's App as the store holds it now, opened with `sealKey`: its id and private key, or undefined when there is none
 *  this key opens. */
async function appOf(store: { readonly triggerSettings: Pick<TriggerSettings, "get"> }, sealKey: Buffer): Promise<{ appId: string; pem: string } | undefined> {
  const rows = (await store.triggerSettings.get(ADAPTER)).filter((row) => row.scope === GITHUB_SCOPE);
  const open = (field: string): string | undefined => {
    const row = rows.find((r) => r.field === field);
    if (!row) return undefined;
    try {
      return unseal(sealKey, Buffer.from(row.sealed, "base64"), aad(field)).toString("utf8");
    } catch {
      return undefined;
    }
  };
  const appId = open(GITHUB_FIELDS.appId);
  const pem = open(GITHUB_FIELDS.privateKey);
  return appId && pem ? { appId, pem } : undefined;
}

/** The GitHub App access for one claim of a run whose first input is `firstInput` (run_launch's), or undefined when this
 *  server has no App the runner can open. Its mint goes to https://api.github.com (GITHUB_API): the App's JWT, signed
 *  with its key and good for every installation, goes nowhere else. `api` is a test runner's fake GitHub, given in the
 *  runner's own options (AdapterSpecDeps.githubApi); nothing kept, no environment variable and no flag reaches it.
 *  `fromGitHub`: the run's first input is a github trigger's firing (its launch's inputOrigin), whose payload tag names
 *  the repository and installation; any other run's tag is never read, only its owner's words. `hold`: each token minted
 *  joins the run's redactor (its `cut`), the first and every one after. */
export async function githubAppAccess(
  store: { readonly triggerSettings: Pick<TriggerSettings, "get"> },
  sealKey: Buffer | undefined,
  firstInput: unknown,
  { api = GITHUB_API, now = Date.now, fromGitHub = false, hold }: { api?: string; now?: () => number; fromGitHub?: boolean; hold?: (values: string[]) => void } = {},
): Promise<GithubAppAccessAt | undefined> {
  if (!sealKey) return undefined;
  const app = await appOf(store, sealKey);
  if (!app) return undefined;
  const target = githubTargetOf(isObject(firstInput) ? firstInput.content : firstInput, { payload: fromGitHub });
  return {
    api,
    target,
    // The App read again before each mint: one disconnected or replaced since the claim makes no token for this run.
    mint: async (to) => {
      // A read that fails throws on: the step's github_failed path keeps the token held until it expires, never a disconnect.
      const still = await appOf(store, sealKey);
      if (!still || still.appId !== app.appId || still.pem !== app.pem) return { ok: false, reason: "disconnected", message: "the GitHub App was disconnected or replaced on this server" };
      const minted = await mintInstallationToken(api, app.appId, app.pem, to, now());
      if (minted.ok) hold?.([minted.token]);
      return minted;
    },
    // Before each call: the App as the store holds it now, the same id and key, or the run's token stops.
    same: async () => {
      const still = await appOf(store, sealKey);
      return Boolean(still && still.appId === app.appId && still.pem === app.pem);
    },
    // An installation token revokes itself (DELETE /installation/token, the token its own credential): no App needed.
    revoke: async (token) => void (await githubCall(api, "/installation/token", { method: "DELETE", jwt: token }).catch(() => undefined)),
  };
}
