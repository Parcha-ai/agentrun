// Build the Archil image as an E2B template, with the host's own e2b SDK (in this repository, the root devDependency
// the lock pins) and its key in E2B_API_KEY, and print the template's name: an E2B computer with an Archil mount names it
// as its spec's image. The name is agentrun-archil-<the recipe's hash> (recipe.mjs), so a changed recipe is a new
// template, and the same recipe is the one built before (E2B's cache). Its size is 2 CPUs and 4 GB of memory.
//
//   E2B_API_KEY=... node packages/computer/box/build-e2b.mjs [--image <ref>] [--public]
//
// With no --image it builds this folder's Dockerfile. --image builds from the published box image instead
// (ghcr.io/parcha-ai/agentrun-box:<the recipe's hash>, release.yml's box job), whose tag must be this recipe's hash; on
// it the Dockerfile's sudo guard runs again, and its USER and CMD are the template's (recipe.mjs onImage).
//
// --public makes the template public once it is built (E2B's v2 PATCH /v2/templates/{id}, public: true), so another
// team's sandbox starts from it, and prints the names E2B gives it. release.yml's box-e2b job runs both.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { onImage, recipeHash } from "./recipe.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hash = recipeHash(here);
const name = "agentrun-archil-" + hash;

const { values } = parseArgs({ options: { image: { type: "string" }, public: { type: "boolean", default: false } } });
if (values.image !== undefined && !values.image.endsWith(`:${hash}`)) {
	console.error(`build-e2b: ${values.image} is not this recipe's image: its tag must be the recipe's hash, ${hash}`);
	process.exit(2);
}
if (!process.env.E2B_API_KEY) {
	console.error("build-e2b: set E2B_API_KEY to the key of the E2B team the template is built in");
	process.exit(2);
}
/** The host's own SDK, as the E2B provider takes it: by a name that is not a literal, never this package's dependency. */
const E2B_PACKAGE = "e2b";
const { Template, ApiClient, ConnectionConfig } = await import(E2B_PACKAGE).catch(() => {
	console.error(`build-e2b: the ${E2B_PACKAGE} package is not installed: run npm ci at the repository root (it is a root devDependency there), or install ${E2B_PACKAGE} beside this script`);
	process.exit(2);
});
console.error(`build-e2b: template ${name}${values.image ? ` from ${values.image}` : ""}`);
const template = Template({ fileContextPath: here }).fromDockerfile(values.image ? onImage(values.image) : join(here, "Dockerfile"));
const built = await Template.build(template, name, {
	cpuCount: 2,
	memoryMB: 4096,
	onBuildLogs: (entry) => console.error(String(entry?.message ?? entry)),
});
if (values.public) {
	const client = new ApiClient(new ConnectionConfig({ apiKey: process.env.E2B_API_KEY }));
	const { data, error, response } = await client.api.PATCH("/v2/templates/{templateID}", { params: { path: { templateID: built.templateId } }, body: { public: true } });
	if (error) {
		console.error(`build-e2b: making ${name} public failed: ${response.status} ${error.message ?? JSON.stringify(error)}`);
		process.exit(1);
	}
	console.error(`build-e2b: ${name} is public as ${data.names.join(", ")}`);
	console.log(`public=${data.names.join(",")}`);
}
console.log(`template=${name}`);
