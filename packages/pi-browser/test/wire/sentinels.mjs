// The sentinel set is the package's shared test fake (src/testing); the wire check only adds what it scans: a session
// id is an identifier the model is given, not a secret.
import { hostRegistered, makeSentinels as make } from "@agentrun/pi-browser/testing";

export { hostRegistered };
export function makeSentinels() {
  const { bbSessionId: _id, ...secrets } = make();
  return secrets;
}

/** Where a sentinel may appear by design: the live view, and its own token, on the host channel. */
export const ALLOW = { bbLiveViewUrl: ["onSession"], bbLiveViewToken: ["onSession"], kernelLiveViewUrl: ["onSession"] };
