import { readFile, writeFile } from "node:fs/promises";
import openapiTS from "openapi-typescript";
import { openapiDocument } from "../../../packages/serve/dist/openapi.js";
import { ROUTES } from "../../../packages/serve/dist/server.js";

// The same document GET /v2/openapi.json serves, including native server additions and capability restrictions.
const document = openapiDocument((id) => ROUTES.find((route) => route.name === id)?.capability);
const output = new URL("../src/lib/contract.generated.ts", import.meta.url);
// A TypeScript string index also constrains named properties. JSON Schema's additionalProperties excludes them,
// so include their schemas in the generated index value while keeping each named property's own type.
const forTypes = (value) => {
  if (Array.isArray(value)) return value.map(forTypes);
  if (!value || typeof value !== "object") return value;
  const schema = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, forTypes(entry)]));
  if (schema.type === "object" && schema.properties && schema.additionalProperties && typeof schema.additionalProperties === "object") {
    schema.additionalProperties = { anyOf: [schema.additionalProperties, ...Object.values(schema.properties)] };
  }
  return schema;
};
const generated = await openapiTS(forTypes(document), { alphabetize: true });
const content = `/** Generated from AgentRun Server's /v2/openapi.json by npm run generate:contract. Do not edit. */\n\n${generated}`;
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8").catch(() => "") !== content) throw new Error("The console contract types are stale. Build packages/serve, then run npm run generate:contract in apps/console.");
} else {
  await writeFile(output, content);
}
