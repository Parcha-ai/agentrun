// `node --import ./test/fixtures/sqlite-guard-register.mjs --test ...`: the serve package's test script (package.json) loads
// this in every test process, so node:sqlite in a test is sqlite-guard.mjs's guarded one (see there).
// registerHooks runs the hook on this thread, for a test's import and its require alike. module.register ran it on a
// loader thread that every import in the process waited on (loading dist/index.js took about twice as long) and that
// never saw a require.
import { registerHooks } from "node:module";
import { resolve } from "./sqlite-guard-hooks.mjs";

registerHooks({ resolve });
