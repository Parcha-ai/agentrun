// A test's --import for agentrun-serve's CLI: the load of dist/server.js (the bulk of the server) waits until the file
// AGENTRUN_TEST_RELEASE names exists, as a slow disk makes it wait. The wait runs on the loader's own thread
// (hold-server-hooks.mjs), so the CLI's main thread runs on meanwhile: whatever it does before it has the server, it does
// while the load is held.
import { register } from "node:module";

register(new URL("./hold-server-hooks.mjs", import.meta.url), { data: { release: process.env.AGENTRUN_TEST_RELEASE ?? "" } });
