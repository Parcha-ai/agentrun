// Who sees a signing secret this server mints: a webhook trigger's (POST /triggers, POST /triggers/{id}/secret) and the
// outbound webhook's (the first PUT /settings/webhook). Each is shown once, as `signing_secret`, and only to a caller that
// may write secrets (secret-writes.ts, the owner's signed-in session): the console's Triggers and Settings → Webhook
// screens. The API token, which a run's process, an agent's MCP client or a script may hold, gets what it made with the
// secret's metadata (`secret`, the one SecretMeta shape) and the words that send the person to the console for it.
// Rotating a trigger's secret is a secret write: the token is refused it in the secret-write words, at the one check in
// the server's dispatch.
import { registerSecretWrite, type SecretMeta, secretMeta, secretName } from "./secret-writes.js";
import type { TriggerAdapter } from "./trigger-adapter.js";

// Replacing a trigger's secret, and removing the outbound webhook (its secret goes with it), are secret writes. A trigger's
// create and the outbound webhook's first save mint one and write none the caller gave: the token may make them, and is
// shown no value.
registerSecretWrite("rotateTriggerSecret", () => true);
registerSecretWrite("deleteWebhook", () => true);

/** What the token's answer says of a webhook trigger's secret, made and kept but not shown to it. */
export const TRIGGER_SECRET_WORDS = "Open the console to see this trigger's signing secret once: rotate it there.";
/** What the token's answer says of the outbound webhook's secret: the console shows a new one when the webhook is removed
 *  and set again (it has no rotation of its own). */
export const WEBHOOK_SECRET_WORDS = "Open the console to see this webhook's signing secret once: remove it and save it again there.";

/** A webhook trigger's minted secret's metadata, named trigger:<id>: made by this server at a console's or a script's
 *  request (source console). `changedAt`: when it was made, where known (its create's or rotation's answer); its row
 *  keeps no time yet, so a read says null. */
export const triggerSecretMeta = (id: string, set: boolean, changedAt: string | null = null): SecretMeta => secretMeta(secretName("trigger", id), { set, source: "console", changedAt });

/** POST /triggers' first answer, for a trigger that minted `minted` (none for a schedule's) at `at`: its `secret`
 *  metadata, and the value as `signing_secret` to a caller that may hold it, else secret_set and the words. `made` is the
 *  trigger's view. */
export function triggerMade(made: Record<string, unknown>, minted: string | undefined, mayHold: boolean, at: string): Record<string, unknown> {
  if (minted === undefined) return made;
  const secret = triggerSecretMeta(String(made.id), true, at);
  return mayHold ? { ...made, secret, signing_secret: minted } : { ...made, secret, secret_set: true, note: TRIGGER_SECRET_WORDS };
}

/** POST /triggers/{id}/secret's answer (the owner's session alone reaches it): the new value, and its metadata. */
export const triggerRotated = (id: string, minted: string, at: string) => ({ secret: triggerSecretMeta(id, true, at), signing_secret: minted });

/** A template's apply answer's warning for its webhook trigger `i`: its secret is in no apply answer (the Idempotency-Key
 *  record would keep it), so the person gets it from the console. */
export const templateTriggerSecret = (i: number) => ({ field: `triggers.${i}.secret`, reason: "not_allowed" as const, message: `This webhook trigger's signing secret is not in an apply answer. ${TRIGGER_SECRET_WORDS}` });

/** The outbound webhook's secret's metadata, named webhook:outbound: set or not, made by this server at a save (source
 *  console), and when. */
export const webhookSecretMeta = (set: boolean, changedAt: string | null): SecretMeta => secretMeta(secretName("webhook", "outbound"), { set, source: "console", changedAt });

/** PUT /settings/webhook's answer: the minted value (the first save's) as `signing_secret` to a caller that may hold it,
 *  else the words. `view` carries the `secret` metadata already. */
