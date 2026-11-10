// The server's own secrets as one redaction list, over the one store, the store-backed replacement for openServerSecrets
// (server-secrets.ts). What changes from the file version: each trigger source's sealed settings are store rows
// (sealed-settings-store.ts, store.triggerSettings), not per-adapter files; the deleted per-run door token (.door-token) is
// no longer a source. What stays a file: the owner's API token (.token, the CLI reads it) and the sign-in session secret,
// which the cutover keeps beside the store. The list is still
// the one the server never shows (server.ts serverSecrets): what a run shows, what learning keeps and what the server
// answers are cut of it. The outbound webhook's secret is a store row too (webhooks.ts), with an earlier version's file read
// for an import.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOKEN_FILE } from "./files.js";
import { SESSION_SECRET_FILE } from "./owner.js";
import { sealedSettingsOverStore, type SealedSettingsOverStore } from "./sealed-settings-store.js";
import { ServerSecrets } from "./server-secrets.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import type { TriggerAdapter } from "./trigger-adapter.js";
import { WEBHOOK_CHANNEL, WEBHOOK_SECRET_SPEC, webhookSecretIn } from "./webhooks.js";
import type { TriggerSettings } from "./store/index.js";

/** The store slice this layer needs (handed to each adapter's sealed settings). */
type ServerSecretsStore = { readonly triggerSettings: Pick<TriggerSettings, "get" | "put" | "removeScope">; flush(): Promise<void> };

/** The file `name` in `data`, trimmed; empty when it is not there. */
const fileIn = (data: string, name: string): string => {
  try {
    return readFileSync(join(data, name), "utf8").trim();
  } catch {
    return "";
  }
};

/** The server's own secrets over the store: the owner's token and the session secret (still files beside the store), the
 *  outbound webhook's secret, and every adapter's sealed settings (now store rows), which are returned too, by adapter id,
 *  for the server to keep using. Loads each adapter's settings before it answers (awaited once at start), so the redaction
 *  list is whole from the first use. A value that does not open is said to `say`. */
export async function openServerSecretsOverStore(
  store: ServerSecretsStore,
  data: string,
  env: NodeJS.ProcessEnv,
  adapters: readonly TriggerAdapter[],
  say: (fields: Record<string, string>) => void = () => {},
): Promise<{ secrets: ServerSecrets; settings: Map<string, SealedSettingsOverStore> }> {
  const secrets = new ServerSecrets();
  // Each read until it is there, then kept: they are made once, and a redaction reads the list often.
  const read = new Map<string, string>();
  const kept = (name: string) => read.get(name) || (read.set(name, fileIn(data, name)), read.get(name)!);
  // The owner's API token and the sign-in session secret stay files beside the store; the per-run door token is gone.
  secrets.add("files", () => [kept(TOKEN_FILE), kept(SESSION_SECRET_FILE)]);
  // The server always has its seal key (seal-key.ts ensureSealKey, at its start): no setting is ever kept in the clear.
  const key = sealKeyOf(env[SEAL_KEY_ENV]);
  if (!key) throw new Error(`the server starts with its seal key (${SEAL_KEY_ENV}), made at the first start when none is handed over`);
  // The outbound webhook's secret, and each it held before, kept in the store (webhooks.ts); and one an earlier version
  // kept in its file, for an import of that version's data.
  // Its secret not opening under this seal key is said in the webhook's own words, naming the data directory.
  const webhookSettings = sealedSettingsOverStore(store, WEBHOOK_CHANNEL, WEBHOOK_SECRET_SPEC, key, (fields) =>
    fields.condition === "trigger_setting_unopened" ? say({ condition: "unreadable", name: SEAL_KEY_ENV, data, effect: "this server's webhook secret cannot be read under this seal key, so it is not cut" }) : say(fields),
  );
  await webhookSettings.load();
  const earlier = webhookSecretIn(data, env);
  secrets.add("webhook", () => [...webhookSettings.values(), ...(earlier && "secret" in earlier ? [earlier.secret] : [])]);
  const settings = new Map<string, SealedSettingsOverStore>();
  for (const adapter of adapters) {
    if (!adapter.settings) continue;
    const adapterSettings = sealedSettingsOverStore(store, adapter.id, adapter.settings, key, say);
    await adapterSettings.load();
    settings.set(adapter.id, adapterSettings);
    secrets.add(`trigger-settings:${adapter.id}`, () => adapterSettings.values());
    // A PEM key's lines, its short last one too, and the key whole: listed with no floor.
    secrets.add(`trigger-settings-pem:${adapter.id}`, () => adapterSettings.pemValues(), { whole: true });
  }
  return { secrets, settings };
}
