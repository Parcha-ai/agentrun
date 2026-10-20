// The process under test in observer_robustness.test.mjs: it talks to a fake CDP endpoint that sends garbage frames, and prints ALIVE
// if it is still running afterwards.
import { EffectObserver } from "@parcha/pi-browser";
import { cdpCall } from "../dist/providers/cdp-call.js";
import { stagehandDriver } from "../dist/driver/stagehand.js";

const [mode, url] = process.argv.slice(2);
const done = (note) => { console.log(`ALIVE ${note}`); process.exit(0); };
if (mode === "observer") {
  const observer = await EffectObserver.open({ sdkCdpUrl: url }, null);
  await observer.flush();
  await new Promise((r) => setTimeout(r, 500));
  observer.close();
  done("observer");
} else if (mode === "cdpcall") {
  // A rejection (a lost reply, a timeout) ends this child non-zero: the call must still read the reply that follows the bad frames.
  const session = await cdpCall(url, "Browser.getVersion", {}, 5_000);
  if (typeof session.result !== "object" || session.result === null) throw new Error("cdpCall returned no result");
  session.close();
  await new Promise((r) => setTimeout(r, 300));
  done("cdpcall");
} else {
  const abort = AbortSignal.timeout(6_000);
  const driver = await stagehandDriver()({ sdkCdpUrl: url }, abort).catch((error) => ({ failed: String(error?.message ?? error) }));
  await new Promise((r) => setTimeout(r, 300));
  done(`stagehand ${driver?.failed ? "refused" : "attached"}`);
}
