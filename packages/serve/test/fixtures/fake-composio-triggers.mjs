// A stand-in for the tools plane's Composio trigger half (trigger-composio.ts ComposioTriggers), with no network: it
// hands back a webhook secret as Composio's subscription does, turns instances on and off, and keeps every call, so a
// test reads what the trigger plane asked of Composio. `refuse`: the next enable's refusal, thrown once.
import { createHmac, randomBytes } from "node:crypto";

export const COMPOSIO_USER = "agentrun-server-test";

export function fakeComposioTriggers({ userId = COMPOSIO_USER } = {}) {
  const calls = [];
  const instances = new Map();
  let secret;
  let next = 0;
  const face = {
    userId,
    calls,
    instances,
    get secret() {
      return secret;
    },
    refuse: undefined,
    async webhook(url, options = {}) {
      calls.push(["webhook", url, options]);
      // Composio's secret is a string the receiver keys its HMAC with as UTF-8 (its docs' sample code), not whsec_ base64.
      if (!secret || options.rotate) secret = `not-a-secret-${randomBytes(18).toString("hex")}`;
      return { secret };
    },
    async enable(slug, config, connectionRef) {
      calls.push(["enable", slug, config, connectionRef]);
      if (face.refuse) {
        const error = face.refuse;
        face.refuse = undefined;
        throw error;
      }
      const instanceRef = `ti_${String(++next).padStart(4, "0")}`;
      instances.set(instanceRef, { slug, config, connectionRef, on: true });
      return { instanceRef };
    },
    async disable(instanceRef) {
      calls.push(["disable", instanceRef]);
      const instance = instances.get(instanceRef);
      if (instance) instance.on = false;
    },
  };
  return face;
}

/** A V3 trigger event as Composio sends it, signed as Composio signs it (`{id}.{timestamp}.{body}`, HMAC-SHA256 under the
 *  secret's UTF-8 bytes, base64, `v1,<signature>`). */
export function composioEvent({ secret, instance, slug = "SLACK_CHANNEL_MESSAGE_RECEIVED", data = {}, userId = COMPOSIO_USER, id = `msg_${randomBytes(8).toString("hex")}`, envelopeId = id, timestamp = Math.floor(Date.now() / 1000), signWith, version = "V3" }) {
  const doc = version === "V3"
    ? { id: envelopeId, type: "composio.trigger.message", metadata: { log_id: "log_test", trigger_slug: slug, trigger_id: instance, connected_account_id: "ca_test", auth_config_id: "ac_test", user_id: userId }, data, timestamp: new Date(timestamp * 1000).toISOString() }
    : { type: slug.toLowerCase(), data: { ...data, trigger_id: instance, user_id: userId }, log_id: "log_test" };
  const body = JSON.stringify(doc);
  const signature = signWith ? signWith(id, String(timestamp), body) : `v1,${createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
  return { body, headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": signature } };
}
