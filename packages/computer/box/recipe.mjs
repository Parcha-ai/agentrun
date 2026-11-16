// The box image's recipe: the files it is made of (this folder's Dockerfile and what it copies: install.sh, the build,
// and the helper) and their hash, the first 12 hex of their sha256. Every build names what it makes by that hash, so a
// changed recipe is a new image and the same recipe is the one built before: the E2B template agentrun-archil-<hash>
// (build-e2b.mjs), the Daytona snapshot of the same name (build-daytona.py hashes the same files), the published image
// ghcr.io/parcha-ai/agentrun-box:<hash> (release.yml's box job reads recipeHash()), and what a provider's prepareImage
// builds or registers in a vendor's account.
//
// And the E2B template's Dockerfile on that published image (build-e2b.mjs --image): E2B's builder provisions a base
// before a template's steps, sudo among what it adds (install.sh says so), so on the image install.sh's last step runs
// again, as root, and the Dockerfile's USER and CMD are the template's.
//
// And a vendor's Dockerfile (vendorDockerfile): the box image on the vendor's base, with its agent where the vendor needs
// one, which prepareImage builds and pushes to the account's registry under that file's recipe hash.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every file the image is made of: the Dockerfile and what it copies. */
export const RECIPE = ["Dockerfile", "install.sh", "agentrun-archil"];

const here = dirname(fileURLToPath(import.meta.url));

/** The recipe's hash, read from dir: 12 hex. Given a dockerfile's text, that file is hashed in the box Dockerfile's place. */
export function recipeHash(dir = here, dockerfile = undefined) {
	const read = (name) => (name === "Dockerfile" && dockerfile !== undefined ? Buffer.from(dockerfile) : readFileSync(join(dir, name)));
	return createHash("sha256").update(Buffer.concat(RECIPE.map(read))).digest("hex").slice(0, 12);
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

/** The template's Dockerfile on the published image: the image, install.sh's checked step again, the Dockerfile's USER and CMD. */
export function onImage(image, dockerfile = readFileSync(join(here, "Dockerfile"), "utf8")) {
	const checked = ["COPY install.sh /tmp/agentrun-box/install.sh", "RUN sh /tmp/agentrun-box/install.sh checked && rm -rf /tmp/agentrun-box"];
	return [`FROM ${image}`, ...checked, ...[/^USER /, /^CMD /].map((pattern) => instructionMatching(dockerfile, pattern))].join("\n") + "\n";
}

/**
 * The box image on a vendor's base, for a vendor that pulls a registry image or needs its own agent in the image
 * (spec/computer/provider.md, "prepareImage"): FROM the base, as root; the agent's instructions; the box Dockerfile's
 * COPY and RUN lines, so install.sh's whole build runs once and its checked step comes after the agent; then the start
 * lines. With none given they are the box Dockerfile's CMD; [] keeps what the base starts (Docker keeps a base's
 * ENTRYPOINT and CMD when a file names neither). Its hash is the recipe's with this file in the box Dockerfile's place:
 * the tag prepareImage pushes it under and finds it by.
 */
export function vendorDockerfile(base, { agent = [], start = undefined } = {}, dir = here) {
	const box = readFileSync(join(dir, "Dockerfile"), "utf8");
	const build = [/^COPY install\.sh /, /^COPY agentrun-archil /, /^RUN sh \S*install\.sh /].map((pattern) => instructionMatching(box, pattern));
	const dockerfile = [`FROM ${base}`, "USER root", ...agent, ...build, ...(start ?? [instructionMatching(box, /^CMD /)])].join("\n") + "\n";
	return { dockerfile, hash: recipeHash(dir, dockerfile) };
}
