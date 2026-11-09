// The server's own secrets, as one list: its API token, its door token, its sign-in sessions' secret, its outbound
// webhook's signing secret, and every value a trigger source keeps sealed (sealed-settings.ts). Each store adds itself
// when it opens, as a reader, so a secret made or rotated since is in the list at once. With the host's, they are the one
// list a server never shows (server.ts serverSecrets): what a run shows (runs.ts), what learning keeps (learning-run.ts),
// what the server answers and the VM relay's errors are cut of it, and what an import writes (import.ts) of these; none
// of them assembles its own.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_FILE } from "./files.js";
import { SESSION_SECRET_FILE } from "./owner.js";
import { SealedSettings } from "./sealed-settings.js";
import { secretForms } from "./standard-webhooks.js";
import type { TriggerAdapter } from "./trigger-adapter.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import { webhookSecretIn } from "./webhooks.js";

export class ServerSecrets {
  private readonly sources = new Map<string, () => readonly string[]>();

  /** A store's secrets, read at each use; one added again under the same name takes its place. */
  add(name: string, read: () => readonly string[]): void {
    this.sources.set(name, read);
  }

  /** Every secret held now, once each: of 8 characters or more and no whitespace, so no word is cut as one. A signing
   *  secret's key, after `whsec_`, signs alone and is pasted alone, which its `whsec_` form never matches: each is listed
   *  in every spelling of it (standard-webhooks.ts secretForms). */
  values(): string[] {
    const all = [...this.sources.values()].flatMap((read) => read()).flatMap(secretForms);
    return [...new Set(all)].filter((value) => value.length >= 8 && !/\s/.test(value));
  }
}

/** The file `name` in `data`, trimmed; empty when it is not there. */
const fileIn = (data: string, name: string): string => {
  try {
    return readFileSync(join(data, name), "utf8").trim();
  } catch {
    return "";
  }
};

/** The server's own secrets data directory `data` keeps, each store opened with the seal key of `env`: the tokens' and
 *  the session secret's files, the outbound webhook's secret, and every adapter's sealed settings (a value that does not
 *  open is said to `say`), which are returned too, by adapter id, for the server to keep using. */
export function openServerSecrets(data: string, env: NodeJS.ProcessEnv, adapters: readonly TriggerAdapter[], say: (fields: Record<string, string>) => void = () => {}): { secrets: ServerSecrets; settings: Map<string, SealedSettings> } {
  const secrets = new ServerSecrets();
  // Each read until it is there, then kept: they are made once, and a redaction reads the list often.
  const read = new Map<string, string>();
  const kept = (name: string) => read.get(name) || (read.set(name, fileIn(data, name)), read.get(name)!);
  secrets.add("files", () => [kept(TOKEN_FILE), kept(SESSION_SECRET_FILE)]);
  const webhook = webhookSecretIn(data, env);
  secrets.add("webhook", () => (webhook && "secret" in webhook ? [webhook.secret] : []));
  // Where a webhook trigger's secret was kept before its source's sealed settings were: no longer read.
  const leftover = join(data, "trigger-secrets.json");
  if (existsSync(leftover)) say({ condition: "trigger_secrets_left_over", file: leftover, effect: "not read: give each webhook trigger made before a new secret with POST /v2/triggers/{id}/secret, or make it again" });
  const key = sealKeyOf(env[SEAL_KEY_ENV]);
  const settings = new Map<string, SealedSettings>();
  for (const adapter of adapters) {
    if (!adapter.settings) continue;
    const store = new SealedSettings(data, adapter.id, adapter.settings, key, say);
    settings.set(adapter.id, store);
    secrets.add(`trigger-settings:${adapter.id}`, () => store.values());
  }
  return { secrets, settings };
}
