// hold-server-load.mjs's hooks: the load of a module whose URL ends in /dist/server.js waits, polling every 50 ms, until
// the release file exists. No release file named: nothing waits.
import { existsSync } from "node:fs";

let release = "";

export function initialize(data) {
  release = data?.release ?? "";
}

export async function load(url, context, next) {
  if (release !== "" && url.endsWith("/dist/server.js")) while (!existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 50));
  return next(url, context);
}
