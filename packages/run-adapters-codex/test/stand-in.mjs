// The stand-in for Codex's app-server (fake-app-server.mjs), as a test elsewhere stages it in a directory of its own: the
// stand-in and the files beside it that it imports (its companions), copied whole, so the copy runs as the original does.
import { copyFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The stand-in itself, to run in place. */
export const STAND_IN = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
/** The files the stand-in imports from beside it, by name. */
const COMPANIONS = ['fake-app-server-mcp.js'];
const here = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

/** Copies the stand-in to `to`, and its companions beside it under their own names. */
export async function copyStandIn(to) {
  await copyFile(STAND_IN, to);
  await Promise.all(COMPANIONS.map((name) => copyFile(here(name), join(dirname(to), name))));
}

/** copyStandIn, synchronously. */
export function copyStandInSync(to) {
  copyFileSync(STAND_IN, to);
  for (const name of COMPANIONS) copyFileSync(here(name), join(dirname(to), name));
}
