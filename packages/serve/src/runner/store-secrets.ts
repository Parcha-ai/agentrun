// Every secret the server keeps sealed, opened with the runner's seal key at each claim, for the run's one redactor
// (redact.ts HeldRedact): the runner's write-time cut (the secrets decision's rule three: no journal entry or row a run
// writes carries a secret value) holds its environment's secrets and all of these, not only the keys a claim hands its
// run (claim-secrets.ts). A run's text may quote a server secret it was never handed: a person pastes it, a provider
// echoes it back. One read of the store across all its planes (store.sealedSecrets): tool, model, computer and Archil keys,
// the email account's password alone (its row holds the account whole), and the ChatGPT sign-in's access and refresh tokens each alone, renewed by whichever process holds the store (sealed_keys); MCP credentials, their headers' values and OAuth tokens and client secret (mcp_servers), and a sign-in in
// flight (mcp_oauth_pending); each trigger source's settings, a webhook trigger's signing secret and the GitHub App's key
// and webhook secret among them, and the outbound webhook's signing secret, each it held before too (trigger_settings),
// but a field its source marks public; browser sign-in pointers, live and forgotten; live viewer tokens; a launch's sealed
// part (a run's handed MCP credentials and its own model key). Beside the store, what the data directory keeps where the runner shares it (server-secrets.ts besideTheStore: the
// owner's API token and the sign-in session secret). Each value in every spelling the server's list has
// (standard-webhooks.ts secretForms), a PEM key whole and line by line. A value that does not open under the runner's key
// is left out: the store never holds one in the clear, and nothing of this runner can be handed it.
import { CHATGPT_PLAN_ROW } from "../chatgpt-plan.js";
import { calendarRowSecrets } from "../calendar/address.js";
import { CALENDAR_ROW } from "../calendar/names.js";
import { accountRowSecrets, EMAIL_ACCOUNT_ROW } from "../email/account.js";
import { unseal } from "../sealing.js";
import { besideTheStore, ServerSecrets } from "../server-secrets.js";
import type { SealedSecretRow, Store } from "../store/index.js";
import type { TriggerAdapter } from "../trigger-adapter.js";
import { TRIGGER_ADAPTERS } from "../trigger-adapters.js";
import type { HeldRedact } from "./redact.js";

/** The store slice the read needs. */
export type StoreSecretsStore = Pick<Store, "sealedSecrets">;

/** The keys of a sealed JSON value that hold secrets: OAuth tokens, a client's secret, a PKCE verifier. */
const JSON_SECRETS = ["access_token", "refresh_token", "id_token", "client_secret", "verifier"];

/** The secret strings of an opened JSON value: each header's value (a bearer's token alone too), and every string under
 *  one of JSON_SECRETS, wherever it is nested. */
function jsonSecrets(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [text];
  }
  const out: string[] = [];
  const walk = (node: unknown, key?: string): void => {
    if (typeof node === "string") {
      if (key !== undefined && JSON_SECRETS.includes(key)) out.push(node);
      return;
    }
    if (node && typeof node === "object") for (const [inner, child] of Object.entries(node)) walk(child, inner);
  };
  const headers = (value as { headers?: unknown } | null)?.headers;
  if (headers && typeof headers === "object") {
    for (const header of Object.values(headers as Record<string, unknown>)) {
      if (typeof header !== "string") continue;
      out.push(header);
      const bearer = /^Bearer\s+(.+)$/i.exec(header);
      if (bearer) out.push(bearer[1]!);
    }
  }
  walk(value);
  return out;
}

/** A launch's sealed JSON: its own listed values (jsonSecrets), each handed MCP credential's headers (store/seal.ts
 *  sealRunLaunch: `{"mcp": {"<server>": {"headers": {...}}}}`), as a saved server's are listed, and the run's own model
 *  key (`{"model": {"key": "..."}}`). */
