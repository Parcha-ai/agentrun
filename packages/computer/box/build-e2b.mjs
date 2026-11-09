// Build the Archil image (this folder's Dockerfile) as an E2B template, with the host's own e2b SDK (in this repository,
// the root devDependency the lock pins) and its key in E2B_API_KEY, and print the template's name: an E2B computer with
// an Archil mount names it as its spec's image. The name is the recipe's hash (the Dockerfile and the files it copies),
// so a changed recipe is a new template, and the same recipe is the one built before (E2B's cache). Its size is 2 CPUs
// and 4 GB of memory.
//
//   E2B_API_KEY=... node packages/computer/box/build-e2b.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The host's own SDK, as the E2B provider takes it: by a name that is not a literal, never this package's dependency. */
const E2B_PACKAGE = "e2b";
const { Template } = await import(E2B_PACKAGE).catch(() => {
	console.error(`build-e2b: the ${E2B_PACKAGE} package is not installed: run npm ci at the repository root (it is a root devDependency there), or install ${E2B_PACKAGE} beside this script`);
	process.exit(2);
});

const here = dirname(fileURLToPath(import.meta.url));
/** Every file the image is made of: the Dockerfile and what it copies. */
const RECIPE = ["Dockerfile", "agentrun-archil"];
const recipe = Buffer.concat(RECIPE.map((name) => readFileSync(join(here, name))));
const name = "agentrun-archil-" + createHash("sha256").update(recipe).digest("hex").slice(0, 12);
console.error(`build-e2b: template ${name}`);
const template = Template({ fileContextPath: here }).fromDockerfile(join(here, "Dockerfile"));
await Template.build(template, name, {
	cpuCount: 2,
	memoryMB: 4096,
	onBuildLogs: (entry) => console.error(String(entry?.message ?? entry)),
});
console.log(`template=${name}`);