export function webhookSaved(view: Record<string, unknown>, minted: string | undefined, mayHold: boolean): Record<string, unknown> {
  if (minted === undefined) return view;
  return mayHold ? { ...view, signing_secret: minted } : { ...view, note: WEBHOOK_SECRET_WORDS };
}

/** The field an adapter mints for each of its triggers (a webhook's `secret`), if it mints one. */
const mintedField = (adapter: TriggerAdapter | undefined): string | undefined =>
  adapter?.settings?.scope === "trigger" ? Object.entries(adapter.settings.fields).find(([, field]) => field.mint)?.[0] : undefined;

/** What a trigger's view says of a secret its sealed settings keep but that does not open here (sealed under another seal
 *  key): unset, and why. */
export const TRIGGER_SECRET_UNOPENED = "Its signing secret does not open under this server's seal key: rotate it in the console.";

/** Where a trigger's minted secret stands here: held and open, kept but not opening under this seal key, or none. */
export type SecretHeld = "set" | "unopened" | "unset";

/** A trigger's view with its minted secret's metadata (GET and list): `secret` for a trigger whose source's adapter mints
 *  one, set when its sealed settings hold it open here; one kept that does not open adds `note`, the words for why. A
 *  trigger that mints none is answered as it is. */
export function withTriggerSecret<T extends { id: string; source: { kind: string } }>(view: T, adapters: readonly TriggerAdapter[], held: (adapterId: string, scope: string, field: string) => SecretHeld): T | (T & { secret: SecretMeta; note?: string }) {
  const adapter = adapters.find((one) => one.id === view.source.kind);
  const field = mintedField(adapter);
  if (field === undefined) return view;
  const state = held(adapter!.id, view.id, field);
  return { ...view, secret: triggerSecretMeta(view.id, state === "set"), ...(state === "unopened" ? { note: TRIGGER_SECRET_UNOPENED } : {}) };
}

/** The words a replayed apply says of each webhook trigger it made: its secret was in the first answer alone. */
export const TEMPLATE_SECRET_SHOWN = "Its signing secret was shown once, in this apply's first answer; rotate it in the console for a new one.";

/** An apply's webhook triggers as its answer keeps them (the Idempotency-Key's record): each one's id and its secret's
 *  metadata, never a value. None when it made no webhook trigger. */
export const templateWebhookSecrets = (ids: readonly string[], at: string) => (ids.length ? { webhook_secrets: ids.map((id) => ({ trigger_id: id, secret: triggerSecretMeta(id, true, at) })) } : {});

/** An apply's answer as this caller reads it: the first answer to a caller that may hold secrets shows each webhook
 *  trigger's `signing_secret` (`minted`, by trigger id), once; a token's answer, or a replay, says secret_set and its
 *  words in each one's place. `body` is the record's. */
export function templateApplied(body: Record<string, unknown>, minted: ReadonlyMap<string, string>, shown: "first" | "token" | "replay"): Record<string, unknown> {
  const made = body.webhook_secrets as { trigger_id: string; secret: unknown }[] | undefined;
  if (!made) return body;
  const said = (one: { trigger_id: string; secret: unknown }) =>
    shown === "first" && minted.has(one.trigger_id) ? { ...one, signing_secret: minted.get(one.trigger_id)! } : { ...one, secret_set: true as const, note: shown === "replay" ? TEMPLATE_SECRET_SHOWN : TRIGGER_SECRET_WORDS };
  // The answer that shows every secret drops the warnings saying it is not shown (templateTriggerSecret's): they would
  // sit right above the secret they say is missing. A token's answer or a replay keeps them.
  const showsAll = shown === "first" && made.every((one) => minted.has(one.trigger_id));
  const warnings = showsAll && Array.isArray(body.warnings) ? { warnings: (body.warnings as { field?: unknown }[]).filter((w) => !/^triggers\.\d+\.secret$/.test(String(w.field))) } : {};
  return { ...body, ...warnings, webhook_secrets: made.map(said) };
}
