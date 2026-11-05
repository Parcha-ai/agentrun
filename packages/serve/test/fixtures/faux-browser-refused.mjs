// The `browser` tool's provider for the tests, refusing its credential: every session it is asked to open is answered
// with the provider's 401, as Browserbase answers a key it does not take. No network and no key.
import { FakeBackend, fakeDriver } from "@parcha/pi-browser/testing";

export default function browser() {
  const backend = new FakeBackend({ start: "https://example.test/" });
  const refusal = () => Object.assign(new Error("401 Unauthorized"), { status: 401 });
  const provider = { ...backend.provider, create: async () => { throw refusal(); } };
  return { provider, driver: fakeDriver(backend) };
}
