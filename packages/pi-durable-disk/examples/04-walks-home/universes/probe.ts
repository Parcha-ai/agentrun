// The machine's description for the env.switch notice (03-tab-to-cloud host-probe.ts), taken once when the machine is
// warmed and printed as JSON, so the takeover's critical path reads a file instead of spawning a dozen probes.
import { probeHost } from "../../03-tab-to-cloud/host-probe.ts";

process.stdout.write(`${JSON.stringify(await probeHost())}\n`);
