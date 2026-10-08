// Sentinel credentials: a random 32-byte value for every secret the design names, fresh per call, so a
// hit is never a coincidence. Composite secrets embed the atoms, the way real connect URLs do: a leaked URL is also a
// leaked signing key.
import { randomBytes } from "node:crypto";

const hex = () => randomBytes(32).toString("hex");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const base32 = () => Array.from(randomBytes(32), (b) => B32[b & 31]).join("");

export type Sentinels = {
  bbApiKey: string;
  bbSigningKey: string;
  bbSessionId: string;
  /** A Browserbase connect URL: carries the API key and the signing key. */
  bbConnectUrl: string;
  /** The live view's own token, inside its URL; allowed on the host channel only, like the URL. */
  bbLiveViewToken: string;
  /** Allowed on the host channel only. */
  bbLiveViewUrl: string;
  kernelApiKey: string;
  /** The CDP JWT inside `kernelCdpUrl`: a secret of its own, so a leak of the token alone is found. */
  kernelJwt: string;
  kernelCdpUrl: string;
  kernelLiveViewUrl: string;
  runToken: string;
  brokerCapability: string;
  loginUsername: string;
  loginPassword: string;
  totpSeed: string;
  vaultRef: string;
  /** Credentials a page URL carries in its query, and the URL that carries all three. */
  pageApiKey: string;
  pageSigningKey: string;
  pageToken: string;
  pageUrl: string;
};

export function makeSentinels(): Sentinels {
  const bbApiKey = `bb_live_${hex()}`;
  const bbSigningKey = hex();
  const bbSessionId = `bbs-${randomBytes(8).toString("hex")}`;
  const liveViewToken = hex();
  const kernelJwt = `eyJ${randomBytes(24).toString("base64url")}.${randomBytes(48).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
  const pageApiKey = hex();
  const pageSigningKey = hex();
  const pageToken = hex();
  return {
    bbApiKey,
    bbSigningKey,
    bbSessionId,
    bbConnectUrl: `wss://connect.browserbase.com/?apiKey=${bbApiKey}&signingKey=${bbSigningKey}&sessionId=${bbSessionId}`,
    bbLiveViewToken: liveViewToken,
    bbLiveViewUrl: `https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com/debug/${bbSessionId}/devtools/page/${liveViewToken}&token=${liveViewToken}`,
    kernelApiKey: `sk_kernel_${hex()}`,
    kernelJwt,
    kernelCdpUrl: `wss://kernel.sentinel.test/browser/cdp?jwt=${kernelJwt}`,
    kernelLiveViewUrl: `https://kernel.sentinel.test/live/${hex()}`,
    runToken: hex(),
    brokerCapability: hex(),
    loginUsername: `user-${randomBytes(8).toString("hex")}@sentinel.test`,
    loginPassword: `pw-${hex()}`,
    totpSeed: base32(),
    vaultRef: `vault://${hex()}`,
    pageApiKey,
    pageSigningKey,
    pageToken,
    pageUrl: `https://example.test/account?api_key=${pageApiKey}&signingKey=${pageSigningKey}&token=${pageToken}&page=2`,
  };
}

/** The exact values a host registers with `redact.values()`: never provider keys, which the shapes cover. */
export const hostRegistered = (s: Sentinels): string[] => [s.runToken, s.brokerCapability];
