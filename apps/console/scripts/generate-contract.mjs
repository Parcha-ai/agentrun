import { readFile, writeFile } from "node:fs/promises";
import openapiTS from "openapi-typescript";
import { openapiDocument } from "../../../packages/serve/dist/openapi.js";
import { ROUTES } from "../../../packages/serve/dist/server.js";

// The same document GET /v2/openapi.json serves, including native server additions and capability restrictions.
const document = openapiDocument((id) => ROUTES.find((route) => route.name === id)?.capability);
const output = new URL("../src/lib/contract.generated.ts", import.meta.url);
const generated = await openapiTS(document, { alphabetize: true });
const content = `/** Generated from AgentRun Server's /v2/openapi.json by npm run generate:contract. Do not edit. */\n\n${generated}`;
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8").catch(() => "") !== content) throw new Error("The console contract types are stale. Build packages/serve, then run npm run generate:contract in apps/console.");
} else {
  await writeFile(output, content);
}
