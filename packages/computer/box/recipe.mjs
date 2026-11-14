// The box image's recipe: the files it is made of (this folder's Dockerfile and what it copies) and their hash, the
// first 12 hex of their sha256. Every build names what it makes by that hash, so a changed recipe is a new image and the
// same recipe is the one built before: the E2B template agentrun-archil-<hash> (build-e2b.mjs), the Daytona snapshot
// of the same name (build-daytona.py hashes the same files), and the published image ghcr.io/parcha-ai/agentrun-box:<hash>
// (release.yml's box job, which runs this file to read it).
//
//   node packages/computer/box/recipe.mjs    prints the hash
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every file the image is made of: the Dockerfile and what it copies. */
export const RECIPE = ["Dockerfile", "agentrun-archil"];

const here = dirname(fileURLToPath(import.meta.url));

/** The recipe's hash, read from dir: 12 hex. */
export function recipeHash(dir = here) {
	const recipe = Buffer.concat(RECIPE.map((name) => readFileSync(join(dir, name))));
	return createHash("sha256").update(recipe).digest("hex").slice(0, 12);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(recipeHash());
