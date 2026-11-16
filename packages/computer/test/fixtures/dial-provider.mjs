// A conformance module for a dial host: createProvider() over the fake dial host (../fake-dial-host.mjs) and dialKit(),
// the server its machines dial, which the CLI passes to the run for provider.dial-token.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDialHost } from "../fake-dial-host.mjs";

const daemon = Buffer.from("a stand-in for computerd, linux/amd64\n");
const daemonPath = join(mkdtempSync(join(tmpdir(), "computer-dial-module-")), "computerd");
writeFileSync(daemonPath, daemon);
const dial = fakeDialHost({ daemon });

export function createProvider() {
	return dial.provider({ daemonPath });
}

export function dialKit() {
	return dial.kit();
}