function launchSecrets(text: string): string[] {
  const out = jsonSecrets(text);
  let opened: { mcp?: unknown; model?: { key?: unknown } } | null;
  try {
    opened = JSON.parse(text) as typeof opened;
  } catch {
    return out;
  }
  const mcp = opened?.mcp;
  if (mcp && typeof mcp === "object") for (const entry of Object.values(mcp)) out.push(...jsonSecrets(JSON.stringify(entry)));
  if (typeof opened?.model?.key === "string") out.push(opened.model.key);
  return out;
}

/** The ChatGPT sign-in's sealed row (chatgpt-plan.ts): its access and refresh tokens, each alone, as a renewal in any
 *  process that holds the store writes them; the row's JSON whole beside them. */
function planSecrets(text: string): string[] {
  try {
    const credential = (JSON.parse(text) as { credential?: { access?: unknown; refresh?: unknown } } | null)?.credential;
    return [text, ...[credential?.access, credential?.refresh].filter((token): token is string => typeof token === "string")];
  } catch {
    return [text];
  }
}

/** A PEM key whole, and each of its base64 lines (the short last one too), as the server lists one (sealed-settings-store.ts). */
const pemForms = (value: string): string[] => [value, ...value.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("-----"))];

/** What of one opened sealed value is a secret to hold, by its plane: `listed` with the server list's floor and spellings,
 *  `whole` as it is (a PEM key's lines). */
function secretsOf(row: SealedSecretRow, plain: string, adapters: readonly TriggerAdapter[]): { listed: string[]; whole: string[] } {
  switch (row.plane) {
    case "trigger_settings": {
      const spec = adapters.find((adapter) => adapter.id === row.where.adapter)?.settings?.fields[row.where.field ?? ""];
      if (spec?.public) return { listed: [], whole: [] };
      return spec?.format === "pem" ? { listed: [], whole: pemForms(plain) } : { listed: [plain], whole: [] };
    }
    case "mcp_servers":
    case "mcp_oauth_pending":
      return { listed: jsonSecrets(plain), whole: [] };
    case "run_launch":
      return { listed: plain.trimStart().startsWith("{") ? launchSecrets(plain) : [plain], whole: [] };
    case "sealed_keys":
      return { listed: row.where.name === CHATGPT_PLAN_ROW ? planSecrets(plain) : row.where.name === EMAIL_ACCOUNT_ROW ? accountRowSecrets(plain) : row.where.name === CALENDAR_ROW ? calendarRowSecrets(plain) : [plain], whole: [] };
    default:
      return { listed: [plain], whole: [] };
  }
}

/** Every secret the server keeps sealed that `sealKey` opens: the store's (one read across its planes) and, where the runner
 *  shares the server's data directory `data`, what it keeps beside the store. With no key (a run's own process, which
 *  never holds the server's secrets, so has none of them to write), none: its runner cuts what crosses to it from what
 *  the runner holds (run-child-host.ts). */
export async function storeSecrets(store: StoreSecretsStore, sealKey: Buffer | undefined, data?: string, adapters: readonly TriggerAdapter[] = TRIGGER_ADAPTERS): Promise<string[]> {
  if (!sealKey) return [];
  const listed: string[] = [];
  const whole: string[] = [];
  for (const row of await store.sealedSecrets.all()) {
    let plain: string;
    try {
      plain = unseal(sealKey, Buffer.from(row.sealed), row.aad).toString("utf8");
    } catch {
      continue;
    }
    const found = secretsOf(row, plain, adapters);
    listed.push(...found.listed);
    whole.push(...found.whole);
  }
  const list = new ServerSecrets();
  list.add("store", () => listed);
  list.add("store-whole", () => whole, { whole: true });
  const beside = data ? besideTheStore(data).values() : [];
  return [...list.values(), ...beside];
}

/** The server's sealed secrets (storeSecrets) held by `redact`, the run's one redactor, before any of the run's text is
 *  written. */
export async function holdStored(redact: HeldRedact, store: StoreSecretsStore, sealKey: Buffer | undefined, data?: string): Promise<void> {
  redact.hold(await storeSecrets(store, sealKey, data));
}
