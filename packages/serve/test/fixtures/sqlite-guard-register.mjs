// `node --import ./test/fixtures/sqlite-guard-register.mjs --test ...`: the serve package's test script (package.json) loads
// this in every test process, so node:sqlite in a test is sqlite-guard.mjs's guarded one (see there).
import { register } from "node:module";

register("./sqlite-guard-hooks.mjs", import.meta.url);
