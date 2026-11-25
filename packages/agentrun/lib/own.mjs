// This package's own version and the Node.js it needs, read once from its package.json. A module of its own that imports
// nothing of this package, so any module may import it (start.mjs imports cli.mjs, which imports the rest).
import { readFileSync } from "node:fs";

const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** This package's version. */
export const OWN_VERSION = own.version;
/** The Node.js versions it runs on: package.json's engines.node. */
export const OWN_NODE = own.engines.node;
