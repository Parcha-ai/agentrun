// The box image's recipe: the files it is made of (this folder's Dockerfile and what it copies) and their hash, the
// first 12 hex of their sha256. Every build names what it makes by that hash, so a changed recipe is a new image and the
// same recipe is the one built before: the E2B template agentrun-archil-<hash> (build-e2b.mjs), the Daytona snapshot
// of the same name (build-daytona.py hashes the same files), and the published image ghcr.io/parcha-ai/agentrun-box:<hash>
// (release.yml's box job reads recipeHash()).
//
// And the E2B template's Dockerfile on that published image (build-e2b.mjs --image): E2B's builder provisions a base
// before a template's steps, sudo among what it adds (the Dockerfile says so), so on the image the Dockerfile's sudo
// guard runs again, as root, and its USER and CMD are the template's.
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

/** The Dockerfile's first instruction that pattern matches, its continuation lines kept. */
export function instructionMatching(dockerfile, pattern) {
	const lines = dockerfile.split("\n");
	for (let start = 0; start < lines.length; start++) {
		if (!/^[A-Z]+ /.test(lines[start])) continue;
		let end = start;
		while (lines[end].endsWith("\\") && end + 1 < lines.length) end++;
		const instruction = lines.slice(start, end + 1).join("\n");
		if (pattern.test(instruction)) return instruction;
		start = end;
	}
	throw new Error(`the box Dockerfile has no instruction matching ${pattern}`);
}

/** The template's Dockerfile on the published image: the image, the Dockerfile's sudo guard again, its USER and CMD. */
export function onImage(image, dockerfile = readFileSync(join(here, "Dockerfile"), "utf8")) {
	return [`FROM ${image}`, ...[/^RUN [^]*dpkg -s sudo/, /^USER /, /^CMD /].map((pattern) => instructionMatching(dockerfile, pattern))].join("\n") + "\n";
}
