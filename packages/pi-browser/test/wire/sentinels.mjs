// A session id is an identifier the model is given, not a secret.
import { hostRegistered, makeSentinels as make } from "@parcha/pi-browser/testing";

export { hostRegistered };
export function makeSentinels() {
  const { bbSessionId: _id, ...secrets } = make();
  return secrets;
}

export const ALLOW = { bbLiveViewUrl: ["onSession"], bbLiveViewToken: ["onSession"], kernelLiveViewUrl: ["onSession"] };
