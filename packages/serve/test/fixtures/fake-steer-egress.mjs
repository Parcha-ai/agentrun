// The network a local Chrome's egress proxy sees in browser-chrome-egress.test.mjs (startServe's `fauxEgress`, under
// `--faux`; box-egress.ts): STEER_HOST answers with a public address, and its dial reaches the test's steering page on
// this machine (STEER_PORT); REBIND_HOST answers with a private one, as a name a page's owner points inward would;
// `localhost` answers as this machine's resolver does. Every other name is not found. The proxy's address rule is the
// real one: it judges each answer, an IP literal by its bytes, before any dial, so a dial to anything but STEER_HOST's
// address is a refusal that did not happen, and fails.
import { connect, Socket } from "node:net";

export const STEER_HOST = "steer.example";
export const REBIND_HOST = "rebind.example";
/** A public address (a public resolver's), never dialled: its dial goes to the steering page. */
export const STEER_ADDRESS = "1.1.1.1";
const LOOPBACK = "127.0.0.1"; // key-gate: loopback-rule what localhost answers, and where the steering page listens
const INWARD = "10.20.30.40"; // key-gate: denylist the private answer a rebinding name gives, which the proxy must refuse
const NAMES = { [STEER_HOST]: STEER_ADDRESS, [REBIND_HOST]: INWARD, localhost: LOOPBACK };

export default function steerEgress() {
  return {
    lookup: (host, _options, callback) => {
      const address = NAMES[host];
      if (!address) return process.nextTick(callback, Object.assign(new Error(`${host} not found`), { code: "ENOTFOUND" }));
      process.nextTick(callback, null, [{ address, family: 4 }]);
    },
    dial: (address, port) => {
      if (address === STEER_ADDRESS) return connect({ host: LOOPBACK, port: Number(process.env.STEER_PORT) });
      const refused = new Socket();
      process.nextTick(() => refused.destroy(new Error(`the proxy dialled ${address}:${port}, which it should have refused`)));
      return refused;
    },
  };
}
