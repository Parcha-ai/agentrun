// The server's own secrets as one redaction list, over the one store: each trigger source's sealed settings and the
// outbound webhook's signing secret are store rows (sealed-settings-store.ts, store.triggerSettings; the webhook's under
// adapter webhook-out, webhooks.ts); the owner's API token (.token, the CLI reads it) and the sign-in session secret stay
// beside the store (server-secrets.ts besideTheStore). The list is the one the server never shows (server.ts
// serverSecrets): what a run shows, what learning keeps and what the server answers are cut of it.
import { sealedSettingsOverStore, type SealedSettingsOverStore } from "./sealed-settings-store.js";
import { besideTheStore, type ServerSecrets } from "./server-secrets.js";
import { SEAL_KEY_ENV, sealKeyOf } from "./tool-keys.js";
import type { TriggerAdapter } from "./trigger-adapter.js";
import { WEBHOOK_CHANNEL, WEBHOOK_SECRET_SPEC } from "./webhooks.js";
import type { TriggerSettings } from "./store/index.js";

/** The store slice this layer needs (handed to each adapter's sealed settings). */
type ServerSecretsStore = { readonly triggerSettings: Pick<TriggerSettings, "get" | "put" | "removeScope">; flush(): Promise<void> };

/** The server's own secrets over the store: what it keeps beside the store (besideTheStore), the outbound webhook's
 *  signing secret and each one it held before (adapter webhook-out, retired ones too, so a secret replaced or removed stays
 *  on the list across restarts), and every adapter's sealed settings, store rows, which are returned too, by id, for the
 *  server to keep using. Loads each adapter's settings before it answers (awaited once at start), so the redaction
 *  list is whole from the first use. A value that does not open is said to `say`. */
export async function openServerSecretsOverStore(
  store: ServerSecretsStore,
  data: string,
  env: NodeJS.ProcessEnv,
  adapters: readonly Pick<TriggerAdapter, "id" | "settings">[],
  say: (fields: Record<string, string>) => void = () => {},
): Promise<{ secrets: ServerSecrets; settings: Map<string, SealedSettingsOverStore> }> {
  // The server always has its seal key (seal-key.ts bootSealKey, at its start): no setting is ever kept in the clear.
  const key = sealKeyOf(env[SEAL_KEY_ENV]);
  if (!key) throw new Error(`the server starts with its seal key (${SEAL_KEY_ENV}), made at the first start when none is handed over`);
  const secrets = besideTheStore(data);
  // The outbound webhook's secret, and each it held before, kept in the store (webhooks.ts). Its secret not opening under
  // this seal key is said in the webhook's own words, naming the data directory.
  const webhookSettings = sealedSettingsOverStore(store, WEBHOOK_CHANNEL, WEBHOOK_SECRET_SPEC, key, (fields) =>
    fields.condition === "trigger_setting_unopened" ? say({ condition: "unreadable", name: SEAL_KEY_ENV, data, effect: "this server's webhook secret cannot be read under this seal key, so it is not cut" }) : say(fields),
  );
  await webhookSettings.load();
  secrets.add("webhook", () => webhookSettings.values());
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
