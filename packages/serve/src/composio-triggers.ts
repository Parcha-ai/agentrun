// The server's side of a Composio trigger's life at Composio (triggers.ts RemoteSource), over the tools plane's
// ComposioTriggers (trigger-composio.ts): a trigger turned on is an instance turned on at Composio, and one turned off or
// deleted lets its instance go. The first one made subscribes the project's one webhook to this server's
// /v2/hooks/composio, and its secret is sealed in the Composio source's settings (never shown); Composio needs the
// server's public address for that, so with none a Composio trigger is refused in words.
import { ApiError } from "./errors.js";
import type { SealedSettingsOverStore } from "./sealed-settings-store.js";
import { SERVER_SCOPE } from "./sealed-settings.js";
import { COMPOSIO_FIELDS, type ComposioTriggers } from "./trigger-composio.js";
import type { Source } from "./trigger-adapter.js";
import type { RemoteSource } from "./triggers.js";

/** Why a Composio trigger is refused on a server with no public address. */
export const COMPOSIO_NO_PUBLIC_URL = "Composio delivers each trigger event to this server's public address, and this server has none: set AGENTRUN_PUBLIC_URL to an https address Composio can reach, then make the trigger (or turn it on).";
/** Why a Composio trigger is refused on a server with no Composio connection. */
export const COMPOSIO_NOT_CONNECTED = "This server has no Composio connection: save a Composio API key in Settings, connect the account the trigger listens on, then make the trigger (or turn it on).";

/** A refusal Composio gave, in its words, as this server answers one: an ApiError as it is, anything else 424. */
const refusal = (error: unknown, doing: string): ApiError =>
  error instanceof ApiError ? error : new ApiError("upstream_failed", `Composio did not ${doing}: ${(error as Error)?.message ?? String(error)}`);

/** The Composio source's remote half: `face` the tools plane's, `settings` the source's sealed settings, `publicUrl` the
 *  server's address (none: refused). */
export function composioRemote(face: ComposioTriggers, settings: Pick<SealedSettingsOverStore, "get" | "set"> | undefined, publicUrl: string | undefined): RemoteSource {
  let subscribing: Promise<void> | undefined;
  /** The project's webhook delivering here, with its secret sealed: made once (and again when the address moved). */
  const subscribed = (): Promise<void> => {
    if (!publicUrl) throw new ApiError("composio_no_public_url", COMPOSIO_NO_PUBLIC_URL);
    if (!settings) throw new ApiError("composio_not_connected", COMPOSIO_NOT_CONNECTED);
    const url = `${publicUrl.replace(/\/+$/, "")}/v2/hooks/composio`;
    const field = (name: string) => settings.get(SERVER_SCOPE, name);
    if (field(COMPOSIO_FIELDS.secret) && field(COMPOSIO_FIELDS.url) === url && field(COMPOSIO_FIELDS.userId) === face.userId) return Promise.resolve();
    // One subscribe at a time: two triggers made at once share it, and neither seals a secret the other's call replaced.
    subscribing ??= (async () => {
      const { secret } = await face.webhook(url).catch((error: unknown) => {
        throw refusal(error, "subscribe this server's hook");
      });
      await settings.set(SERVER_SCOPE, COMPOSIO_FIELDS.secret, secret);
      await settings.set(SERVER_SCOPE, COMPOSIO_FIELDS.userId, face.userId);
      await settings.set(SERVER_SCOPE, COMPOSIO_FIELDS.url, url);
    })().finally(() => (subscribing = undefined));
    return subscribing;
  };
  return {
    async attach(source: Source) {
      await subscribed();
      const config = (source.config as Record<string, unknown> | undefined) ?? {};
      const { instanceRef } = await face.enable(source.trigger_slug as string, config, source.connection_ref as string).catch((error: unknown) => {
        throw refusal(error, `turn on ${String(source.trigger_slug)} for ${String(source.connection_ref)}`);
      });
      return { ...source, instance_ref: instanceRef };
    },
    async detach(source: Source) {
      await face.disable(source.instance_ref as string);
    },
  };
}
