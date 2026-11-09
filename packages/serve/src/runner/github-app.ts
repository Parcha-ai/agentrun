// The runner's side of a github_app MCP server (runner/mcp-github.ts): the server's GitHub App, read from the store at each
// claim, bound into the mint the claim step calls, with the run's repository. The App's id and private key are the rows the
// server sealed in trigger_settings (adapter "github", scope "server", AAD trigger_settings|github|server|<field>, as
// sealed-settings-store.ts writes them), opened here with the runner's seal key and held only in the bound mint's closure.
// No App (never connected, disconnected, or rows that do not open under this key): no access, and such a server's calls
// are refused in words (GITHUB_UNUSABLE.noAccess).
import { unseal } from "@parcha/pi-durable-agent";
import { GITHUB_API, GITHUB_FIELDS, GITHUB_SCOPE, githubTargetOf, mintInstallationToken } from "../github.js";
import type { TriggerSettings } from "../store/index.js";
import { isObject } from "../validate.js";
import type { GithubAppAccess } from "./mcp-github.js";

const ADAPTER = "github";
const aad = (field: string) => `trigger_settings|${ADAPTER}|${GITHUB_SCOPE}|${field}`;

/** The GitHub App access for one claim of a run whose first input is `firstInput` (run_launch's), or undefined when this
 *  server has no App the runner can open. `api`: GitHub's API (a test's fake). */
export async function githubAppAccess(
  store: { readonly triggerSettings: Pick<TriggerSettings, "get"> },
  sealKey: Buffer | undefined,
  firstInput: unknown,
  { api, now = Date.now }: { api?: string; now?: () => number } = {},
): Promise<GithubAppAccess | undefined> {
  if (!sealKey) return undefined;
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
  if (!appId || !pem) return undefined;
  const target = githubTargetOf(isObject(firstInput) ? firstInput.content : firstInput);
  // GitHub's API the App was made on (kept with it), else github.com's: a test's `api` first.
  const base = api ?? open(GITHUB_FIELDS.apiUrl) ?? GITHUB_API;
  return { mint: (to) => mintInstallationToken(base, appId, pem, to, now()), target };
}
