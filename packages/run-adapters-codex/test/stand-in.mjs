// The stand-in for Codex's app-server (fake-app-server.mjs), as a test elsewhere stages it in a directory of its own,
// copied whole, so the copy runs as the original does.
import { copyFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** The stand-in itself, to run in place. */
export const STAND_IN = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));

/** Copies the stand-in to `to`. */
export async function copyStandIn(to) {
  await copyFile(STAND_IN, to);
}

/** copyStandIn, synchronously. */
export function copyStandInSync(to) {
  copyFileSync(STAND_IN, to);
}
